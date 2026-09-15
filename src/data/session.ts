/**
 * Session and tenancy.
 *
 * Two of the brief's non-negotiables meet in this file:
 *
 *   "Tokens/secrets are not stored in ordinary plaintext app storage."
 *       -> the auth token goes to expo-secure-store (iOS Keychain / Android
 *          Keystore), NEVER to SQLite or AsyncStorage. The non-secret parts of
 *          the session (which company is active) are fine in ordinary storage,
 *          and are kept separate so it is obvious which is which.
 *
 *   "Company switch/logout cannot upload a queued receipt under the wrong company."
 *       -> switching company or signing out DESTROYS the current token before
 *          anything else can run. A sync pass that was mid-flight finds no
 *          valid token for the old company and cannot complete under the new one.
 */

import { isValidInstant } from '../domain/dates';
import type { Instant } from '../domain/types';

/**
 * The secret-storage boundary, injectable so tests never touch the Keychain.
 * Deliberately tiny: anything with a richer API is probably not a secret store.
 */
export interface SecretStore {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  deleteItem(key: string): Promise<void>;
}

/** expo-secure-store backing. Values land in the Keychain/Keystore. */
export class ExpoSecretStore implements SecretStore {
  async setItem(key: string, value: string): Promise<void> {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(key, value, {
      // Secrets are unavailable until the user has unlocked the device once
      // since boot, and never leave this device via an iCloud/backup restore.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async getItem(key: string): Promise<string | null> {
    const SecureStore = await import('expo-secure-store');
    return SecureStore.getItemAsync(key);
  }

  async deleteItem(key: string): Promise<void> {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.deleteItemAsync(key);
  }
}

/** Test double. Also used on web, where SecureStore has no secure backing. */
export class InMemorySecretStore implements SecretStore {
  private map = new Map<string, string>();
  async setItem(k: string, v: string) { this.map.set(k, v); }
  async getItem(k: string) { return this.map.get(k) ?? null; }
  async deleteItem(k: string) { this.map.delete(k); }
  /** Test helper: prove a sign-out actually wiped the secret. */
  _keys(): string[] { return [...this.map.keys()]; }
}

const TOKEN_KEY = 'receipt_capture.auth_token';

export interface Session {
  readonly userId: string;
  readonly companyId: string;
  readonly token: string;
  readonly expiresAt: Instant;
}

/** What the UI is allowed to see. Note the absence of the token. */
export interface PublicSession {
  readonly userId: string;
  readonly companyId: string;
  readonly expiresAt: Instant;
  readonly expired: boolean;
}

export type SessionListener = (s: PublicSession | null) => void;

export class SessionManager {
  private session: Session | null = null;
  private listeners = new Set<SessionListener>();

  /**
   * `now` is injected so expiry is decidable without reaching for a global
   * clock, and so tests can move time deterministically. It defaults to the
   * real wall clock for app use.
   */
  constructor(
    private readonly secrets: SecretStore,
    private readonly now: () => Instant = () => new Date().toISOString(),
  ) {}

  subscribe(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    const pub = this.session ? this.toPublic(this.session) : null;
    for (const fn of this.listeners) fn(pub);
  }

  /**
   * `expired` is always computed against a real instant. It previously
   * defaulted to `false` whenever no `now` was passed, which meant every
   * payload emit() pushed to a subscriber claimed the session was live - even
   * one that had expired years earlier. A status field that cannot report the
   * bad case is worse than no status field.
   */
  private toPublic(s: Session, now: Instant = this.now()): PublicSession {
    return {
      userId: s.userId,
      companyId: s.companyId,
      expiresAt: s.expiresAt,
      expired: s.expiresAt <= now,
    };
  }

  async signIn(session: Session): Promise<void> {
    // The token is the only part that goes to secure storage.
    await this.secrets.setItem(TOKEN_KEY, JSON.stringify(session));
    this.session = session;
    this.emit();
  }

  /** Rehydrate on cold start. Returns null if nothing was stored. */
  async restore(): Promise<PublicSession | null> {
    const raw = await this.secrets.getItem(TOKEN_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Session;
      // `expiresAt` is validated as strictly as the token itself. Omitting it
      // produced an IMMORTAL session: `undefined <= now` is false, so the
      // session never expired and getTokenForCompany() handed the token out
      // forever. A blob that parses is not a blob that is usable.
      if (
        !parsed?.token ||
        !parsed.companyId ||
        !parsed.userId ||
        typeof parsed.expiresAt !== 'string' ||
        !isValidInstant(parsed.expiresAt)
      ) {
        // Parsed, but unusable: a partial write, a value from an older schema, or
        // a hand-edited blob. It can never produce a session, and it may still
        // contain a real bearer token, so it is destroyed rather than left in the
        // Keychain forever where nothing would ever clean it up.
        await this.secrets.deleteItem(TOKEN_KEY);
        return null;
      }
      this.session = parsed;
      this.emit();
      return this.toPublic(parsed);
    } catch {
      // A corrupt blob is treated as no session rather than a crash loop.
      await this.secrets.deleteItem(TOKEN_KEY);
      return null;
    }
  }

  getCompanyId(): string | null {
    return this.session?.companyId ?? null;
  }

  getPublicSession(now?: Instant): PublicSession | null {
    return this.session ? this.toPublic(this.session, now) : null;
  }

  isExpired(now: Instant): boolean {
    return this.session === null || this.session.expiresAt <= now;
  }

  /**
   * The token, but ONLY if the caller names the company it believes it is
   * acting for. A sync pass that started under company A cannot obtain a token
   * after the user switched to company B — it gets null and must abort.
   * This is the client-side half of the company-boundary invariant; the server
   * independently enforces the same rule and does not trust this one.
   */
  getTokenForCompany(companyId: string, now: Instant): string | null {
    if (!this.session) return null;
    if (this.session.companyId !== companyId) return null;
    if (this.session.expiresAt <= now) return null;
    return this.session.token;
  }

  /**
   * Switch tenants. The old token is destroyed FIRST, so there is no window in
   * which both companies' credentials are live.
   */
  async switchCompany(next: Session): Promise<void> {
    await this.secrets.deleteItem(TOKEN_KEY);
    this.session = null;
    this.emit();
    await this.signIn(next);
  }

  async signOut(): Promise<void> {
    await this.secrets.deleteItem(TOKEN_KEY);
    this.session = null;
    this.emit();
  }
}
