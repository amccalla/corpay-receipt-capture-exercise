/**
 * End-to-end sync tests.
 *
 * A real SyncEngine, a real SessionManager over an in-memory SecretStore, a
 * real InMemoryReceiptStore and a real FakeServer, all wired together with one
 * injected clock. Nothing here reads the wall clock or Math.random: the clock
 * is a value the test moves by hand, and every id the test needs is derived
 * from a seeded stream. Two runs produce byte-identical outcomes.
 *
 * The suite exists to prove the brief's non-negotiables as BEHAVIOUR, not as
 * shape:
 *
 *   - local and remote state are visibly different        (never-confirm-locally)
 *   - retrying an ambiguous submission creates no duplicate receipt or match
 *   - a company switch cannot upload a queued receipt under the wrong company
 *   - permanent rejections stop; transient ones are retried
 *   - a transaction holds at most one receipt
 *
 * HOW A RECEIPT COUNT IS ESTABLISHED
 *
 * The server hands out ids from a strictly increasing counter ('rec_1',
 * 'rec_2', ...). So submitting one throwaway receipt and reading the id it is
 * given tells you exactly how many receipts existed before it — through the
 * public API, with no peeking at internals. That is `countReceipts()`,
 * and it is how "exactly one receipt, no duplicate" is actually proven below.
 */

import { InMemorySecretStore, SessionManager, type Session } from '../../data/session';
import { InMemoryReceiptStore } from '../../data/store';
import { newIdempotencyKey, type RandomSource } from '../../domain/ids';
import {
  EMPTY_PROVENANCE,
  isServerConfirmed,
  type Instant,
  type ReceiptDraft,
  type ReceiptState,
  type Transaction,
} from '../../domain/types';
import { safeStorageKey } from '../../domain/validation';
import {
  FakeServer,
  MAX_UPLOAD_BYTES,
  type ServerErrorCode,
  type SubmitReceiptResponse,
} from '../../server/fake-server';
import { extractFromReceipt, isLowConfidence } from '../../server/ocr';
import { COMPANIES, USERS, seedTransactions } from '../../server/seed';
import { SyncEngine, type SyncOutcome, type SyncSkipReason } from '../sync-engine';

// ---------------------------------------------------------------------------
// Fixtures drawn from the seed, not hardcoded
// ---------------------------------------------------------------------------

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture missing: ${what}`);
  return value;
}

const NORTHWIND = must(
  COMPANIES.find((c) => c.name.startsWith('Northwind')),
  'Northwind company',
).id;

const ACME = must(
  COMPANIES.find((c) => c.name.startsWith('Acme')),
  'Acme company',
).id;

/** Dana is a member of BOTH companies, so switching tenants is legal for her. */
const DANA = must(
  USERS.find((u) => u.email === 'dana@example.com'),
  'dual-company user',
).id;

function northwindTransactions(): Transaction[] {
  return seedTransactions().filter((t) => t.companyId === NORTHWIND);
}

const TXN_A = must(northwindTransactions()[0], 'a northwind transaction').id;
const TXN_B = must(northwindTransactions()[1], 'a second northwind transaction').id;

const HOUR_MS = 60 * 60 * 1000;
const START: Instant = '2026-08-16T09:00:00.000Z';
const JPEG = 'image/jpeg';
const HEIC = 'image/heic';

// ---------------------------------------------------------------------------
// Determinism plumbing
// ---------------------------------------------------------------------------

/**
 * A clock the test owns. `Date.parse` and `Date.prototype.toISOString` are pure
 * functions of their inputs — no ambient clock is read — so this stays
 * deterministic.
 */
function mutableClock(startIso: Instant) {
  let ms = Date.parse(startIso);
  return {
    now: (): Instant => new Date(ms).toISOString(),
    advance: (delta: number): void => {
      ms += delta;
    },
    plus: (delta: number): Instant => new Date(ms + delta).toISOString(),
  };
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seeded LCG standing in for Math.random. Same seed, same key, every run. */
function seededRandom(seed: number): RandomSource {
  let s = (seed === 0 ? 1 : seed) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Stable per draft, so a test can assert a retry reused it. */
function idempotencyKeyFor(localId: string): string {
  return newIdempotencyKey(seededRandom(fnv1a32(localId)));
}

// ---------------------------------------------------------------------------
// Choosing local ids with a known OCR outcome
// ---------------------------------------------------------------------------
//
// The fake server's terminal state is a pure function of the storage key, and
// `safeStorageKey` derives that key from (companyId, localId, mime). So the
// test can choose a localId whose upload is guaranteed to land in 'confirmed'
// (or in 'needsReview') and never has to guess.

const localIdCache = new Map<string, string[]>();

function localIdsWithOcr(companyId: string, mime: string, confident: boolean): string[] {
  const cacheKey = `${companyId}|${mime}|${String(confident)}`;
  const cached = localIdCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const found: string[] = [];
  for (let i = 0; i < 5000 && found.length < 16; i += 1) {
    const candidate = `rcp_${companyId}_${i}`;
    const reading = extractFromReceipt(safeStorageKey(companyId, candidate, mime));
    if (!isLowConfidence(reading) === confident) found.push(candidate);
  }
  if (found.length === 0) {
    throw new Error(`no local id in the search space yields confident=${String(confident)}`);
  }
  localIdCache.set(cacheKey, found);
  return found;
}

/**
 * The `slot`-th local id for this company whose upload has the requested OCR
 * outcome. Slots are independent of test order, so a single test can be run in
 * isolation and still get the same ids.
 */
function localIdFor(companyId: string, opts: { slot: number; confident: boolean; mime: string }): string {
  const list = localIdsWithOcr(companyId, opts.mime, opts.confident);
  return must(list[opts.slot], `local id slot ${opts.slot} for ${companyId}`);
}

// ---------------------------------------------------------------------------
// Narrowing helpers — `expect(o.kind).toBe('advanced')` teaches the compiler nothing
// ---------------------------------------------------------------------------

function expectAdvanced(o: SyncOutcome): { draft: ReceiptDraft; deduped: boolean } {
  if (o.kind !== 'advanced') {
    throw new Error(`expected 'advanced', got ${JSON.stringify(o)}`);
  }
  return { draft: o.draft, deduped: o.deduped };
}

function expectFailed(o: SyncOutcome): {
  draft: ReceiptDraft;
  code: ServerErrorCode;
  retryable: boolean;
} {
  if (o.kind !== 'failed') {
    throw new Error(`expected 'failed', got ${JSON.stringify(o)}`);
  }
  return { draft: o.draft, code: o.code, retryable: o.retryable };
}

function expectSkipped(o: SyncOutcome): { localId: string; reason: SyncSkipReason } {
  if (o.kind !== 'skipped') {
    throw new Error(`expected 'skipped', got ${JSON.stringify(o)}`);
  }
  return { localId: o.localId, reason: o.reason };
}

function expectServerOk(res: SubmitReceiptResponse): { receiptId: string; deduped: boolean; matched: string | null } {
  if (!res.ok) throw new Error(`expected server success, got ${res.code}: ${res.message}`);
  return { receiptId: res.receipt.id, deduped: res.deduped, matched: res.receipt.matchedTransactionId };
}

function expectServerErr(res: SubmitReceiptResponse): { code: ServerErrorCode; retryable: boolean } {
  if (res.ok) throw new Error(`expected server failure, got receipt ${res.receipt.id}`);
  return { code: res.code, retryable: res.retryable };
}

// ---------------------------------------------------------------------------

describe('SyncEngine end to end', () => {
  let clock: ReturnType<typeof mutableClock>;
  let store: InMemoryReceiptStore;
  let secrets: InMemorySecretStore;
  let session: SessionManager;
  let server: FakeServer;
  let engine: SyncEngine;
  let probeSeq: number;

  beforeEach(() => {
    clock = mutableClock(START);
    store = new InMemoryReceiptStore();
    secrets = new InMemorySecretStore();
    session = new SessionManager(secrets);
    server = new FakeServer({ now: clock.now });
    engine = new SyncEngine({ store, session, server, now: clock.now });
    probeSeq = 0;
  });

  // --- wiring helpers ------------------------------------------------------

  function sessionFor(companyId: string, token: string, ttlMs = HOUR_MS): Session {
    return { userId: DANA, companyId, token, expiresAt: clock.plus(ttlMs) };
  }

  /** Mint a server token for a company and sign the device into it. */
  async function signInTo(companyId: string, ttlMs = HOUR_MS): Promise<string> {
    const token = server.issueToken(DANA, companyId, ttlMs);
    await session.signIn(sessionFor(companyId, token, ttlMs));
    return token;
  }

  /** Tenant switch through the real SessionManager — the old token is destroyed. */
  async function switchTo(companyId: string, ttlMs = HOUR_MS): Promise<string> {
    const token = server.issueToken(DANA, companyId, ttlMs);
    await session.switchCompany(sessionFor(companyId, token, ttlMs));
    return token;
  }

  interface DraftOpts {
    readonly slot?: number;
    readonly confident?: boolean;
    readonly state?: ReceiptState;
    readonly mime?: string;
    readonly sizeBytes?: number;
    readonly pendingMatchTransactionId?: string | null;
  }

  /** A draft that is ready to go out: file attached, metadata entered, queued. */
  async function queueDraft(companyId: string, opts: DraftOpts = {}): Promise<ReceiptDraft> {
    const mime = opts.mime ?? JPEG;
    const localId = localIdFor(companyId, {
      slot: opts.slot ?? 0,
      confident: opts.confident ?? true,
      mime,
    });
    const draft: ReceiptDraft = {
      localId,
      companyId,
      fileUri: `file:///sandbox/${localId}`,
      fileName: 'receipt.jpg',
      fileMimeType: mime,
      fileSizeBytes: opts.sizeBytes ?? 250_000,
      // Integer minor units and a date-only value: $42.50 on 2026-08-11.
      vendor: 'Blue Bottle Coffee',
      amountMinorUnits: 4250,
      currency: 'USD',
      transactionDate: '2026-08-11',
      notes: null,
      state: opts.state ?? 'queued',
      idempotencyKey: idempotencyKeyFor(localId),
      serverReceiptId: null,
      matchedTransactionId: null,
      pendingMatchTransactionId: opts.pendingMatchTransactionId ?? null,
      provenance: { ...EMPTY_PROVENANCE, vendor: 'user', amount: 'user', currency: 'user', transactionDate: 'user' },
      lastError: null,
      lastErrorRetryable: false,
      attemptCount: 0,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      lastServerSyncAt: null,
    };
    await store.insert(draft);
    return draft;
  }

  async function mustGet(companyId: string, localId: string): Promise<ReceiptDraft> {
    const d = await store.get(companyId, localId);
    if (d === null) throw new Error(`draft '${localId}' is not visible to company '${companyId}'`);
    return d;
  }

  /**
   * How many receipts the server holds, established through the public API.
   *
   * Submits one throwaway receipt and reads the id it is given: ids come from a
   * strictly increasing counter, so 'rec_4' means three receipts already
   * existed. Earlier probes in the same test are themselves receipts, so they
   * are subtracted — the number returned is real receipts, across all tenants.
   * Requires a healthy server (online, no injection) and a valid token; it
   * throws loudly rather than returning a wrong number.
   */
  async function countReceipts(companyId: string, token: string): Promise<number> {
    const probesAlreadyMade = probeSeq;
    probeSeq += 1;
    const res = await server.submitReceipt({
      idempotencyKey: `probe_${probeSeq}`,
      companyId,
      authToken: token,
      file: { storageKey: `probe/${probeSeq}.jpg`, mime: JPEG, sizeBytes: 1024 },
      metadata: { vendor: null, amountMinorUnits: null, currency: null, transactionDate: null, notes: null },
      matchTransactionId: null,
    });
    const { receiptId } = expectServerOk(res);
    const ordinal = Number(receiptId.slice('rec_'.length));
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new Error(`cannot read a counter out of receipt id '${receiptId}'`);
    }
    return ordinal - 1 - probesAlreadyMade;
  }

  /** Which receipt, if any, currently holds a transaction — server side. */
  async function holderOf(transactionId: string, companyId: string, token: string): Promise<string | null> {
    const txns = await server.listTransactions(companyId, token);
    return must(
      txns.find((t) => t.id === transactionId),
      `transaction ${transactionId}`,
    ).matchedReceiptId;
  }

  // =========================================================================
  // EDGE CASE 1 — the upload succeeds but the success response is lost
  // =========================================================================

  describe('edge case 1: the success response is lost in flight', () => {
    it('reports a retryable failure and claims nothing locally', async () => {
      await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);

      server.setFailureInjection('lostSuccessResponse');
      const outcome = expectFailed(await engine.syncOne(NORTHWIND, draft.localId));

      expect(outcome.code).toBe('TRANSFER_INTERRUPTED');
      expect(outcome.retryable).toBe(true);

      const stored = await mustGet(NORTHWIND, draft.localId);
      expect(stored.state).toBe('failed');
      // The record really does exist server side. We do not know that, and we
      // must not pretend we do.
      expect(stored.serverReceiptId).toBeNull();
      expect(stored.matchedTransactionId).toBeNull();
      expect(isServerConfirmed(stored)).toBe(false);
      expect(stored.lastErrorRetryable).toBe(true);
    });

    it('retrying dedupes onto the original record and creates EXACTLY ONE receipt', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND, { pendingMatchTransactionId: TXN_A });

      server.setFailureInjection('lostSuccessResponse');
      expectFailed(await engine.syncOne(NORTHWIND, draft.localId));

      // The connection comes back. We retry blind — the client still has no
      // idea whether the first attempt committed.
      server.setFailureInjection('none');
      const retry = expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));

      expect(retry.deduped).toBe(true);
      const serverReceiptId = must(retry.draft.serverReceiptId, 'server receipt id after retry');
      expect(isServerConfirmed(retry.draft)).toBe(true);

      // The id names a real record the server will hand back.
      const record = await server.getReceipt(serverReceiptId, NORTHWIND, token);
      expect(must(record, 'server record').id).toBe(serverReceiptId);
      expect(must(record, 'server record').companyId).toBe(NORTHWIND);

      // Replaying the same key AGAIN still resolves to the same record.
      const replay = expectServerOk(
        await server.submitReceipt({
          idempotencyKey: draft.idempotencyKey,
          companyId: NORTHWIND,
          authToken: token,
          file: { storageKey: safeStorageKey(NORTHWIND, draft.localId, JPEG), mime: JPEG, sizeBytes: 250_000 },
          metadata: { vendor: 'Blue Bottle Coffee', amountMinorUnits: 4250, currency: 'USD', transactionDate: '2026-08-11', notes: null },
          matchTransactionId: TXN_A,
        }),
      );
      expect(replay.receiptId).toBe(serverReceiptId);
      expect(replay.deduped).toBe(true);

      // THE assertion: one logical submission, one record. Two attempts and a
      // replay later, the server's counter has moved exactly once.
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('does not create a duplicate MATCH either', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND, { pendingMatchTransactionId: TXN_A });

      server.setFailureInjection('lostSuccessResponse');
      expectFailed(await engine.syncOne(NORTHWIND, draft.localId));
      server.setFailureInjection('none');
      const retry = expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));

      const serverReceiptId = must(retry.draft.serverReceiptId, 'server receipt id');
      expect(retry.draft.matchedTransactionId).toBe(TXN_A);
      // The local intent is satisfied, so it is cleared — we must not re-send a
      // match that already stuck.
      expect(retry.draft.pendingMatchTransactionId).toBeNull();

      // Server side the transaction is held once, by that receipt.
      expect(await holderOf(TXN_A, NORTHWIND, token)).toBe(serverReceiptId);
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('reuses the SAME idempotency key across the retry', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);
      const keyBefore = (await mustGet(NORTHWIND, draft.localId)).idempotencyKey;

      server.setFailureInjection('lostSuccessResponse');
      expectFailed(await engine.syncOne(NORTHWIND, draft.localId));
      const keyAfterFailure = (await mustGet(NORTHWIND, draft.localId)).idempotencyKey;

      server.setFailureInjection('none');
      const retry = expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));

      expect(keyAfterFailure).toBe(keyBefore);
      expect(retry.draft.idempotencyKey).toBe(keyBefore);

      // And the key the SERVER saw is that same key: submitting it by hand
      // dedupes onto the record the engine's retry produced.
      const replay = expectServerOk(
        await server.submitReceipt({
          idempotencyKey: keyBefore,
          companyId: NORTHWIND,
          authToken: token,
          file: { storageKey: safeStorageKey(NORTHWIND, draft.localId, JPEG), mime: JPEG, sizeBytes: 250_000 },
          metadata: { vendor: null, amountMinorUnits: null, currency: null, transactionDate: null, notes: null },
          matchTransactionId: null,
        }),
      );
      expect(replay.deduped).toBe(true);
      expect(replay.receiptId).toBe(retry.draft.serverReceiptId);
    });
  });

  // =========================================================================
  // EDGE CASE 2 — authentication expires while a background upload is running
  // =========================================================================

  describe('edge case 2: authentication expires mid-upload', () => {
    it('does not lose the receipt when the server rejects the in-flight token', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);

      // The token was valid when the upload started and is dead by the time the
      // server reads the header. The client still believes it holds a session.
      server.expireToken(token);
      expect(session.isExpired(clock.now())).toBe(false);

      const outcome = expectFailed(await engine.syncOne(NORTHWIND, draft.localId));
      expect(outcome.code).toBe('AUTH_EXPIRED');
      expect(outcome.retryable).toBe(true);

      const stored = await mustGet(NORTHWIND, draft.localId);
      expect(stored.state).toBe('failed');
      expect(stored.state).not.toBe('confirmed');
      expect(stored.serverReceiptId).toBeNull();
      expect(isServerConfirmed(stored)).toBe(false);
      expect(stored.lastErrorRetryable).toBe(true);
      expect(await store.countPending(NORTHWIND)).toBe(0);

      // Re-authenticate, and the very same draft completes.
      const fresh = await signInTo(NORTHWIND);
      const done = expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));
      expect(isServerConfirmed(done.draft)).toBe(true);
      expect(done.draft.idempotencyKey).toBe(draft.idempotencyKey);
      expect(await countReceipts(NORTHWIND, fresh)).toBe(1);
    });

    it('parks a queued receipt untouched when the LOCAL session has lapsed', async () => {
      await signInTo(NORTHWIND, HOUR_MS);
      const draft = await queueDraft(NORTHWIND);

      // Session outlives nothing: move past its expiry.
      clock.advance(HOUR_MS + 1);
      expect(session.isExpired(clock.now())).toBe(true);

      const skipped = expectSkipped(await engine.syncOne(NORTHWIND, draft.localId));
      expect(skipped.reason).toBe('AUTH_EXPIRED');

      const stored = await mustGet(NORTHWIND, draft.localId);
      // Nothing is wrong with the receipt, so it stays queued work.
      expect(stored.state).toBe('queued');
      expect(stored.serverReceiptId).toBeNull();
      expect(isServerConfirmed(stored)).toBe(false);
      expect(stored.attemptCount).toBe(0);
      expect(await store.countPending(NORTHWIND)).toBe(1);

      const fresh = await signInTo(NORTHWIND);
      expect(await countReceipts(NORTHWIND, fresh)).toBe(0);
    });

    it('stops the whole pass on AUTH_EXPIRED instead of burning every draft', async () => {
      await signInTo(NORTHWIND);
      const a = await queueDraft(NORTHWIND, { slot: 0 });
      const b = await queueDraft(NORTHWIND, { slot: 1 });
      const c = await queueDraft(NORTHWIND, { slot: 2 });

      server.setFailureInjection('authExpired');
      const report = await engine.syncAll(NORTHWIND);

      expect(report.advanced).toBe(0);
      expect(report.attempted).toBe(1); // stopped after the first identical failure
      for (const id of [a.localId, b.localId, c.localId]) {
        const stored = await mustGet(NORTHWIND, id);
        expect(stored.serverReceiptId).toBeNull();
        expect(isServerConfirmed(stored)).toBe(false);
      }

      server.setFailureInjection('none');
      const token = await signInTo(NORTHWIND);
      const recovered = await engine.syncAll(NORTHWIND);
      expect(recovered.advanced).toBe(3);
      expect(recovered.failed).toBe(0);
      expect(await countReceipts(NORTHWIND, token)).toBe(3);
    });
  });

  // =========================================================================
  // EDGE CASE 3 — killed after queueing, relaunched under a different company
  // =========================================================================

  describe('edge case 3: relaunched under a different company', () => {
    it('never uploads company A’s queued receipt during a sync of company B', async () => {
      await signInTo(NORTHWIND);
      const parked = await queueDraft(NORTHWIND);

      // App killed. Relaunch, user picks the other company.
      const acmeToken = await switchTo(ACME);

      // B's pending list must not contain A's work at all.
      const bPending = await store.listByState(ACME, ['queued', 'failed', 'uploading']);
      expect(bPending.map((d) => d.localId)).not.toContain(parked.localId);
      expect(bPending).toHaveLength(0);
      expect(await store.countPending(ACME)).toBe(0);
      expect(await store.countPending(NORTHWIND)).toBe(1);

      const report = await engine.syncAll(ACME);
      expect(report.attempted).toBe(0);
      expect(report.advanced).toBe(0);
      expect(report.outcomes).toHaveLength(0);

      // And the server holds nothing at all — least of all under Acme.
      expect(await countReceipts(ACME, acmeToken)).toBe(0);
      const still = await mustGet(NORTHWIND, parked.localId);
      expect(still.state).toBe('queued');
      expect(still.companyId).toBe(NORTHWIND);
      expect(still.serverReceiptId).toBeNull();
    });

    it('SKIPS a direct syncOne for company A while the session is on company B', async () => {
      await signInTo(NORTHWIND);
      const parked = await queueDraft(NORTHWIND);
      const acmeToken = await switchTo(ACME);

      // Asking for A's draft by name, with A's company id, while signed into B.
      const skipped = expectSkipped(await engine.syncOne(NORTHWIND, parked.localId));
      expect(skipped.reason).toBe('COMPANY_CHANGED');
      expect(skipped.localId).toBe(parked.localId);

      // And asking for it under B's company id cannot even see it.
      const wrongScope = expectSkipped(await engine.syncOne(ACME, parked.localId));
      expect(wrongScope.reason).toBe('COMPANY_CHANGED');

      const stored = await mustGet(NORTHWIND, parked.localId);
      expect(stored.state).toBe('queued');
      expect(stored.attemptCount).toBe(0);
      expect(stored.companyId).toBe(NORTHWIND); // never re-homed
      expect(stored.serverReceiptId).toBeNull();
      expect(await countReceipts(ACME, acmeToken)).toBe(0);
    });

    it('uploads it under its OWN company once the user switches back', async () => {
      await signInTo(NORTHWIND);
      const parked = await queueDraft(NORTHWIND);

      const acmeToken = await switchTo(ACME);
      expectSkipped(await engine.syncOne(NORTHWIND, parked.localId));

      const nwToken = await switchTo(NORTHWIND);
      const done = expectAdvanced(await engine.syncOne(NORTHWIND, parked.localId));

      const serverReceiptId = must(done.draft.serverReceiptId, 'server receipt id');
      expect(done.draft.companyId).toBe(NORTHWIND);
      expect(isServerConfirmed(done.draft)).toBe(true);

      const record = must(await server.getReceipt(serverReceiptId, NORTHWIND, nwToken), 'record');
      expect(record.companyId).toBe(NORTHWIND);
      // Acme cannot see it, which is the whole point of the boundary.
      expect(await server.getReceipt(serverReceiptId, ACME, acmeToken)).toBeNull();
    });

    it('parks a draft that was mid-upload when the app died, then completes it', async () => {
      await signInTo(NORTHWIND);
      // The process was killed with this one in 'uploading'.
      const inFlight = await queueDraft(NORTHWIND, { state: 'uploading' });

      const acmeToken = await switchTo(ACME);
      const skipped = expectSkipped(await engine.syncOne(NORTHWIND, inFlight.localId));
      expect(skipped.reason).toBe('COMPANY_CHANGED');

      const parked = await mustGet(NORTHWIND, inFlight.localId);
      expect(parked.state).toBe('failed');
      expect(parked.lastErrorRetryable).toBe(true);
      expect(must(parked.lastError, 'error message')).toMatch(/different company/i);
      expect(parked.serverReceiptId).toBeNull();
      expect(await countReceipts(ACME, acmeToken)).toBe(0);

      const nwToken = await switchTo(NORTHWIND);
      const done = expectAdvanced(await engine.syncOne(NORTHWIND, inFlight.localId));
      expect(isServerConfirmed(done.draft)).toBe(true);
      expect(await countReceipts(NORTHWIND, nwToken)).toBe(1);
    });

    it('signing out leaves the queue intact and uploads nothing', async () => {
      await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);

      await session.signOut();
      expect(secrets._keys()).toHaveLength(0); // the token is gone from secure storage

      const skipped = expectSkipped(await engine.syncOne(NORTHWIND, draft.localId));
      expect(skipped.reason).toBe('NO_SESSION');

      const stored = await mustGet(NORTHWIND, draft.localId);
      expect(stored.state).toBe('queued');
      expect(stored.serverReceiptId).toBeNull();

      const token = await signInTo(NORTHWIND);
      expect(await countReceipts(NORTHWIND, token)).toBe(0);
    });
  });

  // =========================================================================
  // The company boundary, enforced SERVER side
  // =========================================================================

  describe('company boundary is enforced by the server, not just the client', () => {
    it('rejects a token scoped to A carrying a request that claims B', async () => {
      const nwToken = server.issueToken(DANA, NORTHWIND, HOUR_MS);
      const acmeToken = server.issueToken(DANA, ACME, HOUR_MS);

      const res = await server.submitReceipt({
        idempotencyKey: 'idem_cross_tenant',
        companyId: ACME, // the body says Acme...
        authToken: nwToken, // ...the credential says Northwind
        file: { storageKey: 'blob/cross.jpg', mime: JPEG, sizeBytes: 4096 },
        metadata: { vendor: null, amountMinorUnits: null, currency: null, transactionDate: null, notes: null },
        matchTransactionId: null,
      });

      const err = expectServerErr(res);
      expect(err.code).toBe('COMPANY_MISMATCH');
      // Retrying with the same token can never help, so the client must not.
      expect(err.retryable).toBe(false);

      // Nothing was filed under either company.
      expect(await countReceipts(ACME, acmeToken)).toBe(0);
    });

    it('will not let a replayed key read another tenant’s record', async () => {
      const nwToken = server.issueToken(DANA, NORTHWIND, HOUR_MS);
      const acmeToken = server.issueToken(DANA, ACME, HOUR_MS);

      const original = expectServerOk(
        await server.submitReceipt({
          idempotencyKey: 'idem_shared_key',
          companyId: NORTHWIND,
          authToken: nwToken,
          file: { storageKey: 'blob/original.jpg', mime: JPEG, sizeBytes: 4096 },
          metadata: { vendor: null, amountMinorUnits: null, currency: null, transactionDate: null, notes: null },
          matchTransactionId: null,
        }),
      );

      // Same key, other tenant, valid credential for that tenant.
      const replay = expectServerOk(
        await server.submitReceipt({
          idempotencyKey: 'idem_shared_key',
          companyId: ACME,
          authToken: acmeToken,
          file: { storageKey: 'blob/original.jpg', mime: JPEG, sizeBytes: 4096 },
          metadata: { vendor: null, amountMinorUnits: null, currency: null, transactionDate: null, notes: null },
          matchTransactionId: null,
        }),
      );

      // Idempotency is keyed by (company, key): a different tenant gets its own
      // record, never a window onto somebody else's.
      expect(replay.deduped).toBe(false);
      expect(replay.receiptId).not.toBe(original.receiptId);
      expect(await server.getReceipt(original.receiptId, ACME, acmeToken)).toBeNull();
    });
  });

  // =========================================================================
  // EDGE CASE 4 — a HEIC that is too large or unsupported
  // =========================================================================

  describe('edge case 4: permanent rejections stop, transient ones retry', () => {
    it('marks an oversized file permanently failed and never auto-retries it', async () => {
      const token = await signInTo(NORTHWIND);
      // A real HEIC straight off a phone, over the server's limit. No injection
      // needed: the declared size alone is enough.
      const draft = await queueDraft(NORTHWIND, {
        mime: HEIC,
        sizeBytes: MAX_UPLOAD_BYTES + 1,
      });

      const failed = expectFailed(await engine.syncOne(NORTHWIND, draft.localId));
      expect(failed.code).toBe('FILE_TOO_LARGE');
      expect(failed.retryable).toBe(false);

      const afterFirst = await mustGet(NORTHWIND, draft.localId);
      expect(afterFirst.state).toBe('failed');
      expect(afterFirst.lastErrorRetryable).toBe(false);
      const attempts = afterFirst.attemptCount;
      expect(attempts).toBe(1);

      // Two further passes with a perfectly healthy server. If the engine
      // retried permanent failures, this draft would upload and the count would
      // move.
      const pass1 = await engine.syncAll(NORTHWIND);
      const pass2 = await engine.syncAll(NORTHWIND);
      expect(pass1.advanced).toBe(0);
      expect(pass2.advanced).toBe(0);
      expect(expectSkipped(must(pass1.outcomes[0], 'outcome')).reason).toBe('NOT_SUBMITTABLE');

      const afterPasses = await mustGet(NORTHWIND, draft.localId);
      expect(afterPasses.attemptCount).toBe(attempts);
      expect(afterPasses.state).toBe('failed');
      expect(afterPasses.serverReceiptId).toBeNull();
      expect(await countReceipts(NORTHWIND, token)).toBe(0);
    });

    it('marks an unsupported type permanently failed and never auto-retries it', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND, { mime: HEIC });

      // This deployment will not take HEIC at all.
      server.setFailureInjection('unsupportedType');
      const failed = expectFailed(await engine.syncOne(NORTHWIND, draft.localId));
      expect(failed.code).toBe('UNSUPPORTED_TYPE');
      expect(failed.retryable).toBe(false);

      const attempts = (await mustGet(NORTHWIND, draft.localId)).attemptCount;
      expect(attempts).toBe(1);

      // Even with the deployment fixed, the engine leaves it to the user.
      server.setFailureInjection('none');
      await engine.syncAll(NORTHWIND);
      await engine.syncAll(NORTHWIND);

      const after = await mustGet(NORTHWIND, draft.localId);
      expect(after.attemptCount).toBe(attempts);
      expect(after.state).toBe('failed');
      expect(after.lastErrorRetryable).toBe(false);
      expect(after.serverReceiptId).toBeNull();
      expect(await countReceipts(NORTHWIND, token)).toBe(0);
    });

    it('DOES retry an interrupted transfer, and still creates only one receipt', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);

      server.setFailureInjection('transferInterrupted');
      const first = expectFailed(must((await engine.syncAll(NORTHWIND)).outcomes[0], 'outcome'));
      expect(first.code).toBe('TRANSFER_INTERRUPTED');
      expect(first.retryable).toBe(true);
      expect((await mustGet(NORTHWIND, draft.localId)).attemptCount).toBe(1);

      await engine.syncAll(NORTHWIND);
      expect((await mustGet(NORTHWIND, draft.localId)).attemptCount).toBe(2);

      server.setFailureInjection('none');
      const done = expectAdvanced(must((await engine.syncAll(NORTHWIND)).outcomes[0], 'outcome'));
      expect(isServerConfirmed(done.draft)).toBe(true);
      expect((await mustGet(NORTHWIND, draft.localId)).attemptCount).toBe(3);

      // Three attempts, one record.
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('DOES retry a server error', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);

      server.setFailureInjection('serverError');
      const failed = expectFailed(await engine.syncOne(NORTHWIND, draft.localId));
      expect(failed.code).toBe('SERVER_ERROR');
      expect(failed.retryable).toBe(true);
      expect((await mustGet(NORTHWIND, draft.localId)).lastErrorRetryable).toBe(true);

      await engine.syncAll(NORTHWIND);
      expect((await mustGet(NORTHWIND, draft.localId)).attemptCount).toBe(2);

      server.setFailureInjection('none');
      const report = await engine.syncAll(NORTHWIND);
      expect(report.advanced).toBe(1);
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('a permanent failure does not block the rest of the queue', async () => {
      const token = await signInTo(NORTHWIND);
      const bad = await queueDraft(NORTHWIND, { slot: 0, mime: HEIC, sizeBytes: MAX_UPLOAD_BYTES + 1 });
      const good = await queueDraft(NORTHWIND, { slot: 1 });

      const report = await engine.syncAll(NORTHWIND);
      expect(report.advanced).toBe(1);
      expect(report.failed).toBe(1);

      expect((await mustGet(NORTHWIND, bad.localId)).serverReceiptId).toBeNull();
      expect(isServerConfirmed(await mustGet(NORTHWIND, good.localId))).toBe(true);
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });
  });

  // =========================================================================
  // EDGE CASE 6 — two receipts matched to the same card transaction
  // =========================================================================

  describe('edge case 6: two receipts, one transaction', () => {
    it('rejects the second claim permanently and leaves the first match standing', async () => {
      const token = await signInTo(NORTHWIND);
      const first = await queueDraft(NORTHWIND, { slot: 0, pendingMatchTransactionId: TXN_A });
      const second = await queueDraft(NORTHWIND, { slot: 1, pendingMatchTransactionId: TXN_A });

      const firstOutcome = expectAdvanced(await engine.syncOne(NORTHWIND, first.localId));
      const firstReceiptId = must(firstOutcome.draft.serverReceiptId, 'first receipt id');
      expect(firstOutcome.draft.matchedTransactionId).toBe(TXN_A);

      const secondOutcome = expectFailed(await engine.syncOne(NORTHWIND, second.localId));
      expect(secondOutcome.code).toBe('TRANSACTION_ALREADY_MATCHED');
      expect(secondOutcome.retryable).toBe(false);

      // The loser keeps its intent but gains nothing.
      const storedSecond = await mustGet(NORTHWIND, second.localId);
      expect(storedSecond.state).toBe('failed');
      expect(storedSecond.serverReceiptId).toBeNull();
      expect(storedSecond.matchedTransactionId).toBeNull();
      expect(storedSecond.pendingMatchTransactionId).toBe(TXN_A);
      expect(storedSecond.lastErrorRetryable).toBe(false);

      // The winner still holds it, locally and server side.
      const storedFirst = await mustGet(NORTHWIND, first.localId);
      expect(storedFirst.matchedTransactionId).toBe(TXN_A);
      expect(await holderOf(TXN_A, NORTHWIND, token)).toBe(firstReceiptId);

      // A rejected match leaves no orphan receipt behind.
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('does not auto-retry the losing claim', async () => {
      const token = await signInTo(NORTHWIND);
      const first = await queueDraft(NORTHWIND, { slot: 0, pendingMatchTransactionId: TXN_A });
      const second = await queueDraft(NORTHWIND, { slot: 1, pendingMatchTransactionId: TXN_A });

      expectAdvanced(await engine.syncOne(NORTHWIND, first.localId));
      expectFailed(await engine.syncOne(NORTHWIND, second.localId));
      const attempts = (await mustGet(NORTHWIND, second.localId)).attemptCount;

      await engine.syncAll(NORTHWIND);
      await engine.syncAll(NORTHWIND);

      expect((await mustGet(NORTHWIND, second.localId)).attemptCount).toBe(attempts);
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('lets the loser succeed once the user picks a different transaction', async () => {
      const token = await signInTo(NORTHWIND);
      const first = await queueDraft(NORTHWIND, { slot: 0, pendingMatchTransactionId: TXN_A });
      const second = await queueDraft(NORTHWIND, { slot: 1, pendingMatchTransactionId: TXN_A });

      const firstOutcome = expectAdvanced(await engine.syncOne(NORTHWIND, first.localId));
      expectFailed(await engine.syncOne(NORTHWIND, second.localId));

      // The user re-points it at the other transaction and retries.
      const repointed = await mustGet(NORTHWIND, second.localId);
      await store.update(NORTHWIND, {
        ...repointed,
        pendingMatchTransactionId: TXN_B,
        lastErrorRetryable: true,
      });

      const done = expectAdvanced(await engine.syncOne(NORTHWIND, second.localId));
      expect(done.draft.matchedTransactionId).toBe(TXN_B);
      expect(await holderOf(TXN_B, NORTHWIND, token)).toBe(done.draft.serverReceiptId);
      expect(await holderOf(TXN_A, NORTHWIND, token)).toBe(firstOutcome.draft.serverReceiptId);
      expect(await countReceipts(NORTHWIND, token)).toBe(2);
    });

    it('re-submitting the SAME receipt against the SAME transaction is idempotent, not a conflict', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND, { pendingMatchTransactionId: TXN_A });

      const done = expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));
      const receiptId = must(done.draft.serverReceiptId, 'receipt id');

      // The same logical submission arrives again — a replay from a background
      // task that never heard the answer. A receipt re-asserting its own match
      // is not a conflict.
      const replay = await server.submitReceipt({
        idempotencyKey: draft.idempotencyKey,
        companyId: NORTHWIND,
        authToken: token,
        file: { storageKey: safeStorageKey(NORTHWIND, draft.localId, JPEG), mime: JPEG, sizeBytes: 250_000 },
        metadata: { vendor: 'Blue Bottle Coffee', amountMinorUnits: 4250, currency: 'USD', transactionDate: '2026-08-11', notes: null },
        matchTransactionId: TXN_A,
      });

      const ok = expectServerOk(replay);
      expect(ok.receiptId).toBe(receiptId);
      expect(ok.deduped).toBe(true);
      expect(ok.matched).toBe(TXN_A);
      expect(await holderOf(TXN_A, NORTHWIND, token)).toBe(receiptId);
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });
  });

  // =========================================================================
  // Local state is never mistaken for remote state
  // =========================================================================

  describe('never confirm locally', () => {
    it('a queued receipt that never reached a server is not confirmed', async () => {
      const draft = await queueDraft(NORTHWIND);
      const stored = await mustGet(NORTHWIND, draft.localId);

      expect(stored.state).toBe('queued');
      expect(stored.serverReceiptId).toBeNull();
      expect(isServerConfirmed(stored)).toBe(false);
      expect(stored.lastServerSyncAt).toBeNull();
      expect(await store.countPending(NORTHWIND)).toBe(1);
    });

    it('a full offline syncAll produces no confirmed draft and no server record', async () => {
      await signInTo(NORTHWIND);
      const drafts = [
        await queueDraft(NORTHWIND, { slot: 0 }),
        await queueDraft(NORTHWIND, { slot: 1 }),
        await queueDraft(NORTHWIND, { slot: 2 }),
      ];

      server.setNetworkMode('offline');
      const report = await engine.syncAll(NORTHWIND);

      expect(report.attempted).toBe(3);
      expect(report.advanced).toBe(0);
      for (const outcome of report.outcomes) {
        expect(outcome.kind).not.toBe('advanced');
        const failure = expectFailed(outcome);
        expect(failure.code).toBe('NETWORK_OFFLINE');
        expect(failure.retryable).toBe(true);
      }

      for (const d of await store.list(NORTHWIND)) {
        expect(d.state).not.toBe('confirmed');
        expect(d.state).not.toBe('needsReview');
        expect(d.state).not.toBe('processing');
        expect(d.serverReceiptId).toBeNull();
        expect(d.matchedTransactionId).toBeNull();
        expect(isServerConfirmed(d)).toBe(false);
        expect(d.lastServerSyncAt).toBeNull();
      }

      // Back online, the same drafts confirm — and exactly three records exist,
      // so the offline attempts really did create nothing.
      server.setNetworkMode('online');
      const recovered = await engine.syncAll(NORTHWIND);
      expect(recovered.advanced).toBe(3);

      const token = await signInTo(NORTHWIND);
      for (const d of drafts) {
        const stored = await mustGet(NORTHWIND, d.localId);
        expect(isServerConfirmed(stored)).toBe(true);
        expect(must(stored.lastServerSyncAt, 'sync instant')).toBe(clock.now());
      }
      expect(await countReceipts(NORTHWIND, token)).toBe(3);
    });

    it('an uncertain reading carries a server id but is still NOT confirmed', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND, { confident: false });

      const done = expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));
      expect(done.draft.state).toBe('needsReview');
      // The server DID create a record — local and remote state are different
      // things, and the UI must be able to tell them apart.
      expect(done.draft.serverReceiptId).not.toBeNull();
      expect(isServerConfirmed(done.draft)).toBe(false);
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });

    it('refuses to upload a draft with no file rather than inventing a success', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);
      await store.update(NORTHWIND, { ...draft, fileUri: null });

      const skipped = expectSkipped(await engine.syncOne(NORTHWIND, draft.localId));
      expect(skipped.reason).toBe('MISSING_FILE');
      expect((await mustGet(NORTHWIND, draft.localId)).serverReceiptId).toBeNull();
      expect(await countReceipts(NORTHWIND, token)).toBe(0);
    });

    it('will not re-upload an already confirmed draft', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);
      expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));

      const again = expectSkipped(await engine.syncOne(NORTHWIND, draft.localId));
      expect(again.reason).toBe('NOT_SUBMITTABLE');
      expect(await countReceipts(NORTHWIND, token)).toBe(1);
    });
  });

  // =========================================================================
  // Secrets
  // =========================================================================

  describe('tokens never reach ordinary app storage', () => {
    it('keeps the token out of the draft store and drops it on switch', async () => {
      const token = await signInTo(NORTHWIND);
      const draft = await queueDraft(NORTHWIND);
      expectAdvanced(await engine.syncOne(NORTHWIND, draft.localId));

      const serialisedDrafts = JSON.stringify(await store.list(NORTHWIND));
      expect(serialisedDrafts).not.toContain(token);

      const publicSession = must(session.getPublicSession(), 'public session');
      expect(JSON.stringify(publicSession)).not.toContain(token);

      await switchTo(ACME);
      expect(session.getTokenForCompany(NORTHWIND, clock.now())).toBeNull();
    });
  });
});
