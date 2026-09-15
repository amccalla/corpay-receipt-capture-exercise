/// <reference types="jest" />
// The project tsconfig extends expo/tsconfig.base, which does not put "jest" on
// `types`, so `describe`/`it`/`expect` are otherwise unresolved under `tsc
// --noEmit`. Referenced here rather than editing shared config.

import { EMPTY_PROVENANCE, type ReceiptDraft } from '../types';
import {
  IDEMPOTENCY_KEY_TTL_HOURS,
  type RandomSource,
  type SubmissionIntent,
  intentFingerprint,
  isIdempotencyKey,
  newIdempotencyKey,
  newLocalId,
  shouldRotateIdempotencyKey,
} from '../ids';

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a small, fully deterministic PRNG. Same seed, same stream, on
 * every machine and every run. Lives in the test, not the module: production
 * should inject a CSPRNG.
 */
function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A source that replays a fixed list, cycling — for boundary values. */
function cycling(values: readonly number[]): RandomSource {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v === undefined ? 0 : v;
  };
}

const LOCAL_ID_RE = /^rcp_[A-Za-z0-9_-]{22}$/;
const IDEM_RE = /^idem_[A-Za-z0-9_-]{32}$/;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INTENT: SubmissionIntent = {
  fileUri: 'file:///sandbox/receipts/rcp_a.heic',
  vendor: 'Blue Bottle Coffee',
  amountMinorUnits: 1899,
  currency: 'USD',
  transactionDate: '2026-08-11',
  matchTransactionId: 'txn_7781',
};

function makeDraft(over: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    localId: 'rcp_0000000000000000000000',
    companyId: 'co_acme',
    fileUri: 'file:///sandbox/receipts/rcp_a.heic',
    fileName: 'rcp_a.heic',
    fileMimeType: 'image/heic',
    fileSizeBytes: 4_194_304,
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: 1899,
    currency: 'USD',
    transactionDate: '2026-08-11',
    notes: null,
    state: 'queued',
    idempotencyKey: 'idem_00000000000000000000000000000000',
    serverReceiptId: null,
    matchedTransactionId: null,
    pendingMatchTransactionId: 'txn_7781',
    provenance: EMPTY_PROVENANCE,
    lastError: null,
    lastErrorRetryable: false,
    attemptCount: 0,
    createdAt: '2026-08-11T14:03:22.000Z',
    updatedAt: '2026-08-11T14:03:22.000Z',
    lastServerSyncAt: null,
    ...over,
  };
}

/**
 * Projection a caller performs before asking about rotation. Written here (not
 * exported from the module) to prove the intent type is sufficient on its own —
 * and note that `notes` has nowhere to go.
 */
function intentOf(d: ReceiptDraft): SubmissionIntent {
  return {
    fileUri: d.fileUri,
    vendor: d.vendor,
    amountMinorUnits: d.amountMinorUnits,
    currency: d.currency,
    transactionDate: d.transactionDate,
    matchTransactionId: d.pendingMatchTransactionId ?? d.matchedTransactionId,
  };
}

// ---------------------------------------------------------------------------
// newLocalId / newIdempotencyKey
// ---------------------------------------------------------------------------

describe('newLocalId', () => {
  it('produces a prefixed, url-safe id of the documented shape', () => {
    const id = newLocalId(seeded(1));
    expect(id).toMatch(LOCAL_ID_RE);
    expect(id).toHaveLength(4 + 22);
    expect(encodeURIComponent(id)).toBe(id); // safe in a path or query segment
  });

  it('is deterministic for a given seeded source', () => {
    expect(newLocalId(seeded(42))).toBe(newLocalId(seeded(42)));
  });

  it('differs across seeds and consecutive draws from one source', () => {
    expect(newLocalId(seeded(42))).not.toBe(newLocalId(seeded(43)));
    const rand = seeded(7);
    expect(newLocalId(rand)).not.toBe(newLocalId(rand));
  });

  it('draws unique ids across many consecutive calls', () => {
    const rand = seeded(2026);
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(newLocalId(rand));
    expect(seen.size).toBe(20_000);
  });

  it('cannot be mistaken for an idempotency key', () => {
    expect(isIdempotencyKey(newLocalId(seeded(3)))).toBe(false);
  });
});

describe('newIdempotencyKey', () => {
  it('produces a key of the documented shape that validates', () => {
    const key = newIdempotencyKey(seeded(1));
    expect(key).toMatch(IDEM_RE);
    expect(key).toHaveLength(5 + 32);
    expect(isIdempotencyKey(key)).toBe(true);
  });

  it('is deterministic for a given seeded source', () => {
    expect(newIdempotencyKey(seeded(99))).toBe(newIdempotencyKey(seeded(99)));
  });

  it('draws unique keys across many consecutive calls', () => {
    const rand = seeded(31_337);
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(newIdempotencyKey(rand));
    expect(seen.size).toBe(20_000);
  });

  it('is longer than the local id — collisions here cost more', () => {
    expect(newIdempotencyKey(seeded(1)).length).toBeGreaterThan(newLocalId(seeded(1)).length);
  });
});

describe('id generation with a hostile RandomSource', () => {
  // A RandomSource is injected, so it is untrusted input. Out-of-contract values
  // must still yield a well-formed id rather than a short, collision-prone one.
  const hostile: ReadonlyArray<readonly [string, number]> = [
    ['exactly 0 (first char)', 0],
    ['exactly 1 (out of [0,1))', 1],
    ['greater than 1', 17.5],
    ['negative', -0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  it.each(hostile)('stays well-formed when the source returns %s', (_label, value) => {
    expect(newLocalId(cycling([value]))).toMatch(LOCAL_ID_RE);
    expect(isIdempotencyKey(newIdempotencyKey(cycling([value])))).toBe(true);
  });

  it('maps the extremes to the first and last alphabet characters', () => {
    expect(newLocalId(cycling([0]))).toBe('rcp_' + 'A'.repeat(22));
    // 0.9999… and the out-of-range 1 both clamp to the last character.
    expect(newLocalId(cycling([0.999999]))).toBe('rcp_' + '_'.repeat(22));
    expect(newLocalId(cycling([1]))).toBe('rcp_' + '_'.repeat(22));
  });
});

// ---------------------------------------------------------------------------
// isIdempotencyKey
// ---------------------------------------------------------------------------

describe('isIdempotencyKey', () => {
  const body = 'a'.repeat(32);

  it('accepts every character of the url-safe alphabet', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    expect(isIdempotencyKey('idem_' + alphabet.slice(0, 32))).toBe(true);
    expect(isIdempotencyKey('idem_' + alphabet.slice(32))).toBe(true);
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['empty string', ''],
    ['prefix only', 'idem_'],
    ['one char short', 'idem_' + 'a'.repeat(31)],
    ['one char long', 'idem_' + 'a'.repeat(33)],
    ['missing prefix', body],
    ['wrong prefix', 'rcp_' + body],
    ['uppercase prefix', 'IDEM_' + body],
    ['base64 padding', 'idem_' + 'a'.repeat(30) + '=='],
    ['base64 non-url-safe +', 'idem_' + 'a'.repeat(31) + '+'],
    ['base64 non-url-safe /', 'idem_' + 'a'.repeat(31) + '/'],
    ['leading whitespace', ' idem_' + body],
    ['trailing whitespace', 'idem_' + body + ' '],
    ['trailing newline', 'idem_' + body + '\n'],
    ['newline then a valid key', 'garbage\nidem_' + body],
    ['embedded separator', 'idem_' + 'a'.repeat(16) + '.' + 'a'.repeat(15)],
  ];

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(isIdempotencyKey(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// intentFingerprint
// ---------------------------------------------------------------------------

describe('intentFingerprint', () => {
  it('is pure — repeated calls agree', () => {
    expect(intentFingerprint(BASE_INTENT)).toBe(intentFingerprint(BASE_INTENT));
  });

  it('does not depend on the key order of the object literal', () => {
    const reordered: SubmissionIntent = {
      matchTransactionId: BASE_INTENT.matchTransactionId,
      currency: BASE_INTENT.currency,
      vendor: BASE_INTENT.vendor,
      transactionDate: BASE_INTENT.transactionDate,
      fileUri: BASE_INTENT.fileUri,
      amountMinorUnits: BASE_INTENT.amountMinorUnits,
    };
    expect(intentFingerprint(reordered)).toBe(intentFingerprint(BASE_INTENT));
    expect(shouldRotateIdempotencyKey(BASE_INTENT, reordered)).toBe(false);
  });

  it('survives a JSON round-trip, which does not preserve authored key order', () => {
    const parsed: unknown = JSON.parse(JSON.stringify(BASE_INTENT));
    // Justified assertion: the value is structurally our own intent, just
    // round-tripped through storage; this mirrors reading a persisted draft back.
    const revived = parsed as SubmissionIntent;
    expect(intentFingerprint(revived)).toBe(intentFingerprint(BASE_INTENT));
  });

  it('cannot be forged by a value that looks like another field', () => {
    // Field separators must be escaped, or a vendor could impersonate an amount.
    const a = intentFingerprint({ ...BASE_INTENT, vendor: 'x&amountMinorUnits=:1', amountMinorUnits: null });
    const b = intentFingerprint({ ...BASE_INTENT, vendor: 'x', amountMinorUnits: 1 });
    expect(a).not.toBe(b);
  });

  it('distinguishes an absent value from a value that looks absent', () => {
    const absent = intentFingerprint({ ...BASE_INTENT, vendor: null });
    const literalDash = intentFingerprint({ ...BASE_INTENT, vendor: '-' });
    expect(absent).not.toBe(literalDash);
  });

  it('is a single line with no user text leaking structure', () => {
    const fp = intentFingerprint({ ...BASE_INTENT, vendor: 'multi\nline\tvendor' });
    expect(fp).not.toContain('\n');
    expect(fp).not.toContain('\t');
  });

  it('carries a version marker so stored fingerprints are not silently reinterpreted', () => {
    expect(intentFingerprint(BASE_INTENT).startsWith('v1|')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldRotateIdempotencyKey — rotation
// ---------------------------------------------------------------------------

describe('shouldRotateIdempotencyKey — substantive changes rotate', () => {
  const changes: ReadonlyArray<readonly [keyof SubmissionIntent, SubmissionIntent]> = [
    ['fileUri', { ...BASE_INTENT, fileUri: 'file:///sandbox/receipts/rcp_b.heic' }],
    ['vendor', { ...BASE_INTENT, vendor: 'Blue Bottle Coffee Co.' }],
    ['amountMinorUnits', { ...BASE_INTENT, amountMinorUnits: 1999 }],
    ['currency', { ...BASE_INTENT, currency: 'EUR' }],
    ['transactionDate', { ...BASE_INTENT, transactionDate: '2026-08-12' }],
    ['matchTransactionId', { ...BASE_INTENT, matchTransactionId: 'txn_9002' }],
  ];

  it.each(changes)('rotates when %s changes', (_field, next) => {
    expect(shouldRotateIdempotencyKey(BASE_INTENT, next)).toBe(true);
  });

  it('covers every field of SubmissionIntent', () => {
    // Guard against a field being added to the contract and silently left out of
    // the fingerprint — which would let a real edit dedupe against the old record.
    const covered = new Set(changes.map(([field]) => field));
    expect(new Set(Object.keys(BASE_INTENT))).toEqual(covered);
  });

  it('rotates when a field is cleared, not just when it is replaced', () => {
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, vendor: null })).toBe(true);
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, matchTransactionId: null })).toBe(true);
  });

  it('rotates when a zero amount replaces an absent one — 0 is a real amount', () => {
    const absent: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: null };
    const zero: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: 0 };
    expect(shouldRotateIdempotencyKey(absent, zero)).toBe(true);
  });

  it('rotates on a sign flip — a refund is not the same submission as a charge', () => {
    const charge: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: 1899 };
    const refund: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: -1899 };
    expect(shouldRotateIdempotencyKey(charge, refund)).toBe(true);
  });

  it('rotates on an off-by-one minor unit — the smallest correction that matters', () => {
    expect(
      shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, amountMinorUnits: 1900 }),
    ).toBe(true);
  });

  it('rotates on a currency change that leaves the number alone (1899 JPY is not 1899 USD)', () => {
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, currency: 'JPY' })).toBe(true);
  });

  it('rotates when a date-only value is replaced by a timestamp — different semantics', () => {
    // Dates are compared as opaque calendar strings; we never parse one into an
    // instant, so these are simply different values and must rotate.
    expect(
      shouldRotateIdempotencyKey(BASE_INTENT, {
        ...BASE_INTENT,
        transactionDate: '2026-08-11T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rotates when the user re-targets a match (edge case: two receipts, one transaction)', () => {
    // Re-pointing at a different transaction is a different submission; reusing
    // the key would make the server return the match against the OLD transaction.
    const retarget: SubmissionIntent = { ...BASE_INTENT, matchTransactionId: 'txn_0001' };
    expect(shouldRotateIdempotencyKey(BASE_INTENT, retarget)).toBe(true);
  });

  it('rotates after an OCR-era correction of vendor AND amount', () => {
    const corrected: SubmissionIntent = {
      ...BASE_INTENT,
      vendor: 'Blue Bottle',
      amountMinorUnits: 2150,
    };
    expect(shouldRotateIdempotencyKey(BASE_INTENT, corrected)).toBe(true);
  });

  it('rotates on a vendor case change — case can carry a real correction', () => {
    // Conservative by design: merging these would risk discarding an edit, and
    // the cost of rotating is only that the server sees a genuinely new key.
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, vendor: 'BLUE BOTTLE COFFEE' })).toBe(
      true,
    );
  });

  it('is symmetric — undoing an edit rotates back to a new key too', () => {
    const edited: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: 42 };
    expect(shouldRotateIdempotencyKey(BASE_INTENT, edited)).toBe(
      shouldRotateIdempotencyKey(edited, BASE_INTENT),
    );
  });
});

// ---------------------------------------------------------------------------
// shouldRotateIdempotencyKey — no rotation
// ---------------------------------------------------------------------------

describe('shouldRotateIdempotencyKey — retries and cosmetic edits do not rotate', () => {
  it('does not rotate for a pure retry of an identical intent', () => {
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT })).toBe(false);
  });

  it('does not rotate when only notes changed — notes are not part of the submission', () => {
    const before = makeDraft({ notes: null });
    const after = makeDraft({ notes: 'Client lunch, reimbursable' });
    expect(shouldRotateIdempotencyKey(intentOf(before), intentOf(after))).toBe(false);
  });

  it('does not rotate when only non-substantive draft fields changed', () => {
    // Retry bookkeeping, error text and timestamps describe the sending, not the
    // thing sent. A failed attempt must retry under the SAME key.
    const before = makeDraft({ state: 'uploading', attemptCount: 1 });
    const after = makeDraft({
      state: 'failed',
      attemptCount: 2,
      lastError: 'Network request timed out',
      lastErrorRetryable: true,
      updatedAt: '2026-08-11T14:09:00.000Z',
    });
    expect(shouldRotateIdempotencyKey(intentOf(before), intentOf(after))).toBe(false);
  });

  it('does not rotate when the company changed — that must block the upload, not re-key it', () => {
    // Deliberate: rotating would say "this is a new submission, send it", which is
    // exactly the wrong answer after a company switch or logout.
    const before = makeDraft({ companyId: 'co_acme' });
    const after = makeDraft({ companyId: 'co_globex' });
    expect(shouldRotateIdempotencyKey(intentOf(before), intentOf(after))).toBe(false);
  });

  it('does not rotate for surrounding whitespace on a text field', () => {
    const padded: SubmissionIntent = { ...BASE_INTENT, vendor: '  Blue Bottle Coffee\n' };
    expect(shouldRotateIdempotencyKey(BASE_INTENT, padded)).toBe(false);
  });

  it('treats blank, whitespace-only and null as the same absent value', () => {
    const nulled: SubmissionIntent = { ...BASE_INTENT, vendor: null };
    const empty: SubmissionIntent = { ...BASE_INTENT, vendor: '' };
    const spaces: SubmissionIntent = { ...BASE_INTENT, vendor: '   ' };
    expect(shouldRotateIdempotencyKey(nulled, empty)).toBe(false);
    expect(shouldRotateIdempotencyKey(empty, spaces)).toBe(false);
  });

  it('does not rotate for currency case — ISO 4217 codes are case-insensitive', () => {
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, currency: 'usd' })).toBe(false);
    expect(shouldRotateIdempotencyKey(BASE_INTENT, { ...BASE_INTENT, currency: ' Usd ' })).toBe(false);
  });

  it('does not rotate for a signed zero', () => {
    const zero: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: 0 };
    const negZero: SubmissionIntent = { ...BASE_INTENT, amountMinorUnits: -0 };
    expect(shouldRotateIdempotencyKey(zero, negZero)).toBe(false);
  });

  it('survives the lost-success-response replay: queue, fail, relaunch, retry — one key', () => {
    // Edge case 1. The file reached the server; only the response was lost. Every
    // later attempt must present the key the server already knows.
    const captured = makeDraft({ state: 'queued', attemptCount: 0 });
    const attempted = makeDraft({ state: 'uploading', attemptCount: 1 });
    const lost = makeDraft({
      state: 'failed',
      attemptCount: 1,
      lastError: 'Socket closed before response',
      lastErrorRetryable: true,
    });
    const relaunched = makeDraft({ state: 'queued', attemptCount: 1 });

    const chain = [captured, attempted, lost, relaunched].map(intentOf);
    for (let i = 1; i < chain.length; i += 1) {
      const prev = chain[i - 1];
      const next = chain[i];
      if (prev === undefined || next === undefined) throw new Error('bad fixture');
      expect(shouldRotateIdempotencyKey(prev, next)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Key lifetime
// ---------------------------------------------------------------------------

describe('IDEMPOTENCY_KEY_TTL_HOURS', () => {
  it('is a whole number of hours long enough to cover an overnight offline queue', () => {
    expect(Number.isInteger(IDEMPOTENCY_KEY_TTL_HOURS)).toBe(true);
    expect(IDEMPOTENCY_KEY_TTL_HOURS).toBeGreaterThanOrEqual(12);
    expect(IDEMPOTENCY_KEY_TTL_HOURS).toBe(24);
  });
});
