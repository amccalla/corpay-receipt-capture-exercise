/**
 * Persistence and tenancy.
 *
 * `InMemoryReceiptStore` and `SessionManager` jointly own the brief's
 * non-negotiable that "company switch/logout cannot upload a queued receipt
 * under the wrong company", plus "tokens/secrets are not stored in ordinary
 * plaintext app storage".
 *
 * These tests treat both claims as STRUCTURAL rather than advisory: a caller
 * holding the wrong company id must be unable to read, write or delete another
 * tenant's row even when it already holds a valid-looking draft object, and a
 * token must be genuinely unobtainable — not merely un-displayed — the instant
 * the session it belonged to ends.
 *
 * Everything here is deterministic: instants are literals, ids are literals,
 * and no test reads `Date.now()` or `Math.random()`.
 */

import { isPending } from '../../domain/state-machine';
import {
  EMPTY_PROVENANCE,
  type FieldProvenance,
  type ReceiptDraft,
} from '../../domain/types';
import {
  CrossCompanyWriteError,
  DraftNotFoundError,
  DuplicateDraftError,
  InMemoryReceiptStore,
} from '../store';
import {
  InMemorySecretStore,
  SessionManager,
  type PublicSession,
  type SecretStore,
  type Session,
} from '../session';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_A = 'co_acme';
const COMPANY_B = 'co_northwind';

const ID_A1 = 'rcp_AAAAAAAAAAAAAAAAAAAAA1';
const ID_A2 = 'rcp_AAAAAAAAAAAAAAAAAAAAA2';
const ID_B1 = 'rcp_BBBBBBBBBBBBBBBBBBBBB1';
const ID_B2 = 'rcp_BBBBBBBBBBBBBBBBBBBBB2';

const IDEM_A = `idem_${'a'.repeat(32)}`;

/**
 * A writable view of a draft. The domain type is `readonly` throughout, but the
 * deep-copy tests exist precisely to mutate a caller-held object, so they need a
 * mutable alias rather than a cast to `any`.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableDraft = Omit<Mutable<ReceiptDraft>, 'provenance'> & { provenance: Mutable<FieldProvenance> };

function makeDraft(overrides: Partial<ReceiptDraft> = {}): MutableDraft {
  const base: MutableDraft = {
    localId: ID_A1,
    companyId: COMPANY_A,
    fileUri: 'file:///sandbox/receipts/a1.jpg',
    fileName: 'receipt.jpg',
    fileMimeType: 'image/jpeg',
    fileSizeBytes: 120_000,
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: 1999,
    currency: 'USD',
    transactionDate: '2026-08-11',
    notes: null,
    state: 'queued',
    idempotencyKey: IDEM_A,
    serverReceiptId: null,
    matchedTransactionId: null,
    pendingMatchTransactionId: null,
    provenance: { ...EMPTY_PROVENANCE },
    lastError: null,
    lastErrorRetryable: false,
    attemptCount: 0,
    createdAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
    lastServerSyncAt: null,
  };
  return {
    ...base,
    ...overrides,
    provenance: { ...base.provenance, ...(overrides.provenance ?? {}) },
  };
}

/** Narrows without a non-null assertion, and fails loudly if the row is absent. */
function expectDraft(d: ReceiptDraft | null): ReceiptDraft {
  if (d === null) throw new Error('expected a draft, got null');
  return d;
}

/** A writable alias for a draft the store handed back. */
function asMutable(d: ReceiptDraft): MutableDraft {
  return d as MutableDraft;
}

/**
 * Serialised form, used for the "byte-for-byte unchanged" assertions. Comparing
 * the JSON text — not just deep equality — also catches a row that was rewritten
 * with the same values in a different key order, i.e. silently replaced.
 */
function bytes(value: unknown): string {
  return JSON.stringify(value);
}

function localIds(drafts: ReceiptDraft[]): string[] {
  return drafts.map((d) => d.localId).sort();
}

// ===========================================================================
// STORE — the company boundary is structural
// ===========================================================================

describe('InMemoryReceiptStore: company boundary on reads', () => {
  /**
   * Two rows identical in every field that carries meaning. Only the primary key
   * and the owning company differ, so nothing but tenancy can be doing the
   * filtering.
   */
  async function seedTwins(): Promise<InMemoryReceiptStore> {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B }));
    return store;
  }

  it('get() does not return another company row, even when the rows are otherwise identical', async () => {
    const store = await seedTwins();

    expect(await store.get(COMPANY_A, ID_B1)).toBeNull();
    expect(await store.get(COMPANY_B, ID_A1)).toBeNull();

    expect(expectDraft(await store.get(COMPANY_A, ID_A1)).companyId).toBe(COMPANY_A);
    expect(expectDraft(await store.get(COMPANY_B, ID_B1)).companyId).toBe(COMPANY_B);
  });

  it('get() returns null rather than throwing for an id that exists under another tenant', async () => {
    const store = await seedTwins();
    // The caller must not be able to distinguish "not yours" from "not there":
    // a thrown CrossCompany error would itself leak the row's existence.
    await expect(store.get(COMPANY_A, ID_B1)).resolves.toBeNull();
    await expect(store.get(COMPANY_A, 'rcp_does_not_exist')).resolves.toBeNull();
  });

  it('list() returns only the asking company rows', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    await store.insert(makeDraft({ localId: ID_A2, companyId: COMPANY_A, createdAt: '2026-08-12T10:00:00.000Z' }));
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B }));
    await store.insert(makeDraft({ localId: ID_B2, companyId: COMPANY_B, createdAt: '2026-08-12T10:00:00.000Z' }));

    expect(localIds(await store.list(COMPANY_A))).toEqual([ID_A1, ID_A2]);
    expect(localIds(await store.list(COMPANY_B))).toEqual([ID_B1, ID_B2]);
    expect(await store.list('co_unknown')).toEqual([]);
    expect(store._totalRowCount()).toBe(4);
  });

  it('listByState() filters by state WITHIN the company, never across it', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A, state: 'queued' }));
    await store.insert(makeDraft({ localId: ID_A2, companyId: COMPANY_A, state: 'confirmed', serverReceiptId: 'srv_1' }));
    // Same state as A's queued row — if the filter ran before the tenancy check,
    // this is the row that would leak.
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B, state: 'queued' }));

    expect(localIds(await store.listByState(COMPANY_A, ['queued']))).toEqual([ID_A1]);
    expect(localIds(await store.listByState(COMPANY_B, ['queued']))).toEqual([ID_B1]);
    expect(localIds(await store.listByState(COMPANY_A, ['queued', 'confirmed']))).toEqual([ID_A1, ID_A2]);
    expect(await store.listByState(COMPANY_A, ['failed'])).toEqual([]);
    expect(await store.listByState('co_unknown', ['queued'])).toEqual([]);
  });

  it('countPending() counts this company pending work only, and agrees with isPending()', async () => {
    const store = new InMemoryReceiptStore();
    // Company A: 2 pending out of 5 rows.
    await store.insert(makeDraft({ localId: 'rcp_a_queued', companyId: COMPANY_A, state: 'queued' }));
    await store.insert(makeDraft({ localId: 'rcp_a_uploading', companyId: COMPANY_A, state: 'uploading' }));
    await store.insert(makeDraft({ localId: 'rcp_a_draft', companyId: COMPANY_A, state: 'draft' }));
    await store.insert(makeDraft({ localId: 'rcp_a_failed', companyId: COMPANY_A, state: 'failed' }));
    await store.insert(
      makeDraft({ localId: 'rcp_a_confirmed', companyId: COMPANY_A, state: 'confirmed', serverReceiptId: 'srv_a' }),
    );
    // Company B: a deliberately DIFFERENT pending count, so a leak changes the number.
    await store.insert(makeDraft({ localId: 'rcp_b_queued', companyId: COMPANY_B, state: 'queued' }));
    await store.insert(makeDraft({ localId: 'rcp_b_uploading', companyId: COMPANY_B, state: 'uploading' }));
    await store.insert(makeDraft({ localId: 'rcp_b_processing', companyId: COMPANY_B, state: 'processing' }));

    expect(await store.countPending(COMPANY_A)).toBe(2);
    expect(await store.countPending(COMPANY_B)).toBe(3);
    expect(await store.countPending('co_unknown')).toBe(0);

    // The badge must mean the same thing the state machine means by "pending",
    // so the two definitions cannot drift apart unnoticed.
    for (const company of [COMPANY_A, COMPANY_B]) {
      const rows = await store.list(company);
      expect(await store.countPending(company)).toBe(rows.filter((r) => isPending(r.state)).length);
    }
  });
});

describe('InMemoryReceiptStore: company boundary on writes', () => {
  it('update() with the wrong companyId throws and leaves the row byte-for-byte unchanged', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    const before = expectDraft(await store.get(COMPANY_A, ID_A1));
    const beforeBytes = bytes(before);

    // Company B holds a perfectly well-formed draft object and tries to write
    // through it, claiming the row as its own.
    const hijack: ReceiptDraft = {
      ...before,
      companyId: COMPANY_B,
      vendor: 'Rewritten By Northwind',
      amountMinorUnits: 999_999,
      state: 'confirmed',
      serverReceiptId: 'srv_forged',
    };

    await expect(store.update(COMPANY_B, hijack)).rejects.toBeInstanceOf(CrossCompanyWriteError);

    const after = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(bytes(after)).toBe(beforeBytes);
    expect(after).toEqual(before);
    // Nothing moved tenants and nothing was created on the way.
    expect(await store.get(COMPANY_B, ID_A1)).toBeNull();
    expect(store._totalRowCount()).toBe(1);
  });

  it('update() rejects a wrong-company write even when the payload is otherwise untouched', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    const before = expectDraft(await store.get(COMPANY_A, ID_A1));

    // Payload still says company A; only the CALLER is wrong. A no-op-looking
    // write is still a cross-tenant write and must be refused.
    await expect(store.update(COMPANY_B, before)).rejects.toBeInstanceOf(CrossCompanyWriteError);
    expect(bytes(expectDraft(await store.get(COMPANY_A, ID_A1)))).toBe(bytes(before));
  });

  it('update() throws when the payload companyId was tampered with, even if the companyId ARGUMENT is correct', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    const before = expectDraft(await store.get(COMPANY_A, ID_A1));
    const beforeBytes = bytes(before);

    // This is the dangerous shape: the argument passes the tenancy check, and
    // the row is re-stamped with another company on the way in. If it succeeded,
    // the row would silently emigrate — invisible to A, uploadable by B.
    const tampered: ReceiptDraft = { ...before, companyId: COMPANY_B };

    await expect(store.update(COMPANY_A, tampered)).rejects.toBeInstanceOf(CrossCompanyWriteError);

    expect(bytes(expectDraft(await store.get(COMPANY_A, ID_A1)))).toBe(beforeBytes);
    expect(await store.get(COMPANY_B, ID_A1)).toBeNull();
    expect(expectDraft(await store.get(COMPANY_A, ID_A1)).companyId).toBe(COMPANY_A);
    expect(store._totalRowCount()).toBe(1);
  });

  it('update() throws DraftNotFoundError for a row that does not exist at all', async () => {
    const store = new InMemoryReceiptStore();
    await expect(store.update(COMPANY_A, makeDraft({ localId: ID_A1 }))).rejects.toBeInstanceOf(DraftNotFoundError);
    expect(store._totalRowCount()).toBe(0);
  });

  it('update() with the owning company persists the new values', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A, state: 'queued' }));
    const before = expectDraft(await store.get(COMPANY_A, ID_A1));

    await store.update(COMPANY_A, { ...before, state: 'uploading', attemptCount: 1 });

    const after = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(after.state).toBe('uploading');
    expect(after.attemptCount).toBe(1);
    expect(store._totalRowCount()).toBe(1);
  });

  it('delete() with the wrong company throws, deletes nothing, and leaks no row count', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B }));
    const before = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(store._totalRowCount()).toBe(2);

    await expect(store.delete(COMPANY_B, ID_A1)).rejects.toBeInstanceOf(DraftNotFoundError);

    expect(store._totalRowCount()).toBe(2);
    expect(bytes(expectDraft(await store.get(COMPANY_A, ID_A1)))).toBe(bytes(before));
  });

  it('delete() with the owning company removes exactly one row', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B }));

    await store.delete(COMPANY_A, ID_A1);

    expect(await store.get(COMPANY_A, ID_A1)).toBeNull();
    expect(expectDraft(await store.get(COMPANY_B, ID_B1)).localId).toBe(ID_B1);
    expect(store._totalRowCount()).toBe(1);
    // Deleting again is not silently tolerated.
    await expect(store.delete(COMPANY_A, ID_A1)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it('insert() rejects a duplicate localId', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A, vendor: 'Original' }));

    await expect(store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A, vendor: 'Second' }))).rejects.toBeInstanceOf(
      DuplicateDraftError,
    );

    expect(expectDraft(await store.get(COMPANY_A, ID_A1)).vendor).toBe('Original');
    expect(store._totalRowCount()).toBe(1);
  });

  it('insert() rejects a duplicate localId from ANOTHER company rather than shadowing the row', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A, vendor: 'Original' }));

    await expect(
      store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_B, vendor: 'Northwind copy' })),
    ).rejects.toBeInstanceOf(DuplicateDraftError);

    const surviving = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(surviving.companyId).toBe(COMPANY_A);
    expect(surviving.vendor).toBe('Original');
    expect(await store.get(COMPANY_B, ID_A1)).toBeNull();
    expect(store._totalRowCount()).toBe(1);
  });
});

describe('InMemoryReceiptStore: isolation from caller-held objects', () => {
  it('deep-copies on insert(): mutating the object you passed in does not change stored state', async () => {
    const store = new InMemoryReceiptStore();
    const input = makeDraft({ localId: ID_A1, companyId: COMPANY_A, vendor: 'Blue Bottle Coffee' });
    await store.insert(input);

    input.vendor = 'Mutated after insert';
    input.amountMinorUnits = 999_999;
    input.companyId = COMPANY_B;
    input.state = 'confirmed';
    input.provenance.vendor = 'user';

    const stored = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(stored.vendor).toBe('Blue Bottle Coffee');
    expect(stored.amountMinorUnits).toBe(1999);
    expect(stored.companyId).toBe(COMPANY_A);
    expect(stored.state).toBe('queued');
    expect(stored.provenance.vendor).toBe('empty');
    // The nested provenance object must be a copy, not the caller's instance.
    expect(stored.provenance).not.toBe(input.provenance);
  });

  it('deep-copies on get(): mutating the object you read back does not change stored state', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));

    const first = asMutable(expectDraft(await store.get(COMPANY_A, ID_A1)));
    first.vendor = 'Mutated after read';
    first.companyId = COMPANY_B;
    first.serverReceiptId = 'srv_forged';
    first.provenance.amount = 'ocr';

    const second = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(second.vendor).toBe('Blue Bottle Coffee');
    expect(second.companyId).toBe(COMPANY_A);
    expect(second.serverReceiptId).toBeNull();
    expect(second.provenance.amount).toBe('empty');
    expect(second).not.toBe(first);
  });

  it('deep-copies on update(): mutating the payload after the write does not change stored state', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    const payload = makeDraft({ localId: ID_A1, companyId: COMPANY_A, vendor: 'Corrected Vendor' });

    await store.update(COMPANY_A, payload);
    payload.vendor = 'Mutated after update';
    payload.provenance.vendor = 'ocr';

    const stored = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(stored.vendor).toBe('Corrected Vendor');
    expect(stored.provenance.vendor).toBe('empty');
  });

  it('deep-copies on list() and listByState(): mutating a listed row does not change stored state', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A, state: 'queued' }));

    const listed = asMutable(expectDraft((await store.list(COMPANY_A))[0] ?? null));
    listed.vendor = 'Mutated via list';
    listed.provenance.currency = 'user';

    const byState = asMutable(expectDraft((await store.listByState(COMPANY_A, ['queued']))[0] ?? null));
    byState.state = 'confirmed';

    const stored = expectDraft(await store.get(COMPANY_A, ID_A1));
    expect(stored.vendor).toBe('Blue Bottle Coffee');
    expect(stored.provenance.currency).toBe('empty');
    expect(stored.state).toBe('queued');
  });
});

describe('InMemoryReceiptStore: getAnyCompanyDraftById', () => {
  it('returns the owning companyId alongside the draft, so the caller cannot use it unknowingly', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B, vendor: 'Northwind Supplies' }));

    const found = await store.getAnyCompanyDraftById(ID_B1);
    if (found === null) throw new Error('expected an unscoped lookup to find the row');

    // The shape itself is the safeguard: a bare ReceiptDraft return would let a
    // caller treat another tenant's row as its own without ever seeing a company.
    expect(Object.keys(found).sort()).toEqual(['companyId', 'draft']);
    expect(found.companyId).toBe(COMPANY_B);
    expect(found.draft.localId).toBe(ID_B1);
    expect(found.draft.companyId).toBe(COMPANY_B);
    // And the company-scoped API still refuses the row.
    expect(await store.get(COMPANY_A, ID_B1)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_A1, companyId: COMPANY_A }));
    expect(await store.getAnyCompanyDraftById('rcp_nope')).toBeNull();
  });

  it('hands back a copy, so the escape hatch cannot be used to write', async () => {
    const store = new InMemoryReceiptStore();
    await store.insert(makeDraft({ localId: ID_B1, companyId: COMPANY_B }));

    const found = await store.getAnyCompanyDraftById(ID_B1);
    if (found === null) throw new Error('expected an unscoped lookup to find the row');
    const escaped = asMutable(found.draft);
    escaped.companyId = COMPANY_A;
    escaped.vendor = 'Stolen';

    expect(expectDraft(await store.get(COMPANY_B, ID_B1)).vendor).toBe('Blue Bottle Coffee');
    expect(await store.get(COMPANY_A, ID_B1)).toBeNull();
  });
});

// ===========================================================================
// SESSION — the token rules
// ===========================================================================

const T_SIGN_IN = '2026-08-11T12:00:00.000Z';
const T_BEFORE_EXPIRY = '2026-08-11T17:59:59.999Z';
const T_EXPIRY = '2026-08-11T18:00:00.000Z';
const T_AFTER_EXPIRY = '2026-08-11T18:00:00.001Z';

const TOKEN_A = 'tok_company_a_9f3c';
const TOKEN_B = 'tok_company_b_51ab';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: 'usr_driver_1',
    companyId: COMPANY_A,
    token: TOKEN_A,
    expiresAt: T_EXPIRY,
    ...overrides,
  };
}

/**
 * Wraps the in-memory secret store and records every operation, including what
 * was already stored at the moment the operation ran. That "before" snapshot is
 * what lets `switchCompany` be tested for ORDER rather than just end state.
 */
interface SecretOp {
  readonly kind: 'set' | 'get' | 'delete';
  readonly key: string;
  readonly storedBefore: string | null;
}

class RecordingSecretStore implements SecretStore {
  readonly ops: SecretOp[] = [];

  constructor(private readonly inner: InMemorySecretStore) {}

  async setItem(key: string, value: string): Promise<void> {
    this.ops.push({ kind: 'set', key, storedBefore: await this.inner.getItem(key) });
    await this.inner.setItem(key, value);
  }

  async getItem(key: string): Promise<string | null> {
    const storedBefore = await this.inner.getItem(key);
    this.ops.push({ kind: 'get', key, storedBefore });
    return storedBefore;
  }

  async deleteItem(key: string): Promise<void> {
    this.ops.push({ kind: 'delete', key, storedBefore: await this.inner.getItem(key) });
    await this.inner.deleteItem(key);
  }

  writeOps(): SecretOp[] {
    return this.ops.filter((o) => o.kind !== 'get');
  }
}

/**
 * The storage key is a private implementation detail, so tests discover it by
 * observing what a sign-in actually wrote rather than importing a constant.
 */
function soleSecretKey(secrets: InMemorySecretStore): string {
  const keys = secrets._keys();
  if (keys.length !== 1) throw new Error(`expected exactly one stored secret, got ${keys.length}`);
  const [key] = keys;
  if (key === undefined) throw new Error('unreachable: key list was non-empty');
  return key;
}

function expectPublic(s: PublicSession | null): PublicSession {
  if (s === null) throw new Error('expected a public session, got null');
  return s;
}

describe('SessionManager: getTokenForCompany is the client-side company/auth guard', () => {
  it('returns the token for the active company before expiry', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession());

    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBe(TOKEN_A);
    expect(manager.getTokenForCompany(COMPANY_A, T_BEFORE_EXPIRY)).toBe(TOKEN_A);
  });

  it('returns null for a DIFFERENT company', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession({ companyId: COMPANY_A }));

    // A sync pass that started under B must not be able to borrow A's token.
    expect(manager.getTokenForCompany(COMPANY_B, T_SIGN_IN)).toBeNull();
    expect(manager.getTokenForCompany('', T_SIGN_IN)).toBeNull();
  });

  it('returns null for an EXPIRED token, including exactly at the expiry instant', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession({ expiresAt: T_EXPIRY }));

    // Expiry is inclusive: at expiresAt the token is already dead. This is the
    // "auth expires while a background upload is running" case.
    expect(manager.getTokenForCompany(COMPANY_A, T_EXPIRY)).toBeNull();
    expect(manager.getTokenForCompany(COMPANY_A, T_AFTER_EXPIRY)).toBeNull();
    expect(manager.isExpired(T_BEFORE_EXPIRY)).toBe(false);
    expect(manager.isExpired(T_EXPIRY)).toBe(true);
  });

  it('returns null when signed out, both before any sign-in and after signOut()', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);

    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBeNull();
    expect(manager.isExpired(T_SIGN_IN)).toBe(true);

    await manager.signIn(makeSession());
    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBe(TOKEN_A);

    await manager.signOut();
    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBeNull();
    expect(manager.getCompanyId()).toBeNull();
    expect(manager.isExpired(T_SIGN_IN)).toBe(true);
  });
});

describe('SessionManager: switchCompany destroys the old credential first', () => {
  it('deletes the previous secret BEFORE storing the new one', async () => {
    const inner = new InMemorySecretStore();
    const recording = new RecordingSecretStore(inner);
    const manager = new SessionManager(recording);

    await manager.signIn(makeSession({ companyId: COMPANY_A, token: TOKEN_A }));
    const writes = recording.writeOps();
    expect(writes.map((o) => o.kind)).toEqual(['set']);

    await manager.switchCompany(
      makeSession({ userId: 'usr_driver_1', companyId: COMPANY_B, token: TOKEN_B }),
    );

    const after = recording.writeOps();
    expect(after.map((o) => o.kind)).toEqual(['set', 'delete', 'set']);

    const [, deletion, secondWrite] = after;
    if (deletion === undefined || secondWrite === undefined) throw new Error('expected three write ops');

    // The delete saw company A's credential...
    expect(deletion.storedBefore).not.toBeNull();
    expect(deletion.storedBefore ?? '').toContain(TOKEN_A);
    // ...and by the time the new credential was written, storage was EMPTY.
    // There is therefore no instant at which both companies' tokens are live.
    expect(secondWrite.storedBefore).toBeNull();
    expect(deletion.key).toBe(secondWrite.key);
  });

  it('makes the old company token unobtainable afterwards', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession({ companyId: COMPANY_A, token: TOKEN_A }));

    await manager.switchCompany(makeSession({ companyId: COMPANY_B, token: TOKEN_B }));

    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBeNull();
    expect(manager.getTokenForCompany(COMPANY_B, T_SIGN_IN)).toBe(TOKEN_B);
    expect(manager.getCompanyId()).toBe(COMPANY_B);

    // Not merely hidden behind the API: A's token is not in storage at all, so a
    // relaunch cannot resurrect it either.
    const persisted = await secrets.getItem(soleSecretKey(secrets));
    expect(persisted ?? '').not.toContain(TOKEN_A);
    expect(persisted ?? '').toContain(TOKEN_B);

    const relaunched = new SessionManager(secrets);
    const restored = expectPublic(await relaunched.restore());
    expect(restored.companyId).toBe(COMPANY_B);
    expect(relaunched.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBeNull();
  });
});

describe('SessionManager: signOut leaves no secret behind', () => {
  it('removes the secret entirely', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession());
    expect(secrets._keys()).toHaveLength(1);

    await manager.signOut();

    expect(secrets._keys()).toEqual([]);
    expect(manager.getPublicSession(T_SIGN_IN)).toBeNull();
    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBeNull();
  });

  it('leaves nothing behind after a company switch either, and a relaunch restores nothing', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession({ companyId: COMPANY_A, token: TOKEN_A }));
    await manager.switchCompany(makeSession({ companyId: COMPANY_B, token: TOKEN_B }));

    await manager.signOut();

    expect(secrets._keys()).toEqual([]);
    expect(await new SessionManager(secrets).restore()).toBeNull();
  });

  it('is idempotent', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession());

    await manager.signOut();
    await expect(manager.signOut()).resolves.toBeUndefined();
    expect(secrets._keys()).toEqual([]);
  });
});

describe('SessionManager: restore', () => {
  it('rehydrates a session, token included, on a cold start', async () => {
    const secrets = new InMemorySecretStore();
    const original = new SessionManager(secrets);
    await original.signIn(makeSession({ companyId: COMPANY_A, token: TOKEN_A }));

    // A brand-new manager, as after an app kill and relaunch.
    const relaunched = new SessionManager(secrets);
    const restored = expectPublic(await relaunched.restore());

    expect(restored.userId).toBe('usr_driver_1');
    expect(restored.companyId).toBe(COMPANY_A);
    expect(restored.expiresAt).toBe(T_EXPIRY);
    expect(relaunched.getCompanyId()).toBe(COMPANY_A);
    // The token really came back, not just the metadata.
    expect(relaunched.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBe(TOKEN_A);
    // ...and the company guard still applies to the restored session.
    expect(relaunched.getTokenForCompany(COMPANY_B, T_SIGN_IN)).toBeNull();
  });

  it('returns null when nothing was ever stored', async () => {
    const secrets = new InMemorySecretStore();
    expect(await new SessionManager(secrets).restore()).toBeNull();
  });

  const corruptBlobs: readonly (readonly [string, string])[] = [
    ['unparseable text', 'not json at all {{{'],
    ['truncated json', '{"userId":"usr_driver_1","companyId":"co_acme","tok'],
    ['json null', 'null'],
    ['json string', '"just a string"'],
    ['object missing companyId', JSON.stringify({ userId: 'usr_driver_1', token: TOKEN_A })],
    ['object missing token', JSON.stringify({ userId: 'usr_driver_1', companyId: COMPANY_A })],
    ['object missing userId', JSON.stringify({ companyId: COMPANY_A, token: TOKEN_A })],
    ['empty object', '{}'],
  ];

  it.each(corruptBlobs)('returns null and clears the key for a corrupt blob (%s)', async (_label, blob) => {
    const secrets = new InMemorySecretStore();
    // Sign in first so the manager itself tells us which key it uses, then
    // corrupt that value in place.
    const seeded = new SessionManager(secrets);
    await seeded.signIn(makeSession());
    const key = soleSecretKey(secrets);
    await secrets.setItem(key, blob);

    const manager = new SessionManager(secrets);
    await expect(manager.restore()).resolves.toBeNull();

    // No half-loaded session...
    expect(manager.getPublicSession(T_SIGN_IN)).toBeNull();
    expect(manager.getCompanyId()).toBeNull();
    expect(manager.getTokenForCompany(COMPANY_A, T_SIGN_IN)).toBeNull();
    // ...and the unusable blob is not left lying in secure storage forever.
    expect(secrets._keys()).toEqual([]);
  });
});

describe('SessionManager: the token never escapes through the public surface', () => {
  it('getPublicSession exposes no token property', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession());

    const pub = expectPublic(manager.getPublicSession(T_SIGN_IN));

    expect(Object.prototype.hasOwnProperty.call(pub, 'token')).toBe(false);
    expect(Object.keys(pub).sort()).toEqual(['companyId', 'expired', 'expiresAt', 'userId']);
    expect(JSON.stringify(pub)).not.toContain(TOKEN_A);
  });

  it('reports expiry relative to the injected instant', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    await manager.signIn(makeSession({ expiresAt: T_EXPIRY }));

    expect(expectPublic(manager.getPublicSession(T_BEFORE_EXPIRY)).expired).toBe(false);
    expect(expectPublic(manager.getPublicSession(T_EXPIRY)).expired).toBe(true);
    expect(expectPublic(manager.getPublicSession(T_AFTER_EXPIRY)).expired).toBe(true);
  });

  it('never hands a token to a subscriber either', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    const seen: (PublicSession | null)[] = [];
    manager.subscribe((s) => { seen.push(s); });

    await manager.signIn(makeSession());
    await manager.switchCompany(makeSession({ companyId: COMPANY_B, token: TOKEN_B }));

    const payloads = seen.filter((s): s is PublicSession => s !== null);
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(Object.prototype.hasOwnProperty.call(p, 'token')).toBe(false);
      expect(JSON.stringify(p)).not.toContain(TOKEN_A);
      expect(JSON.stringify(p)).not.toContain(TOKEN_B);
    }
  });
});

describe('SessionManager: subscribe', () => {
  it('fires on signIn, switchCompany and signOut', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    const seen: (string | null)[] = [];
    manager.subscribe((s) => { seen.push(s === null ? null : s.companyId); });

    await manager.signIn(makeSession({ companyId: COMPANY_A, token: TOKEN_A }));
    await manager.switchCompany(makeSession({ companyId: COMPANY_B, token: TOKEN_B }));
    await manager.signOut();

    // The null in the middle is the switch tearing company A down before
    // company B exists — subscribers see the gap rather than a silent swap.
    expect(seen).toEqual([COMPANY_A, null, COMPANY_B, null]);
  });

  it('fires on a successful restore', async () => {
    const secrets = new InMemorySecretStore();
    await new SessionManager(secrets).signIn(makeSession());

    const relaunched = new SessionManager(secrets);
    const seen: (string | null)[] = [];
    relaunched.subscribe((s) => { seen.push(s === null ? null : s.companyId); });

    await relaunched.restore();

    expect(seen).toEqual([COMPANY_A]);
  });

  it('supports multiple listeners and stops delivering after unsubscribe', async () => {
    const secrets = new InMemorySecretStore();
    const manager = new SessionManager(secrets);
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    const unsubscribeA = manager.subscribe((s) => { a.push(s === null ? null : s.companyId); });
    manager.subscribe((s) => { b.push(s === null ? null : s.companyId); });

    await manager.signIn(makeSession());
    unsubscribeA();
    await manager.signOut();

    expect(a).toEqual([COMPANY_A]);
    expect(b).toEqual([COMPANY_A, null]);
  });
});

/**
 * Found by a mutation audit: the suite above stayed green while `restore()`
 * was sabotaged to drop `expiresAt`, because the shipped implementation had
 * the same hole. A blob missing `expiresAt` rehydrated into a session where
 * `undefined <= now` is false — so it never expired, and the token was handed
 * out forever. These pin the fix.
 */
describe('a restored session cannot outlive its expiry', () => {
  const KEY = 'receipt_capture.auth_token';

  it.each([
    ['no expiresAt at all', { userId: 'u1', companyId: 'co_acme', token: 'tok_live' }],
    ['expiresAt is not an instant', { userId: 'u1', companyId: 'co_acme', token: 'tok_live', expiresAt: 'yesterday' }],
    ['expiresAt is a date-only value', { userId: 'u1', companyId: 'co_acme', token: 'tok_live', expiresAt: '2026-08-11' }],
    ['expiresAt is null', { userId: 'u1', companyId: 'co_acme', token: 'tok_live', expiresAt: null }],
  ])('destroys an undated blob (%s) rather than trusting it forever', async (_label, blob) => {
    const secrets = new InMemorySecretStore();
    await secrets.setItem(KEY, JSON.stringify(blob));
    const mgr = new SessionManager(secrets, () => '2026-08-16T09:00:00.000Z');

    expect(await mgr.restore()).toBeNull();
    // The unusable secret must not be left in the Keychain: nothing else would
    // ever clean it up, and it may still hold a live bearer token.
    expect(secrets._keys()).toEqual([]);
    expect(mgr.isExpired('2026-08-16T09:00:00.000Z')).toBe(true);
    expect(mgr.getTokenForCompany('co_acme', '2099-01-01T00:00:00.000Z')).toBeNull();
  });

  it('restores a well-formed session and still honours its expiry', async () => {
    const secrets = new InMemorySecretStore();
    await secrets.setItem(KEY, JSON.stringify({
      userId: 'u1', companyId: 'co_acme', token: 'tok_live',
      expiresAt: '2026-08-16T10:00:00.000Z',
    }));
    const mgr = new SessionManager(secrets, () => '2026-08-16T09:00:00.000Z');

    expect(await mgr.restore()).not.toBeNull();
    expect(mgr.getTokenForCompany('co_acme', '2026-08-16T09:00:00.000Z')).toBe('tok_live');
    // One second past expiry, the same call must refuse.
    expect(mgr.getTokenForCompany('co_acme', '2026-08-16T10:00:01.000Z')).toBeNull();
  });
});

describe('what a subscriber is told is true', () => {
  it('reports expired:true for a session that has already lapsed', async () => {
    const secrets = new InMemorySecretStore();
    const mgr = new SessionManager(secrets, () => '2026-08-16T09:00:00.000Z');

    const seen: (unknown | null)[] = [];
    mgr.subscribe((s) => seen.push(s));

    await mgr.signIn({
      userId: 'u1', companyId: 'co_acme', token: 't',
      expiresAt: '2000-01-01T00:00:00.000Z', // long gone
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ expired: true });
  });

  it('reports expired:false while the session is still live', async () => {
    const secrets = new InMemorySecretStore();
    const mgr = new SessionManager(secrets, () => '2026-08-16T09:00:00.000Z');

    const seen: (unknown | null)[] = [];
    mgr.subscribe((s) => seen.push(s));

    await mgr.signIn({
      userId: 'u1', companyId: 'co_acme', token: 't',
      expiresAt: '2026-08-16T10:00:00.000Z',
    });

    expect(seen[0]).toMatchObject({ expired: false });
  });

  it('never exposes the token to a subscriber', async () => {
    const secrets = new InMemorySecretStore();
    const mgr = new SessionManager(secrets, () => '2026-08-16T09:00:00.000Z');

    const seen: Record<string, unknown>[] = [];
    mgr.subscribe((s) => { if (s) seen.push(s as unknown as Record<string, unknown>); });

    await mgr.signIn({
      userId: 'u1', companyId: 'co_acme', token: 'super-secret',
      expiresAt: '2026-08-16T10:00:00.000Z',
    });

    expect(seen[0]).not.toHaveProperty('token');
    expect(JSON.stringify(seen[0])).not.toContain('super-secret');
  });
});
