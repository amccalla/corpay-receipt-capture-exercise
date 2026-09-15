import type { Instant, Receipt, ReceiptMetadata } from '../../domain/types';
import {
  ACCEPTED_MIME_TYPES,
  DEFAULT_NOW_ISO,
  FakeServer,
  FakeServerError,
  MAX_UPLOAD_BYTES,
  type ServerErrorCode,
  type SubmitReceiptRequest,
  type SubmitReceiptResponse,
} from '../fake-server';
import { extractFromReceipt, isLowConfidence, type OcrResult } from '../ocr';
import { COMPANIES, MEMBERSHIPS, USERS, seedTransactions } from '../seed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/** Narrowing helpers — `expect(res.ok).toBe(true)` does not teach the compiler anything. */
function expectOk(res: SubmitReceiptResponse): { receipt: Receipt; deduped: boolean } {
  if (!res.ok) throw new Error(`expected success, got ${res.code}: ${res.message}`);
  return { receipt: res.receipt, deduped: res.deduped };
}

function expectErr(res: SubmitReceiptResponse): {
  code: ServerErrorCode;
  message: string;
  retryable: boolean;
} {
  if (res.ok) throw new Error(`expected failure, got receipt ${res.receipt.id}`);
  return { code: res.code, message: res.message, retryable: res.retryable };
}

/** A clock the test moves by hand. Nothing here reads the wall clock. */
function mutableClock(startIso: Instant): { now: () => Instant; advance: (ms: number) => void } {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms).toISOString(),
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

function findKeyWhere(pred: (r: OcrResult) => boolean): string {
  for (let i = 0; i < 1000; i += 1) {
    const key = `receipts/blob-${i}.jpg`;
    if (pred(extractFromReceipt(key))) return key;
  }
  throw new Error('no storage key in the search space satisfies the predicate');
}

/** Fixed, deterministic keys whose OCR outcome is known before any test runs. */
const CONFIDENT_KEY = findKeyWhere((r) => !isLowConfidence(r));
const UNCERTAIN_KEY = findKeyWhere((r) => isLowConfidence(r));
const KEY_WITH_VENDOR = findKeyWhere((r) => r.vendor !== null);

const EMPTY_MD: ReceiptMetadata = {
  vendor: null,
  amountMinorUnits: null,
  currency: null,
  transactionDate: null,
  notes: null,
};

const HUMAN_MD: ReceiptMetadata = {
  vendor: 'Blue Bottle Coffee',
  amountMinorUnits: 4250, // $42.50 — integer minor units, never 42.5
  currency: 'USD',
  transactionDate: '2026-08-11',
  notes: 'Client meeting',
};

let probeCounter = 0;

function makeReq(over: Partial<SubmitReceiptRequest> = {}): SubmitReceiptRequest {
  return {
    idempotencyKey: 'idem-1',
    companyId: 'northwind',
    authToken: 'tok_1',
    file: { storageKey: CONFIDENT_KEY, mime: 'image/jpeg', sizeBytes: 250_000 },
    metadata: EMPTY_MD,
    matchTransactionId: null,
    ...over,
  };
}

describe('FakeServer', () => {
  let server: FakeServer;
  let clock: ReturnType<typeof mutableClock>;
  let nwToken: string;
  let acmeToken: string;

  beforeEach(() => {
    clock = mutableClock(DEFAULT_NOW_ISO);
    server = new FakeServer({ now: clock.now });
    nwToken = server.issueToken('usr_dana', 'northwind', HOUR);
    acmeToken = server.issueToken('usr_dana', 'acme', HOUR);
  });

  /**
   * Creates a throwaway receipt and reports the id it was given. Because ids
   * come from a strictly increasing counter, this is how a test proves that
   * some earlier call created NOTHING: if the counter never moved, the next
   * receipt is still 'rec_1'.
   */
  async function probeNextReceiptId(companyId = 'northwind', token = nwToken): Promise<string> {
    probeCounter += 1;
    const res = expectOk(
      await server.submitReceipt(
        makeReq({ idempotencyKey: `probe-${probeCounter}`, companyId, authToken: token }),
      ),
    );
    return res.receipt.id;
  }

  // -------------------------------------------------------------------------
  describe('auth and the company boundary', () => {
    it('rejects an unknown token as AUTH_EXPIRED, retryable after re-auth', async () => {
      const err = expectErr(await server.submitReceipt(makeReq({ authToken: 'tok_nope' })));
      expect(err.code).toBe('AUTH_EXPIRED');
      expect(err.retryable).toBe(true);
      expect(await probeNextReceiptId()).toBe('rec_1');
    });

    it('rejects a token that was explicitly expired', async () => {
      server.expireToken(nwToken);
      const err = expectErr(await server.submitReceipt(makeReq({ authToken: nwToken })));
      expect(err.code).toBe('AUTH_EXPIRED');
      expect(err.retryable).toBe(true);
    });

    it('rejects a token whose ttl has elapsed on the injected clock', async () => {
      const shortLived = server.issueToken('usr_kim', 'northwind', 1000);
      clock.advance(999);
      expect(expectOk(await server.submitReceipt(makeReq({ authToken: shortLived }))).receipt.id).toBe(
        'rec_1',
      );

      clock.advance(1); // exactly at expiry — expiry is inclusive
      const err = expectErr(
        await server.submitReceipt(makeReq({ idempotencyKey: 'idem-2', authToken: shortLived })),
      );
      expect(err.code).toBe('AUTH_EXPIRED');
    });

    it('treats a zero ttl as already dead', async () => {
      const dead = server.issueToken('usr_kim', 'northwind', 0);
      expect(expectErr(await server.submitReceipt(makeReq({ authToken: dead }))).code).toBe(
        'AUTH_EXPIRED',
      );
    });

    it('refuses to file a receipt under a company the token does not cover', async () => {
      // Northwind receipt, Acme token.
      const err = expectErr(
        await server.submitReceipt(makeReq({ companyId: 'northwind', authToken: acmeToken })),
      );
      expect(err.code).toBe('COMPANY_MISMATCH');
      // Not retryable: the same token will never work, so the sync engine must
      // stop rather than back off and try again.
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('acme');
      expect(await probeNextReceiptId()).toBe('rec_1');
    });

    it('edge case 3: a receipt queued under one company cannot upload under another', async () => {
      // Captured under northwind before the app was killed.
      const queued = makeReq({ idempotencyKey: 'queued-key', companyId: 'northwind' });

      // Relaunched; the active session is now Acme. The sync engine (or a bug
      // in it) sends the queued draft with the live token.
      const wrongCompany = expectErr(
        await server.submitReceipt({ ...queued, authToken: acmeToken }),
      );
      expect(wrongCompany.code).toBe('COMPANY_MISMATCH');

      // Nor can it be "fixed" by relabelling the receipt as Acme's: that would
      // file a northwind expense against the wrong tenant. The server cannot
      // catch a relabel, which is precisely why the client stamps companyId at
      // capture time and never rewrites it — but the id space proves nothing
      // was created above.
      expect(await probeNextReceiptId('acme', acmeToken)).toBe('rec_1');

      // Switch back to northwind: the ORIGINAL key still works and produces one
      // record.
      const ok = expectOk(await server.submitReceipt({ ...queued, authToken: nwToken }));
      expect(ok.deduped).toBe(false);
      expect(ok.receipt.companyId).toBe('northwind');
      expect(ok.receipt.id).toBe('rec_2');
    });

    it('edge case 2: auth expires mid-upload; re-auth + retry yields exactly one receipt', async () => {
      server.setFailureInjection('authExpired');
      const err = expectErr(await server.submitReceipt(makeReq({ idempotencyKey: 'bg-1' })));
      expect(err.code).toBe('AUTH_EXPIRED');
      expect(err.retryable).toBe(true);

      // Re-authenticate and replay the SAME idempotency key.
      server.setFailureInjection('none');
      const fresh = server.issueToken('usr_dana', 'northwind', HOUR);
      const ok = expectOk(
        await server.submitReceipt(makeReq({ idempotencyKey: 'bg-1', authToken: fresh })),
      );
      expect(ok.receipt.id).toBe('rec_1');
      expect(ok.deduped).toBe(false); // nothing had been created, so nothing was deduped
      expect(await probeNextReceiptId()).toBe('rec_2');
    });
  });

  // -------------------------------------------------------------------------
  describe('idempotency', () => {
    it('replays to the original receipt with deduped:true and creates nothing', async () => {
      const first = expectOk(await server.submitReceipt(makeReq()));
      expect(first.deduped).toBe(false);

      const second = expectOk(await server.submitReceipt(makeReq()));
      expect(second.deduped).toBe(true);
      expect(second.receipt.id).toBe(first.receipt.id);
      expect(second.receipt).toEqual(first.receipt);

      // The counter never moved.
      expect(await probeNextReceiptId()).toBe('rec_2');
    });

    it('ignores the body on replay — the key identifies the intent', async () => {
      const first = expectOk(await server.submitReceipt(makeReq({ metadata: HUMAN_MD })));

      const replay = expectOk(
        await server.submitReceipt(
          makeReq({
            metadata: { ...HUMAN_MD, vendor: 'Something Else', amountMinorUnits: 999 },
            matchTransactionId: 'txn_nw_01',
          }),
        ),
      );
      expect(replay.deduped).toBe(true);
      expect(replay.receipt).toEqual(first.receipt);
      expect(replay.receipt.matchedTransactionId).toBeNull();

      // And the transaction the replay asked for was never claimed.
      const txns = await server.listTransactions('northwind', nwToken);
      expect(txns.find((t) => t.id === 'txn_nw_01')?.matchedReceiptId).toBeNull();
    });

    it('scopes keys per company — the same key under two tenants is two receipts', async () => {
      const nw = expectOk(
        await server.submitReceipt(makeReq({ idempotencyKey: 'shared', companyId: 'northwind' })),
      );
      const ac = expectOk(
        await server.submitReceipt(
          makeReq({ idempotencyKey: 'shared', companyId: 'acme', authToken: acmeToken }),
        ),
      );
      expect(nw.receipt.id).not.toBe(ac.receipt.id);
      expect(ac.deduped).toBe(false);
      expect(nw.receipt.companyId).toBe('northwind');
      expect(ac.receipt.companyId).toBe('acme');
    });

    it('creates a separate receipt for a rotated key', async () => {
      const a = expectOk(await server.submitReceipt(makeReq({ idempotencyKey: 'k1' })));
      const b = expectOk(await server.submitReceipt(makeReq({ idempotencyKey: 'k2' })));
      expect(a.receipt.id).toBe('rec_1');
      expect(b.receipt.id).toBe('rec_2');
    });
  });

  // -------------------------------------------------------------------------
  describe('edge case 1: the success response is lost', () => {
    it('commits the record but reports TRANSFER_INTERRUPTED', async () => {
      server.setFailureInjection('lostSuccessResponse');
      const err = expectErr(await server.submitReceipt(makeReq()));
      expect(err.code).toBe('TRANSFER_INTERRUPTED');
      expect(err.retryable).toBe(true);

      // The client believes it failed. The server disagrees.
      server.setFailureInjection('none');
      expect(await server.getReceipt('rec_1', 'northwind', nwToken)).not.toBeNull();
    });

    it('retrying after the lost response returns the ORIGINAL receipt, deduped', async () => {
      server.setFailureInjection('lostSuccessResponse');
      expectErr(await server.submitReceipt(makeReq({ matchTransactionId: 'txn_nw_01' })));

      server.setFailureInjection('none');
      const retry = expectOk(await server.submitReceipt(makeReq({ matchTransactionId: 'txn_nw_01' })));
      expect(retry.deduped).toBe(true);
      expect(retry.receipt.id).toBe('rec_1');
      // The match made during the lost call survived, and re-asserting it is
      // NOT a double-match conflict.
      expect(retry.receipt.matchedTransactionId).toBe('txn_nw_01');

      // Exactly one record exists.
      expect(await server.getReceipt('rec_2', 'northwind', nwToken)).toBeNull();
      expect(await probeNextReceiptId()).toBe('rec_2');
    });

    it('a retry that ALSO loses its response still creates nothing new', async () => {
      server.setFailureInjection('lostSuccessResponse');
      expectErr(await server.submitReceipt(makeReq()));
      const second = expectErr(await server.submitReceipt(makeReq()));
      expect(second.code).toBe('TRANSFER_INTERRUPTED');
      expect(second.retryable).toBe(true);

      server.setFailureInjection('none');
      expect(await server.getReceipt('rec_2', 'northwind', nwToken)).toBeNull();
      const third = expectOk(await server.submitReceipt(makeReq()));
      expect(third.receipt.id).toBe('rec_1');
      expect(third.deduped).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('matching', () => {
    it('lets one receipt claim a transaction and marks it on the transaction', async () => {
      const ok = expectOk(await server.submitReceipt(makeReq({ matchTransactionId: 'txn_nw_08' })));
      expect(ok.receipt.matchedTransactionId).toBe('txn_nw_08');

      const txns = await server.listTransactions('northwind', nwToken);
      expect(txns.find((t) => t.id === 'txn_nw_08')?.matchedReceiptId).toBe(ok.receipt.id);
    });

    it('edge case 6: a second receipt cannot claim the same transaction', async () => {
      expectOk(await server.submitReceipt(makeReq({ idempotencyKey: 'a', matchTransactionId: 'txn_nw_08' })));

      const err = expectErr(
        await server.submitReceipt(makeReq({ idempotencyKey: 'b', matchTransactionId: 'txn_nw_08' })),
      );
      expect(err.code).toBe('TRANSACTION_ALREADY_MATCHED');
      // Permanent: retrying will never help. The user must pick another
      // transaction (txn_nw_09 is the near-duplicate sitting right next to it).
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('rec_1');

      // The loser was NOT created — no orphan receipt left behind.
      expect(await probeNextReceiptId()).toBe('rec_2');
    });

    it('lets the rejected receipt claim the ambiguous twin instead', async () => {
      expectOk(await server.submitReceipt(makeReq({ idempotencyKey: 'a', matchTransactionId: 'txn_nw_08' })));
      expectErr(await server.submitReceipt(makeReq({ idempotencyKey: 'b', matchTransactionId: 'txn_nw_08' })));
      const ok = expectOk(
        await server.submitReceipt(makeReq({ idempotencyKey: 'b2', matchTransactionId: 'txn_nw_09' })),
      );
      expect(ok.receipt.matchedTransactionId).toBe('txn_nw_09');
    });

    it('rejects an unknown transaction id without revealing whether it exists', async () => {
      const err = expectErr(await server.submitReceipt(makeReq({ matchTransactionId: 'txn_nope' })));
      expect(err.code).toBe('COMPANY_MISMATCH');
      expect(err.retryable).toBe(false);
    });

    it('rejects another company transaction id with the same answer', async () => {
      const err = expectErr(await server.submitReceipt(makeReq({ matchTransactionId: 'txn_ac_01' })));
      expect(err.code).toBe('COMPANY_MISMATCH');
      // Identical to the unknown-id answer on purpose: the response must not
      // confirm that txn_ac_01 exists somewhere.
      expect(err.message).toContain('not available to company');
      expect(await probeNextReceiptId()).toBe('rec_1');
    });
  });

  // -------------------------------------------------------------------------
  describe('file handling (edge case 4: a HEIC that is too large or unsupported)', () => {
    it('accepts a normal HEIC', async () => {
      const ok = expectOk(
        await server.submitReceipt(
          makeReq({ file: { storageKey: CONFIDENT_KEY, mime: 'image/heic', sizeBytes: 3_000_000 } }),
        ),
      );
      expect(ok.receipt.id).toBe('rec_1');
      expect(ACCEPTED_MIME_TYPES).toContain('image/heic');
    });

    it('rejects an oversized HEIC permanently', async () => {
      const err = expectErr(
        await server.submitReceipt(
          makeReq({
            file: {
              storageKey: CONFIDENT_KEY,
              mime: 'image/heic',
              sizeBytes: MAX_UPLOAD_BYTES + 1,
            },
          }),
        ),
      );
      expect(err.code).toBe('FILE_TOO_LARGE');
      expect(err.retryable).toBe(false); // retrying the same bytes cannot help
      expect(await probeNextReceiptId()).toBe('rec_1');
    });

    it('accepts a file of exactly the limit (boundary)', async () => {
      const ok = expectOk(
        await server.submitReceipt(
          makeReq({
            file: { storageKey: CONFIDENT_KEY, mime: 'image/jpeg', sizeBytes: MAX_UPLOAD_BYTES },
          }),
        ),
      );
      expect(ok.receipt.id).toBe('rec_1');
    });

    it('rejects a deployment-unsupported type when injected', async () => {
      server.setFailureInjection('unsupportedType');
      const err = expectErr(
        await server.submitReceipt(
          makeReq({ file: { storageKey: CONFIDENT_KEY, mime: 'image/heic', sizeBytes: 900 } }),
        ),
      );
      expect(err.code).toBe('UNSUPPORTED_TYPE');
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('image/heic');
    });

    it('rejects a type that is not on the accepted list', async () => {
      const err = expectErr(
        await server.submitReceipt(
          makeReq({ file: { storageKey: CONFIDENT_KEY, mime: 'application/zip', sizeBytes: 900 } }),
        ),
      );
      expect(err.code).toBe('UNSUPPORTED_TYPE');
    });

    it('rejects an empty or unmeasurable file', async () => {
      for (const sizeBytes of [0, -1, 1.5, Number.NaN]) {
        const err = expectErr(
          await server.submitReceipt(
            makeReq({
              idempotencyKey: `size-${sizeBytes}`,
              file: { storageKey: CONFIDENT_KEY, mime: 'image/jpeg', sizeBytes },
            }),
          ),
        );
        expect(err.code).toBe('UNSUPPORTED_TYPE');
      }
      expect(await probeNextReceiptId()).toBe('rec_1');
    });

    it('treats the client path as untrusted: traversal is stripped, keys are server-minted', async () => {
      const ok = expectOk(
        await server.submitReceipt(
          makeReq({
            file: {
              storageKey: '../../../etc/passwd',
              mime: 'image/jpeg',
              sizeBytes: 1000,
            },
          }),
        ),
      );
      expect(ok.receipt.storageKey).toBe('receipts/northwind/rec_1/etc/passwd');
      expect(ok.receipt.storageKey).not.toContain('..');
      // Namespaced by company, so one tenant's key can never address another's.
      expect(ok.receipt.storageKey.startsWith('receipts/northwind/')).toBe(true);
    });

    it('rejects a file reference that sanitizes to nothing', async () => {
      const err = expectErr(
        await server.submitReceipt(
          makeReq({ file: { storageKey: '../..', mime: 'image/jpeg', sizeBytes: 1000 } }),
        ),
      );
      expect(err.code).toBe('UNSUPPORTED_TYPE');
    });
  });

  // -------------------------------------------------------------------------
  describe('OCR (edge case 5: a late reading must not clobber a human)', () => {
    it('never overwrites a supplied metadata field, across the whole key space', async () => {
      const keys = Array.from({ length: 60 }, (_, i) => `receipts/blob-${i}.jpg`);

      // Guard against a vacuous test: OCR must actually disagree with the
      // human on some of these keys, or the assertion below proves nothing.
      const disagreeing = keys.filter((k) => {
        const r = extractFromReceipt(k);
        return (
          (r.vendor !== null && r.vendor !== HUMAN_MD.vendor) ||
          (r.amountMinorUnits !== null && r.amountMinorUnits !== HUMAN_MD.amountMinorUnits)
        );
      });
      expect(disagreeing.length).toBeGreaterThan(20);

      for (const [i, storageKey] of keys.entries()) {
        const ok = expectOk(
          await server.submitReceipt(
            makeReq({
              idempotencyKey: `md-${i}`,
              metadata: HUMAN_MD,
              file: { storageKey, mime: 'image/jpeg', sizeBytes: 1000 },
            }),
          ),
        );
        expect(ok.receipt.metadata).toEqual(HUMAN_MD);
      }
    });

    it('fills only the fields the human left blank', async () => {
      const ocr = extractFromReceipt(KEY_WITH_VENDOR);
      const ok = expectOk(
        await server.submitReceipt(
          makeReq({
            metadata: { ...EMPTY_MD, amountMinorUnits: 1, currency: 'USD' },
            file: { storageKey: KEY_WITH_VENDOR, mime: 'image/jpeg', sizeBytes: 1000 },
          }),
        ),
      );
      expect(ok.receipt.metadata.vendor).toBe(ocr.vendor);
      expect(ok.receipt.metadata.amountMinorUnits).toBe(1);
      expect(ok.receipt.metadata.currency).toBe('USD');
      expect(ok.receipt.metadata.transactionDate).toBe(ocr.transactionDate);
    });

    it('never invents notes — OCR has no opinion about them', async () => {
      const ok = expectOk(await server.submitReceipt(makeReq({ metadata: EMPTY_MD })));
      expect(ok.receipt.metadata.notes).toBeNull();
    });

    it('routes an uncertain reading to needsReview and a confident one to confirmed', async () => {
      const uncertain = expectOk(
        await server.submitReceipt(
          makeReq({
            idempotencyKey: 'u',
            file: { storageKey: UNCERTAIN_KEY, mime: 'image/jpeg', sizeBytes: 1000 },
          }),
        ),
      );
      expect(uncertain.receipt.state).toBe('needsReview');

      const confident = expectOk(
        await server.submitReceipt(
          makeReq({
            idempotencyKey: 'c',
            file: { storageKey: CONFIDENT_KEY, mime: 'image/jpeg', sizeBytes: 1000 },
          }),
        ),
      );
      expect(confident.receipt.state).toBe('confirmed');
    });

    it('is deterministic: the same blob always lands in the same state', async () => {
      const other = new FakeServer({ now: clock.now });
      const token = other.issueToken('usr_dana', 'northwind', HOUR);
      const a = expectOk(await server.submitReceipt(makeReq()));
      const b = expectOk(await other.submitReceipt(makeReq({ authToken: token })));
      expect(b.receipt).toEqual(a.receipt);
    });
  });

  // -------------------------------------------------------------------------
  describe('metadata semantics are enforced at the boundary', () => {
    const bad: { name: string; md: ReceiptMetadata }[] = [
      { name: 'a decimal amount masquerading as minor units', md: { ...HUMAN_MD, amountMinorUnits: 42.5 } },
      { name: 'a negative amount', md: { ...HUMAN_MD, amountMinorUnits: -1 } },
      { name: 'a lowercase currency', md: { ...HUMAN_MD, currency: 'usd' } },
      { name: 'a currency symbol', md: { ...HUMAN_MD, currency: '$' } },
      { name: 'an instant where a date-only belongs', md: { ...HUMAN_MD, transactionDate: '2026-08-11T00:00:00.000Z' } },
      { name: 'an unpadded date', md: { ...HUMAN_MD, transactionDate: '2026-8-1' } },
      { name: 'a date that does not exist', md: { ...HUMAN_MD, transactionDate: '2026-02-30' } },
      { name: 'month 13', md: { ...HUMAN_MD, transactionDate: '2026-13-01' } },
    ];

    it.each(bad)('rejects $name permanently', async ({ md }) => {
      const err = expectErr(await server.submitReceipt(makeReq({ metadata: md })));
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.retryable).toBe(false);
      expect(await probeNextReceiptId()).toBe('rec_1');
    });

    it('accepts a real leap day and a zero amount', async () => {
      const ok = expectOk(
        await server.submitReceipt(
          makeReq({ metadata: { ...HUMAN_MD, transactionDate: '2028-02-29', amountMinorUnits: 0 } }),
        ),
      );
      expect(ok.receipt.metadata.transactionDate).toBe('2028-02-29');
      expect(ok.receipt.metadata.amountMinorUnits).toBe(0);
    });

    it('rejects a non-leap-year 29 February', async () => {
      const err = expectErr(
        await server.submitReceipt(
          makeReq({ metadata: { ...HUMAN_MD, transactionDate: '2026-02-29' } }),
        ),
      );
      expect(err.code).toBe('SERVER_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  describe('transport failures', () => {
    it('does not send anything while offline', async () => {
      server.setNetworkMode('offline');
      const err = expectErr(await server.submitReceipt(makeReq()));
      expect(err.code).toBe('NETWORK_OFFLINE');
      expect(err.retryable).toBe(true);

      server.setNetworkMode('online');
      const ok = expectOk(await server.submitReceipt(makeReq()));
      expect(ok.receipt.id).toBe('rec_1');
      expect(ok.deduped).toBe(false); // nothing to dedupe — it never arrived
    });

    it('creates nothing when the transfer is cut off', async () => {
      server.setFailureInjection('transferInterrupted');
      const err = expectErr(await server.submitReceipt(makeReq()));
      expect(err.code).toBe('TRANSFER_INTERRUPTED');
      expect(err.retryable).toBe(true);

      server.setFailureInjection('none');
      expect(await probeNextReceiptId()).toBe('rec_1');
    });

    it('creates nothing on a server error and is safe to retry', async () => {
      server.setFailureInjection('serverError');
      const err = expectErr(await server.submitReceipt(makeReq()));
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.retryable).toBe(true);

      server.setFailureInjection('none');
      const ok = expectOk(await server.submitReceipt(makeReq()));
      expect(ok.receipt.id).toBe('rec_1');
      expect(ok.deduped).toBe(false);
    });

    it('does not claim a transaction when the request fails late', async () => {
      server.setFailureInjection('serverError');
      expectErr(await server.submitReceipt(makeReq({ matchTransactionId: 'txn_nw_01' })));
      server.setFailureInjection('none');
      const txns = await server.listTransactions('northwind', nwToken);
      expect(txns.find((t) => t.id === 'txn_nw_01')?.matchedReceiptId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('reads', () => {
    it('returns a receipt to its own company', async () => {
      const ok = expectOk(await server.submitReceipt(makeReq()));
      expect(await server.getReceipt(ok.receipt.id, 'northwind', nwToken)).toEqual(ok.receipt);
    });

    it('returns null for an unknown id rather than throwing', async () => {
      expect(await server.getReceipt('rec_999', 'northwind', nwToken)).toBeNull();
    });

    it('throws COMPANY_MISMATCH when the token is scoped elsewhere', async () => {
      const ok = expectOk(await server.submitReceipt(makeReq()));
      await expect(server.getReceipt(ok.receipt.id, 'northwind', acmeToken)).rejects.toMatchObject({
        code: 'COMPANY_MISMATCH',
        retryable: false,
      });
    });

    it('does not leak a receipt to another tenant even with a valid token', async () => {
      expectOk(await server.submitReceipt(makeReq()));
      // Acme asking for Acme's rec_1 — which happens to belong to northwind.
      expect(await server.getReceipt('rec_1', 'acme', acmeToken)).toBeNull();
    });

    it('throws AUTH_EXPIRED on a dead token and NETWORK_OFFLINE when offline', async () => {
      server.expireToken(nwToken);
      await expect(server.getReceipt('rec_1', 'northwind', nwToken)).rejects.toBeInstanceOf(
        FakeServerError,
      );

      server.setNetworkMode('offline');
      await expect(server.listTransactions('northwind', nwToken)).rejects.toMatchObject({
        code: 'NETWORK_OFFLINE',
        retryable: true,
      });
    });

    it('lists only the caller company transactions, newest first with a stable tiebreak', async () => {
      const txns = await server.listTransactions('northwind', nwToken);
      expect(txns.every((t) => t.companyId === 'northwind')).toBe(true);
      expect(txns.map((t) => t.id)).toEqual([
        'txn_nw_09',
        'txn_nw_08',
        'txn_nw_07',
        'txn_nw_05',
        // Same instant; id breaks the tie so the order is total.
        'txn_nw_04',
        'txn_nw_06',
        'txn_nw_03',
        'txn_nw_02',
        'txn_nw_01',
      ]);
    });

    it('refuses a cross-company transaction listing', async () => {
      await expect(server.listTransactions('acme', nwToken)).rejects.toMatchObject({
        code: 'COMPANY_MISMATCH',
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('confirmCorrections', () => {
    async function needsReviewReceipt(): Promise<Receipt> {
      const ok = expectOk(
        await server.submitReceipt(
          makeReq({
            metadata: EMPTY_MD,
            file: { storageKey: UNCERTAIN_KEY, mime: 'image/jpeg', sizeBytes: 1000 },
          }),
        ),
      );
      expect(ok.receipt.state).toBe('needsReview');
      return ok.receipt;
    }

    it('accepts corrections and confirms the receipt', async () => {
      const receipt = await needsReviewReceipt();
      const ok = expectOk(
        await server.confirmCorrections(receipt.id, 'northwind', nwToken, HUMAN_MD),
      );
      expect(ok.receipt.state).toBe('confirmed');
      expect(ok.receipt.metadata).toEqual(HUMAN_MD);
      expect(ok.deduped).toBe(false);
    });

    it('treats a null field as "not supplied", never as "erase"', async () => {
      const receipt = await needsReviewReceipt();
      const before = receipt.metadata;
      const ok = expectOk(
        await server.confirmCorrections(receipt.id, 'northwind', nwToken, {
          ...EMPTY_MD,
          vendor: 'Corrected Vendor',
        }),
      );
      expect(ok.receipt.metadata.vendor).toBe('Corrected Vendor');
      expect(ok.receipt.metadata.amountMinorUnits).toBe(before.amountMinorUnits);
      expect(ok.receipt.metadata.currency).toBe(before.currency);
      expect(ok.receipt.metadata.transactionDate).toBe(before.transactionDate);
    });

    it('is idempotent: confirming twice reports deduped and changes nothing', async () => {
      const receipt = await needsReviewReceipt();
      const first = expectOk(
        await server.confirmCorrections(receipt.id, 'northwind', nwToken, HUMAN_MD),
      );
      const second = expectOk(
        await server.confirmCorrections(receipt.id, 'northwind', nwToken, HUMAN_MD),
      );
      expect(second.deduped).toBe(true);
      expect(second.receipt).toEqual(first.receipt);
    });

    it('refuses a receipt belonging to another company', async () => {
      const receipt = await needsReviewReceipt();
      const err = expectErr(
        await server.confirmCorrections(receipt.id, 'acme', acmeToken, HUMAN_MD),
      );
      expect(err.code).toBe('COMPANY_MISMATCH');
      expect(err.retryable).toBe(false);
    });

    it('refuses an unknown receipt with the same non-disclosing answer', async () => {
      const err = expectErr(
        await server.confirmCorrections('rec_404', 'northwind', nwToken, HUMAN_MD),
      );
      expect(err.code).toBe('COMPANY_MISMATCH');
    });

    it('reports transport failures in-band', async () => {
      const receipt = await needsReviewReceipt();
      server.setNetworkMode('offline');
      expect(
        expectErr(await server.confirmCorrections(receipt.id, 'northwind', nwToken, HUMAN_MD)).code,
      ).toBe('NETWORK_OFFLINE');

      server.setNetworkMode('online');
      server.setFailureInjection('authExpired');
      expect(
        expectErr(await server.confirmCorrections(receipt.id, 'northwind', nwToken, HUMAN_MD)).code,
      ).toBe('AUTH_EXPIRED');
    });

    it('validates corrected metadata too', async () => {
      const receipt = await needsReviewReceipt();
      const err = expectErr(
        await server.confirmCorrections(receipt.id, 'northwind', nwToken, {
          ...HUMAN_MD,
          amountMinorUnits: 12.34,
        }),
      );
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.retryable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('determinism and reset', () => {
    it('stamps createdAt from the injected clock, not the wall clock', async () => {
      clock.advance(30 * 60 * 1000); // still inside the token's ttl
      const ok = expectOk(await server.submitReceipt(makeReq()));
      expect(ok.receipt.createdAt).toBe(clock.now());
      expect(ok.receipt.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('defaults to a fixed clock when none is injected', async () => {
      const fixed = new FakeServer();
      const token = fixed.issueToken('usr_dana', 'northwind', HOUR);
      const ok = expectOk(await fixed.submitReceipt(makeReq({ authToken: token })));
      expect(ok.receipt.createdAt).toBe(DEFAULT_NOW_ISO);
    });

    it('records createdBy from the token, not from the request', async () => {
      const kim = server.issueToken('usr_kim', 'northwind', HOUR);
      const ok = expectOk(await server.submitReceipt(makeReq({ authToken: kim })));
      expect(ok.receipt.createdBy).toBe('usr_kim');
    });

    it('reset() clears receipts, idempotency, injections and match state', async () => {
      server.setNetworkMode('offline');
      server.setFailureInjection('serverError');
      server.reset();

      const token = server.issueToken('usr_dana', 'northwind', HOUR);
      const ok = expectOk(
        await server.submitReceipt(makeReq({ authToken: token, matchTransactionId: 'txn_nw_01' })),
      );
      expect(ok.receipt.id).toBe('rec_1'); // counter restarted

      server.reset();
      const token2 = server.issueToken('usr_dana', 'northwind', HOUR);
      expect(await server.getReceipt('rec_1', 'northwind', token2)).toBeNull();
      const txns = await server.listTransactions('northwind', token2);
      expect(txns.every((t) => t.matchedReceiptId === null)).toBe(true);
      // The pre-reset token is gone, and its id was not recycled, so it cannot
      // come back to life as somebody else's session.
      expect(token2).not.toBe(token);
      await expect(server.getReceipt('rec_1', 'northwind', token)).rejects.toMatchObject({
        code: 'AUTH_EXPIRED',
      });
    });

    it('two servers replaying the same script agree exactly', async () => {
      const other = new FakeServer({ now: mutableClock(DEFAULT_NOW_ISO).now });
      const otherToken = other.issueToken('usr_dana', 'northwind', HOUR);
      const script = [
        makeReq({ idempotencyKey: 'a', matchTransactionId: 'txn_nw_01' }),
        makeReq({ idempotencyKey: 'b', metadata: HUMAN_MD }),
        makeReq({ idempotencyKey: 'a' }),
      ];
      for (const req of script) {
        const a = await server.submitReceipt(req);
        const b = await other.submitReceipt({ ...req, authToken: otherToken });
        expect(b).toEqual(a);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Seed data — the rows exist to make matching decisions visible
// ---------------------------------------------------------------------------

describe('seed data', () => {
  const rows = seedTransactions();
  const of = (companyId: string) => rows.filter((t) => t.companyId === companyId);

  it('defines at least two companies and users who can reach them', () => {
    expect(COMPANIES.length).toBeGreaterThanOrEqual(2);
    expect(COMPANIES.map((c) => c.id)).toEqual(expect.arrayContaining(['northwind', 'acme']));
    // At least one user in BOTH companies, so company switching is a real
    // scenario rather than something the app can forbid.
    const dual = USERS.filter(
      (u) => MEMBERSHIPS.filter((m) => m.userId === u.id).length >= 2,
    );
    expect(dual.length).toBeGreaterThanOrEqual(1);
    expect(MEMBERSHIPS.every((m) => USERS.some((u) => u.id === m.userId))).toBe(true);
    expect(MEMBERSHIPS.every((m) => COMPANIES.some((c) => c.id === m.companyId))).toBe(true);
  });

  it('uses unique ids and starts fully unmatched', () => {
    expect(new Set(rows.map((t) => t.id)).size).toBe(rows.length);
    expect(rows.every((t) => t.matchedReceiptId === null)).toBe(true);
  });

  it('returns fresh objects so a caller cannot poison the seed', () => {
    const a = seedTransactions();
    const b = seedTransactions();
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(b[0]);
  });

  it('stores amounts as integer minor units and instants as UTC', () => {
    for (const t of rows) {
      expect(Number.isSafeInteger(t.amountMinorUnits)).toBe(true);
      expect(t.amountMinorUnits).toBeGreaterThan(0);
      expect(t.currency).toMatch(/^[A-Z]{3}$/);
      expect(t.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  describe.each(['northwind', 'acme'])('%s has adversarial rows', (companyId) => {
    const rs = of(companyId);

    it('has several transactions', () => {
      expect(rs.length).toBeGreaterThanOrEqual(8);
    });

    it('has a pair from one merchant differing by exactly ONE minor unit', () => {
      const found = rs.some((a) =>
        rs.some(
          (b) =>
            a.id !== b.id &&
            a.merchant === b.merchant &&
            a.currency === b.currency &&
            Math.abs(a.amountMinorUnits - b.amountMinorUnits) === 1,
        ),
      );
      expect(found).toBe(true);
    });

    it('has a pair from one merchant a few dollars apart', () => {
      const found = rs.some((a) =>
        rs.some((b) => {
          const delta = Math.abs(a.amountMinorUnits - b.amountMinorUnits);
          return a.id !== b.id && a.merchant === b.merchant && delta >= 300 && delta <= 1000;
        }),
      );
      expect(found).toBe(true);
    });

    it('has the same merchant and amount on two calendar days', () => {
      const DAY = 24 * 60 * 60 * 1000;
      const found = rs.some((a) =>
        rs.some(
          (b) =>
            a.id !== b.id &&
            a.merchant === b.merchant &&
            a.amountMinorUnits === b.amountMinorUnits &&
            Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) === DAY,
        ),
      );
      expect(found).toBe(true);
    });

    it('has the same amount at the same instant from different merchants', () => {
      const found = rs.some((a) =>
        rs.some(
          (b) =>
            a.id !== b.id &&
            a.merchant !== b.merchant &&
            a.amountMinorUnits === b.amountMinorUnits &&
            a.occurredAt === b.occurredAt,
        ),
      );
      expect(found).toBe(true);
    });

    it('has a zero-decimal (JPY) row', () => {
      const jpy = rs.filter((t) => t.currency === 'JPY');
      expect(jpy.length).toBeGreaterThanOrEqual(1);
      // A JPY amount that is not a round hundred is the proof that these are
      // yen, not "cents" that someone will divide by 100 on the way out.
      expect(jpy.every((t) => Number.isSafeInteger(t.amountMinorUnits))).toBe(true);
    });

    it('has a genuinely ambiguous near-duplicate pair minutes apart', () => {
      const pairs = rs.flatMap((a) =>
        rs
          .filter(
            (b) =>
              a.id < b.id &&
              a.merchant === b.merchant &&
              a.amountMinorUnits === b.amountMinorUnits &&
              a.currency === b.currency,
          )
          .map((b) => Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt))),
      );
      // Same merchant, same amount, same currency, under ten minutes apart:
      // nothing in the data can separate them, so the app must ask.
      expect(pairs.some((delta) => delta > 0 && delta <= 10 * 60 * 1000)).toBe(true);
    });
  });
});
