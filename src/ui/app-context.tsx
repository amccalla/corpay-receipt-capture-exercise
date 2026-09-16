/**
 * Application wiring.
 *
 * Holds the single instances of the store, session, fake server and sync
 * engine, and exposes them to the screens. Deliberately a plain context with
 * explicit actions rather than a state library: the interesting behaviour in
 * this exercise lives in the domain and sync layers, and a thin UI layer keeps
 * it that way.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { newIdempotencyKey, newLocalId, shouldRotateIdempotencyKey, type SubmissionIntent } from '../domain/ids';
import { applyLocalEvent } from '../domain/state-machine';
import { EMPTY_PROVENANCE, type Company, type Instant, type ReceiptDraft, type Transaction, type User } from '../domain/types';
import { openDatabase } from '../data/db';
import { ExpoSecretStore, InMemorySecretStore, SessionManager, type PublicSession } from '../data/session';
import { SQLiteReceiptStore } from '../data/sqlite-store';
import { InMemoryReceiptStore, type ReceiptStore } from '../data/store';
import { FakeServer, type FailureInjection, type NetworkMode } from '../server/fake-server';
import { COMPANIES, MEMBERSHIPS, USERS } from '../server/seed';
import { configureNotifications, notifyOnChange, requestNotificationPermission } from '../notify/notifier';
import { SyncEngine, type SyncOutcome, type SyncReport } from '../sync/sync-engine';

/** Real wall clock. The engine and server take this as a dependency so tests can replace it. */
const nowIso = (): Instant => new Date().toISOString();

const SESSION_TTL_MS = 15 * 60 * 1000;

/** Notification copy names the company, since a user here has more than one. */
function companyNameFor(id: string): string {
  return COMPANIES.find((c) => c.id === id)?.name ?? id;
}

export interface AppState {
  ready: boolean;
  /** Non-null once the DB is open; null while booting or if persistence failed. */
  bootError: string | null;
  /** True when drafts live only in memory (web preview) — surfaced in the UI, never hidden. */
  ephemeralStorage: boolean;
  session: PublicSession | null;
  company: Company | null;
  companies: Company[];
  users: User[];
  /** The signed-in user, or null. Distinct from the company they are acting for. */
  user: User | null;
  drafts: ReceiptDraft[];
  transactions: Transaction[];
  networkMode: NetworkMode;
  failureInjection: FailureInjection;
  syncing: boolean;
}

export interface AppActions {
  signIn(userId: string, companyId: string): Promise<void>;
  switchCompany(companyId: string): Promise<void>;
  /** Client-side mirror of the server's rule, used only to explain the UI. */
  isMember(userId: string, companyId: string): boolean;
  signOut(): Promise<void>;
  expireSession(): void;
  setNetworkMode(m: NetworkMode): void;
  setFailureInjection(f: FailureInjection): void;
  createDraft(): Promise<ReceiptDraft | null>;
  patchDraft(localId: string, patch: Partial<ReceiptDraft>): Promise<void>;
  submitDraft(localId: string): Promise<SyncOutcome | null>;
  syncNow(): Promise<SyncReport | null>;
  refresh(): Promise<void>;
  getDraft(localId: string): ReceiptDraft | undefined;
}

type AppContextValue = AppState & { actions: AppActions };

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ReceiptStore | null>(null);
  const sessionRef = useRef<SessionManager | null>(null);
  const serverRef = useRef<FakeServer | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);

  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [ephemeralStorage, setEphemeralStorage] = useState(false);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [drafts, setDrafts] = useState<ReceiptDraft[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [networkMode, setNetworkModeState] = useState<NetworkMode>('online');
  const [failureInjection, setFailureInjectionState] = useState<FailureInjection>('none');
  const [syncing, setSyncing] = useState(false);

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      let store: ReceiptStore;
      let ephemeral = false;
      try {
        const db = await openDatabase();
        store = new SQLiteReceiptStore(db);
      } catch (err) {
        // Web preview has no native SQLite. Rather than pretend, fall back to
        // memory AND tell the user their drafts will not survive a reload —
        // silently degrading durability would undermine the entire point of
        // the exercise.
        store = new InMemoryReceiptStore();
        ephemeral = true;
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;

      const secrets = ephemeral ? new InMemorySecretStore() : new ExpoSecretStore();
      const session = new SessionManager(secrets);
      // The server seeds its own companies and transactions on construction.
      const server = new FakeServer({ now: nowIso });

      storeRef.current = store;
      sessionRef.current = session;
      serverRef.current = server;
      engineRef.current = new SyncEngine({ store, session, server, now: nowIso });

      session.subscribe(setSession);
      await session.restore();

      // Presentation rules only; no permission is requested here. See notifier.ts
      // for why the prompt is deferred until the user has queued something.
      await configureNotifications();

      setEphemeralStorage(ephemeral);
      setReady(true);
    })().catch((err: unknown) => {
      if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
    });

    return () => { cancelled = true; };
  }, []);

  const companyId = session?.companyId ?? null;

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    const server = serverRef.current;
    const session = sessionRef.current;
    if (!store || !server || !session || !companyId) {
      setDrafts([]);
      setTransactions([]);
      return;
    }

    setDrafts(await store.list(companyId));

    // Fetched through the authenticated endpoint rather than a back door, so an
    // expired or wrong-company token produces an empty list here exactly as it
    // would against a real backend.
    const token = session.getTokenForCompany(companyId, nowIso());
    if (!token) {
      setTransactions([]);
      return;
    }
    try {
      setTransactions(await server.listTransactions(companyId, token));
    } catch {
      setTransactions([]);
    }
  }, [companyId]);

  // Re-read whenever the active company changes. This is what makes a company
  // switch visibly swap the entire dataset rather than leaking rows across.
  useEffect(() => { void refresh(); }, [refresh]);

  // ---- actions ------------------------------------------------------------

  const signIn = useCallback(async (userId: string, nextCompanyId: string) => {
    const session = sessionRef.current;
    const server = serverRef.current;
    if (!session || !server) return;
    // No client-side pre-check: the server decides, and a refusal surfaces as a
    // thrown FakeServerError that the caller renders. Guarding here instead
    // would make the button the authority, which is exactly backwards.
    const token = server.issueToken(userId, nextCompanyId, SESSION_TTL_MS);
    await session.signIn({
      userId,
      companyId: nextCompanyId,
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
  }, []);

  const switchCompany = useCallback(async (nextCompanyId: string) => {
    const session = sessionRef.current;
    const server = serverRef.current;
    if (!session || !server) return;
    const current = session.getPublicSession();
    const userId = current?.userId ?? USERS[0].id;
    // Throws NOT_A_MEMBER if this user cannot act for that company - the switch
    // is refused by the server, not hidden by the client.
    const token = server.issueToken(userId, nextCompanyId, SESSION_TTL_MS);
    // switchCompany destroys the old token before installing the new one, so
    // there is never a moment when both tenants' credentials are live.
    await session.switchCompany({
      userId,
      companyId: nextCompanyId,
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
  }, []);

  const signOut = useCallback(async () => {
    await sessionRef.current?.signOut();
  }, []);

  /** Demo affordance: force the auth-expiry edge case on the next upload. */
  const expireSession = useCallback(() => {
    const session = sessionRef.current;
    const server = serverRef.current;
    const current = session?.getPublicSession();
    if (!session || !server || !current) return;
    // Revoke the actual token this client is holding. The local session object
    // stays in place on purpose: that is what makes the next upload fail with
    // AUTH_EXPIRED mid-flight, which is the edge case we want to demonstrate.
    const token = session.getTokenForCompany(current.companyId, nowIso());
    if (token) server.expireToken(token);
  }, []);

  const setNetworkMode = useCallback((m: NetworkMode) => {
    serverRef.current?.setNetworkMode(m);
    setNetworkModeState(m);
  }, []);

  const setFailureInjection = useCallback((f: FailureInjection) => {
    serverRef.current?.setFailureInjection(f);
    setFailureInjectionState(f);
  }, []);

  const createDraft = useCallback(async (): Promise<ReceiptDraft | null> => {
    const store = storeRef.current;
    if (!store || !companyId) return null;
    const at = nowIso();
    const draft: ReceiptDraft = {
      localId: newLocalId(Math.random),
      // Stamped at capture time and never rewritten — a draft belongs to the
      // company it was created under, whatever happens to the session later.
      companyId,
      fileUri: null, fileName: null, fileMimeType: null, fileSizeBytes: null,
      vendor: null, amountMinorUnits: null, currency: 'USD', transactionDate: null, notes: null,
      state: 'draft',
      idempotencyKey: newIdempotencyKey(Math.random),
      serverReceiptId: null,
      matchedTransactionId: null,
      pendingMatchTransactionId: null,
      provenance: EMPTY_PROVENANCE,
      lastError: null, lastErrorRetryable: false, attemptCount: 0,
      createdAt: at, updatedAt: at, lastServerSyncAt: null,
    };
    await store.insert(draft);
    await refresh();
    return draft;
  }, [companyId, refresh]);

  const intentOf = (d: ReceiptDraft): SubmissionIntent => ({
    fileUri: d.fileUri,
    vendor: d.vendor,
    amountMinorUnits: d.amountMinorUnits,
    currency: d.currency,
    transactionDate: d.transactionDate,
    matchTransactionId: d.pendingMatchTransactionId,
  });

  const patchDraft = useCallback(async (localId: string, patch: Partial<ReceiptDraft>) => {
    const store = storeRef.current;
    if (!store || !companyId) return;
    const existing = await store.get(companyId, localId);
    if (!existing) return;

    const next: ReceiptDraft = { ...existing, ...patch, updatedAt: nowIso() };

    // If the SUBSTANCE of the submission changed, this is a different thing to
    // submit and needs a new idempotency key — otherwise the server would
    // dedupe the correction against the original record and silently drop it.
    const rotated = shouldRotateIdempotencyKey(intentOf(existing), intentOf(next))
      ? { ...next, idempotencyKey: newIdempotencyKey(Math.random) }
      : next;

    await store.update(companyId, rotated);
    await refresh();
  }, [companyId, refresh]);

  const submitDraft = useCallback(async (localId: string): Promise<SyncOutcome | null> => {
    const store = storeRef.current;
    const engine = engineRef.current;
    if (!store || !engine || !companyId) return null;

    const draft = await store.get(companyId, localId);
    if (!draft) return null;

    // Offline submit parks the receipt durably; online goes straight out.
    // Either way the user's work is saved before any network is attempted.
    if (networkMode === 'offline') {
      const queued = applyLocalEvent(draft, 'submitOffline', nowIso());
      await store.update(companyId, queued);
      // Asked here, not at launch: the user has just parked something they will
      // want to hear about. A denial on iOS is effectively permanent, so the
      // single prompt is spent where it can be understood.
      void requestNotificationPermission();
      await refresh();
      return { kind: 'skipped', localId, reason: 'NO_SESSION' };
    }

    if (draft.state === 'draft') {
      await store.update(companyId, applyLocalEvent(draft, 'submitOffline', nowIso()));
    }

    setSyncing(true);
    try {
      const outcome = await engine.syncOne(companyId, localId);
      // The policy decides whether this transition is worth a notification;
      // this layer only supplies the before and after.
      if (outcome.kind === 'advanced' || outcome.kind === 'failed') {
        await notifyOnChange(draft, outcome.draft, companyNameFor(companyId));
      }
      await refresh();
      return outcome;
    } finally {
      setSyncing(false);
    }
  }, [companyId, networkMode, refresh]);

  const syncNow = useCallback(async (): Promise<SyncReport | null> => {
    const engine = engineRef.current;
    const store = storeRef.current;
    if (!engine || !store || !companyId) return null;
    setSyncing(true);
    try {
      // Snapshot first: planNotification needs the prior state of each draft to
      // tell a genuine transition from a no-op.
      const before = new Map((await store.list(companyId)).map((d) => [d.localId, d]));
      const report = await engine.syncAll(companyId);

      for (const outcome of report.outcomes) {
        if (outcome.kind !== 'advanced' && outcome.kind !== 'failed') continue;
        const prev = before.get(outcome.draft.localId);
        if (prev) await notifyOnChange(prev, outcome.draft, companyNameFor(companyId));
      }

      await refresh();
      return report;
    } finally {
      setSyncing(false);
    }
  }, [companyId, refresh]);

  const getDraft = useCallback((localId: string) => drafts.find((d) => d.localId === localId), [drafts]);

  const company = useMemo(
    () => COMPANIES.find((c) => c.id === companyId) ?? null,
    [companyId],
  );

  const user = useMemo(
    () => USERS.find((u) => u.id === session?.userId) ?? null,
    [session?.userId],
  );

  const isMember = useCallback(
    (userId: string, cid: string) => MEMBERSHIPS.some((m) => m.userId === userId && m.companyId === cid),
    [],
  );

  const value: AppContextValue = {
    ready, bootError, ephemeralStorage, session, company, companies: COMPANIES,
    users: USERS, user,
    drafts, transactions, networkMode, failureInjection, syncing,
    actions: {
      signIn, switchCompany, signOut, expireSession, setNetworkMode, setFailureInjection, isMember,
      createDraft, patchDraft, submitDraft, syncNow, refresh, getDraft,
    },
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
