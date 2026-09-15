/**
 * Tests for receipt -> card-transaction matching.
 *
 * The seeded transactions here are deliberately CLOSE BUT NOT IDENTICAL — same
 * merchant with a settlement-day lag, same day with a small amount drift, same
 * money with a different merchant — because that is the only way the scoring
 * decisions are observable. A fixture set where one row matches perfectly and
 * the rest are obvious garbage would pass without proving anything.
 */

import {
  canAssignMatch,
  findMatchCandidates,
  isExactMatch,
  normalizeMerchant,
  scoreMatch,
  type MatchCandidate,
} from '../matching';
import { EMPTY_PROVENANCE, type ReceiptDraft, type Transaction } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY = 'co-acme';
const OTHER_COMPANY = 'co-globex';

const BASE_DRAFT: ReceiptDraft = {
  localId: 'r-local-1',
  companyId: COMPANY,
  fileUri: 'file:///sandbox/receipts/r1.jpg',
  fileName: 'r1.jpg',
  fileMimeType: 'image/jpeg',
  fileSizeBytes: 204_800,
  vendor: 'Blue Bottle Coffee',
  amountMinorUnits: 1899,
  currency: 'USD',
  transactionDate: '2026-08-11',
  notes: null,
  state: 'draft',
  idempotencyKey: 'idem-aaaa-1111',
  serverReceiptId: null,
  matchedTransactionId: null,
  pendingMatchTransactionId: null,
  provenance: EMPTY_PROVENANCE,
  lastError: null,
  lastErrorRetryable: false,
  attemptCount: 0,
  createdAt: '2026-08-11T18:00:00.000Z',
  updatedAt: '2026-08-11T18:00:00.000Z',
  lastServerSyncAt: null,
};

const BASE_TXN: Transaction = {
  id: 'txn-200',
  companyId: COMPANY,
  merchant: 'Blue Bottle Coffee',
  amountMinorUnits: 1899,
  currency: 'USD',
  // Cleared mid-afternoon UTC on the same calendar day the receipt was printed.
  occurredAt: '2026-08-11T15:22:00.000Z',
  matchedReceiptId: null,
};

const draftWith = (patch: Partial<ReceiptDraft>): ReceiptDraft => ({ ...BASE_DRAFT, ...patch });
const txnWith = (patch: Partial<Transaction>): Transaction => ({ ...BASE_TXN, ...patch });
const ids = (cs: MatchCandidate[]): string[] => cs.map((c) => c.transaction.id);

/** Fetch one candidate by transaction id, failing loudly if it is absent. */
function pick(cs: MatchCandidate[], id: string): MatchCandidate {
  const found = cs.find((c) => c.transaction.id === id);
  if (found === undefined) throw new Error(`expected a candidate for ${id}, got [${ids(cs).join(', ')}]`);
  return found;
}

/** Close-but-not-identical seed set, mirroring the brief's requirement. */
const SEEDED: Transaction[] = [
  // Perfect: same money, same day, same merchant.
  txnWith({ id: 'txn-200' }),
  // Same day and merchant, 50c off — a small fee or rounding difference.
  txnWith({ id: 'txn-300', amountMinorUnits: 1949 }),
  // Same money and day, unrelated merchant.
  txnWith({ id: 'txn-400', merchant: 'Bluebird Taxi Service' }),
  // Same money and merchant, settled two days later.
  txnWith({ id: 'txn-500', occurredAt: '2026-08-13T09:00:00.000Z' }),
  // Same number, different currency — not comparable money.
  txnWith({ id: 'txn-600', currency: 'EUR' }),
  // Perfect match belonging to ANOTHER company.
  txnWith({ id: 'txn-700', companyId: OTHER_COMPANY }),
];

// ---------------------------------------------------------------------------
// normalizeMerchant
// ---------------------------------------------------------------------------

describe('normalizeMerchant', () => {
  it('casefolds and collapses punctuation to single spaces', () => {
    expect(normalizeMerchant('  Blue   Bottle-Coffee  ')).toBe('BLUE BOTTLE COFFEE');
  });

  it('strips diacritics so accented receipts match unaccented statements', () => {
    expect(normalizeMerchant('Café München')).toBe('CAFE MUNCHEN');
  });

  it('deletes periods and apostrophes instead of splitting on them', () => {
    expect(normalizeMerchant("McDonald's")).toBe('MCDONALDS');
    // "L.L.C." must collapse to the LLC token so the noise filter can see it.
    expect(normalizeMerchant('Acme L.L.C.')).toBe('ACME');
  });

  it('strips legal-form and filler tokens', () => {
    expect(normalizeMerchant('ACME Widgets, Inc.')).toBe('ACME WIDGETS');
    expect(normalizeMerchant('The Home Depot')).toBe('HOME DEPOT');
    expect(normalizeMerchant('Nakatomi Trading Co Ltd')).toBe('NAKATOMI TRADING');
  });

  it('strips store numbers, ZIP codes and a trailing state code', () => {
    expect(normalizeMerchant('Starbucks Store 1234 Seattle WA 98101')).toBe('STARBUCKS SEATTLE');
    expect(normalizeMerchant("McDonald's #4021 Austin TX")).toBe('MCDONALDS AUSTIN');
  });

  it('keeps a LEADING number, which is part of the brand not a store id', () => {
    expect(normalizeMerchant('7-Eleven 32104 Austin TX')).toBe('7 ELEVEN AUSTIN');
    expect(normalizeMerchant('99 Ranch Market 233')).toBe('99 RANCH MARKET');
  });

  it('strips the acquirer tag card networks put before an asterisk', () => {
    expect(normalizeMerchant('SQ *Blue Bottle Coffee Seattle WA')).toBe('BLUE BOTTLE COFFEE SEATTLE');
    expect(normalizeMerchant('TST* The Pickle Jar')).toBe('PICKLE JAR');
    expect(normalizeMerchant('PAYPAL *STEAM GAMES')).toBe('STEAM GAMES');
  });

  it('never returns empty for a name made entirely of noise tokens', () => {
    // '' would silently match every other over-stripped name, which is worse
    // than keeping a low-signal name. 'CO' is doubly ambiguous here — legal
    // suffix and Colorado — so this is the case that exercises the fallback.
    expect(normalizeMerchant('The Co')).toBe('THE CO');
    expect(normalizeMerchant('Ltd')).toBe('LTD');
  });

  it('returns empty only for input with no alphanumerics at all', () => {
    expect(normalizeMerchant('')).toBe('');
    expect(normalizeMerchant('   ')).toBe('');
    expect(normalizeMerchant('--- ***')).toBe('');
  });

  it('is idempotent', () => {
    const samples = [
      'SQ *Blue Bottle Coffee Seattle WA',
      "McDonald's #4021 Austin TX",
      'ACME Widgets, Inc.',
      'The Co',
      '',
    ];
    for (const s of samples) {
      expect(normalizeMerchant(normalizeMerchant(s))).toBe(normalizeMerchant(s));
    }
  });
});

// ---------------------------------------------------------------------------
// isExactMatch
// ---------------------------------------------------------------------------

describe('isExactMatch', () => {
  it('is true for equal amount, equal currency and the same calendar day', () => {
    expect(isExactMatch(BASE_DRAFT, BASE_TXN)).toBe(true);
  });

  it('ignores the merchant string entirely', () => {
    expect(isExactMatch(BASE_DRAFT, txnWith({ merchant: 'SQ *BLUEBOTTLE 1123 OAKLAND CA' }))).toBe(true);
  });

  it('is false one minor unit away — money equality is exact, never fuzzy', () => {
    expect(isExactMatch(BASE_DRAFT, txnWith({ amountMinorUnits: 1898 }))).toBe(false);
    expect(isExactMatch(BASE_DRAFT, txnWith({ amountMinorUnits: 1900 }))).toBe(false);
  });

  it('is false across currencies even when the number is identical', () => {
    expect(isExactMatch(BASE_DRAFT, txnWith({ currency: 'EUR' }))).toBe(false);
  });

  it('is false one day away', () => {
    expect(isExactMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-12T00:05:00.000Z' }))).toBe(false);
  });

  it('is false whenever a field is unknown — "unknown" is not "equal"', () => {
    expect(isExactMatch(draftWith({ amountMinorUnits: null }), BASE_TXN)).toBe(false);
    expect(isExactMatch(draftWith({ currency: null }), BASE_TXN)).toBe(false);
    expect(isExactMatch(draftWith({ transactionDate: null }), BASE_TXN)).toBe(false);
  });

  it('normalizes currency case rather than throwing or mismatching', () => {
    expect(isExactMatch(draftWith({ currency: 'usd' }), BASE_TXN)).toBe(true);
  });

  it('is false, not throwing, on malformed date input from OCR or a server', () => {
    expect(isExactMatch(draftWith({ transactionDate: '2026-02-30' }), BASE_TXN)).toBe(false);
    expect(isExactMatch(BASE_DRAFT, txnWith({ occurredAt: 'yesterday-ish' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreMatch
// ---------------------------------------------------------------------------

describe('scoreMatch', () => {
  it('scores a perfect match 100 with every reason, in a stable order', () => {
    const c = scoreMatch(BASE_DRAFT, BASE_TXN);
    expect(c.score).toBe(100);
    expect(c.reasons).toEqual(['AMOUNT_EXACT', 'CURRENCY_MATCH', 'MERCHANT_EXACT', 'DATE_EXACT']);
    expect(c.isExact).toBe(true);
    expect(c.blocked).toBe(false);
    expect(c.blockedReason).toBeNull();
  });

  describe('currency', () => {
    it('scores a mismatch 0 with no reasons, whatever else agrees', () => {
      // Identical merchant, identical day, identical number — and still 0,
      // because EUR 18.99 and USD 18.99 are not comparable amounts.
      const c = scoreMatch(BASE_DRAFT, txnWith({ currency: 'EUR' }));
      expect(c.score).toBe(0);
      expect(c.reasons).toEqual([]);
      expect(c.isExact).toBe(false);
    });

    it('treats an UNKNOWN currency as uncomparable money, not as a mismatch', () => {
      // A bare 1899 is not money, so it earns no amount points — but merchant
      // and date evidence still stands.
      const c = scoreMatch(draftWith({ currency: null }), BASE_TXN);
      expect(c.reasons).toEqual(['MERCHANT_EXACT', 'DATE_EXACT']);
      expect(c.score).toBe(40);
    });

    it('compares codes case-insensitively', () => {
      expect(scoreMatch(draftWith({ currency: 'usd' }), BASE_TXN).score).toBe(100);
    });
  });

  describe('amount', () => {
    it('awards AMOUNT_NEAR at exactly the 5% boundary and nothing past it', () => {
      const txn = txnWith({ amountMinorUnits: 10_000 });
      const inside = scoreMatch(draftWith({ amountMinorUnits: 9_500 }), txn); // 5.00%
      const outside = scoreMatch(draftWith({ amountMinorUnits: 9_499 }), txn); // 5.01%
      expect(inside.reasons).toContain('AMOUNT_NEAR');
      expect(outside.reasons).not.toContain('AMOUNT_NEAR');
      expect(outside.reasons).not.toContain('AMOUNT_EXACT');
    });

    it('ranks a smaller drift above a larger one', () => {
      const txn = txnWith({ amountMinorUnits: 10_000 });
      const close = scoreMatch(draftWith({ amountMinorUnits: 9_990 }), txn);
      const far = scoreMatch(draftWith({ amountMinorUnits: 9_600 }), txn);
      expect(close.score).toBeGreaterThan(far.score);
    });

    it('handles a zero-amount transaction without dividing by zero', () => {
      const zeroTxn = txnWith({ amountMinorUnits: 0 });
      const c = scoreMatch(BASE_DRAFT, zeroTxn);
      expect(Number.isFinite(c.score)).toBe(true);
      expect(c.reasons).not.toContain('AMOUNT_NEAR');
      expect(scoreMatch(draftWith({ amountMinorUnits: 0 }), zeroTxn).reasons).toContain('AMOUNT_EXACT');
    });

    it('awards nothing when the amount is unknown', () => {
      const c = scoreMatch(draftWith({ amountMinorUnits: null }), BASE_TXN);
      expect(c.reasons).toEqual(['CURRENCY_MATCH', 'MERCHANT_EXACT', 'DATE_EXACT']);
    });
  });

  describe('merchant', () => {
    it('treats a tokenization-only difference as exact', () => {
      expect(scoreMatch(draftWith({ vendor: 'Wal-Mart' }), txnWith({ merchant: 'WALMART' })).reasons).toContain(
        'MERCHANT_EXACT',
      );
    });

    it('treats a statement-decorated version of the same name as fuzzy', () => {
      const c = scoreMatch(
        draftWith({ vendor: 'Starbucks' }),
        txnWith({ merchant: 'SQ *STARBUCKS PIKE PLACE MARKET SEATTLE WA' }),
      );
      expect(c.reasons).toContain('MERCHANT_FUZZY');
      expect(c.reasons).not.toContain('MERCHANT_EXACT');
    });

    it('does not pair genuinely different merchants that share a prefix', () => {
      const c = scoreMatch(draftWith({ vendor: 'Blue Bottle Coffee' }), txnWith({ merchant: 'Bluebird Taxi Service' }));
      expect(c.reasons).not.toContain('MERCHANT_FUZZY');
      expect(c.reasons).not.toContain('MERCHANT_EXACT');
    });

    it('awards nothing for an unknown or blank vendor', () => {
      expect(scoreMatch(draftWith({ vendor: null }), BASE_TXN).reasons).not.toContain('MERCHANT_EXACT');
      expect(scoreMatch(draftWith({ vendor: '' }), BASE_TXN).reasons).not.toContain('MERCHANT_EXACT');
      // Two over-stripped empty names must not be "exactly equal" to each other.
      expect(scoreMatch(draftWith({ vendor: '***' }), txnWith({ merchant: '###' })).reasons).toEqual([
        'AMOUNT_EXACT',
        'CURRENCY_MATCH',
        'DATE_EXACT',
      ]);
    });
  });

  describe('date', () => {
    it('accepts settlement lag up to the default tolerance and rejects past it', () => {
      const within = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-14T09:00:00.000Z' })); // +3
      const beyond = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-15T09:00:00.000Z' })); // +4
      expect(within.reasons).toContain('DATE_NEAR');
      expect(beyond.reasons).not.toContain('DATE_NEAR');
      expect(beyond.reasons).not.toContain('DATE_EXACT');
    });

    it('decays with drift, so a nearer day always outranks a further one', () => {
      const d1 = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-12T09:00:00.000Z' })).score;
      const d2 = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-13T09:00:00.000Z' })).score;
      const d3 = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-14T09:00:00.000Z' })).score;
      expect(d1).toBeGreaterThan(d2);
      expect(d2).toBeGreaterThan(d3);
      expect(d3).toBeGreaterThan(scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-15T09:00:00.000Z' })).score);
    });

    it('matches a receipt dated AFTER the clearing instant too (tolerance is symmetric)', () => {
      const c = scoreMatch(draftWith({ transactionDate: '2026-08-13' }), BASE_TXN);
      expect(c.reasons).toContain('DATE_NEAR');
    });

    it('honours an explicit tolerance of 0 (same day only)', () => {
      const c = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-12T09:00:00.000Z' }), { dateToleranceDays: 0 });
      expect(c.reasons).not.toContain('DATE_NEAR');
    });

    it('degrades a nonsensical tolerance to same-day instead of throwing', () => {
      // dates.ts throws on a negative window; scoring runs on every keystroke
      // and must not take the app down over a bad prop.
      expect(() => scoreMatch(BASE_DRAFT, BASE_TXN, { dateToleranceDays: -5 })).not.toThrow();
      const c = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-12T09:00:00.000Z' }), {
        dateToleranceDays: -5,
      });
      expect(c.reasons).not.toContain('DATE_NEAR');
    });

    it('floors a fractional tolerance', () => {
      const opts = { dateToleranceDays: 2.9 };
      expect(scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-13T09:00:00.000Z' }), opts).reasons).toContain(
        'DATE_NEAR',
      );
      expect(scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-14T09:00:00.000Z' }), opts).reasons).not.toContain(
        'DATE_NEAR',
      );
    });

    it('refuses an offset-less timestamp rather than guessing the device timezone', () => {
      // '2026-08-11T15:22:00' would be parsed in local time, so the calendar day
      // it lands on would depend on where the phone is.
      const c = scoreMatch(BASE_DRAFT, txnWith({ occurredAt: '2026-08-11T15:22:00' }));
      expect(c.reasons).not.toContain('DATE_EXACT');
      expect(c.reasons).not.toContain('DATE_NEAR');
      expect(c.score).toBeGreaterThan(0); // amount/currency/merchant still count
    });

    it('survives malformed dates on either side', () => {
      expect(() => scoreMatch(BASE_DRAFT, txnWith({ occurredAt: 'not-a-timestamp' }))).not.toThrow();
      expect(() => scoreMatch(draftWith({ transactionDate: '2026-02-30' }), BASE_TXN)).not.toThrow();
      expect(scoreMatch(draftWith({ transactionDate: '2026-02-30' }), BASE_TXN).reasons).not.toContain('DATE_NEAR');
    });
  });

  it('never leaves the 0..100 range across the whole seeded matrix', () => {
    for (const txn of SEEDED) {
      for (const currency of ['USD', 'EUR', null]) {
        for (const amount of [null, 0, 1899, 1949, 999_999]) {
          const c = scoreMatch(draftWith({ currency, amountMinorUnits: amount }), txn);
          expect(c.score).toBeGreaterThanOrEqual(0);
          expect(c.score).toBeLessThanOrEqual(100);
          expect(Number.isInteger(c.score)).toBe(true);
        }
      }
    }
  });

  it('is a pure function of its inputs — same arguments, same result', () => {
    const a = scoreMatch(BASE_DRAFT, BASE_TXN);
    const b = scoreMatch(BASE_DRAFT, BASE_TXN);
    expect(a).toEqual(b);
  });

  it('is an independent company gate, even called directly', () => {
    // Defence in depth: findMatchCandidates filters, and scoreMatch refuses.
    const c = scoreMatch(BASE_DRAFT, txnWith({ companyId: OTHER_COMPANY }));
    expect(c.score).toBe(0);
    expect(c.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findMatchCandidates
// ---------------------------------------------------------------------------

describe('findMatchCandidates', () => {
  it('SECURITY: never surfaces another company transaction, however perfect', () => {
    const perfectForeign = txnWith({ id: 'txn-000', companyId: OTHER_COMPANY });
    const results = findMatchCandidates(BASE_DRAFT, [perfectForeign]);
    expect(results).toEqual([]);

    // It also must not sneak in alongside legitimate results, even though its
    // id sorts first and its score would be the highest.
    expect(ids(findMatchCandidates(BASE_DRAFT, [perfectForeign, BASE_TXN]))).toEqual(['txn-200']);
  });

  it('SECURITY: scopes by the draft company, not by the device session', () => {
    // Edge case 3: the app was killed while queued and relaunched under another
    // company. The draft's stamped companyId still governs, so the candidate
    // list for a co-globex draft contains only co-globex transactions.
    const foreignDraft = draftWith({ localId: 'r-local-9', companyId: OTHER_COMPANY });
    const results = findMatchCandidates(foreignDraft, SEEDED);
    expect(ids(results)).toEqual(['txn-700']);
  });

  it('excludes currency mismatches entirely', () => {
    expect(ids(findMatchCandidates(BASE_DRAFT, SEEDED))).not.toContain('txn-600');
  });

  it('ranks the seeded close-but-not-identical set by strength of evidence', () => {
    // txn-200 exact (100) > txn-500 two-day lag (92) > txn-300 amount drift (80)
    // > txn-400 merchant mismatch (75).
    expect(ids(findMatchCandidates(BASE_DRAFT, SEEDED))).toEqual(['txn-200', 'txn-500', 'txn-300', 'txn-400']);
  });

  it('orders identically regardless of input order', () => {
    const permutations: Transaction[][] = [
      SEEDED,
      SEEDED.slice().reverse(),
      [SEEDED[3], SEEDED[0], SEEDED[5], SEEDED[2], SEEDED[4], SEEDED[1]],
      [SEEDED[2], SEEDED[4], SEEDED[1], SEEDED[5], SEEDED[3], SEEDED[0]],
    ];
    const expected = ids(findMatchCandidates(BASE_DRAFT, SEEDED));
    for (const p of permutations) {
      expect(ids(findMatchCandidates(BASE_DRAFT, p))).toEqual(expected);
    }
  });

  it('breaks exact ties by transaction id, not by array position', () => {
    // Two indistinguishable transactions: without an id tiebreak the top
    // suggestion would flip whenever the array arrived in a different order.
    const zzz = txnWith({ id: 'txn-zzz' });
    const aaa = txnWith({ id: 'txn-aaa' });
    expect(ids(findMatchCandidates(BASE_DRAFT, [zzz, aaa]))).toEqual(['txn-aaa', 'txn-zzz']);
    expect(ids(findMatchCandidates(BASE_DRAFT, [aaa, zzz]))).toEqual(['txn-aaa', 'txn-zzz']);
  });

  it('applies the limit after sorting, keeping the strongest candidates', () => {
    expect(ids(findMatchCandidates(BASE_DRAFT, SEEDED, { limit: 2 }))).toEqual(['txn-200', 'txn-500']);
  });

  it('returns nothing for a non-positive or nonsensical limit', () => {
    expect(findMatchCandidates(BASE_DRAFT, SEEDED, { limit: 0 })).toEqual([]);
    expect(findMatchCandidates(BASE_DRAFT, SEEDED, { limit: -3 })).toEqual([]);
    expect(findMatchCandidates(BASE_DRAFT, SEEDED, { limit: Number.NaN })).toEqual([]);
  });

  it('passes the date tolerance through to scoring', () => {
    // txn-500 settled two days after the printed date. Under the default
    // window that earns DATE_NEAR; under a same-day-only window it earns
    // nothing and the candidate scores strictly lower.
    const withDefault = pick(findMatchCandidates(BASE_DRAFT, SEEDED), 'txn-500');
    const sameDayOnly = pick(findMatchCandidates(BASE_DRAFT, SEEDED, { dateToleranceDays: 0 }), 'txn-500');
    expect(withDefault.reasons).toContain('DATE_NEAR');
    expect(sameDayOnly.reasons).not.toContain('DATE_NEAR');
    expect(sameDayOnly.score).toBeLessThan(withDefault.score);
  });

  it('returns an empty list rather than throwing on no transactions', () => {
    expect(findMatchCandidates(BASE_DRAFT, [])).toEqual([]);
  });

  it('does not sort the caller array in place', () => {
    const input = SEEDED.slice();
    const before = input.map((t) => t.id);
    findMatchCandidates(BASE_DRAFT, input);
    expect(input.map((t) => t.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Edge case 6: two receipts, one card transaction
// ---------------------------------------------------------------------------

describe('edge case 6 — two receipts matched to the same card transaction', () => {
  const RECEIPT_A = 'r-local-a';
  const RECEIPT_B = 'r-local-b';
  const claimedByA = txnWith({ matchedReceiptId: RECEIPT_A });

  it('lets the first receipt claim an unmatched transaction', () => {
    expect(canAssignMatch(BASE_TXN, RECEIPT_A)).toEqual({ ok: true });
  });

  it('refuses a second, different receipt and says which one holds it', () => {
    const result = canAssignMatch(claimedByA, RECEIPT_B);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: narrowing guard');
    expect(result.reason).toContain(claimedByA.id);
    expect(result.reason).toContain(RECEIPT_A);
  });

  it('IS IDEMPOTENT: re-assigning the SAME receipt succeeds', () => {
    // Edge case 1 — the upload succeeded but the ACK was lost. The retry
    // replays the same idempotency key, the server returns the original record
    // with the match already saved, and the client re-applies it. Failing here
    // would permanently strand a receipt for having succeeded the first time.
    expect(canAssignMatch(claimedByA, RECEIPT_A)).toEqual({ ok: true });
    expect(canAssignMatch(claimedByA, RECEIPT_A)).toEqual({ ok: true });
  });

  it('refuses an empty receipt id', () => {
    expect(canAssignMatch(BASE_TXN, '').ok).toBe(false);
  });

  it('still SHOWS the taken transaction to the second receipt, flagged blocked', () => {
    // Hiding it would leave the user staring at a perfect amount/date match
    // that is mysteriously not offered.
    const draftB = draftWith({ localId: RECEIPT_B });
    const [top] = findMatchCandidates(draftB, [claimedByA]);
    expect(top).toBeDefined();
    if (top === undefined) throw new Error('unreachable: expected a candidate');
    expect(top.score).toBe(100);
    expect(top.isExact).toBe(true);
    expect(top.blocked).toBe(true);
    expect(top.blockedReason).toContain(RECEIPT_A);
    // The list is advisory; the guard is what actually refuses the write.
    expect(canAssignMatch(top.transaction, RECEIPT_B).ok).toBe(false);
  });

  it('does not flag the OWNING receipt as blocked by itself', () => {
    const draftA = draftWith({ localId: RECEIPT_A });
    const [top] = findMatchCandidates(draftA, [claimedByA]);
    expect(top).toBeDefined();
    if (top === undefined) throw new Error('unreachable: expected a candidate');
    expect(top.blocked).toBe(false);
    expect(top.blockedReason).toBeNull();
  });

  it('reports the block even on a pair that scores 0, so the UI can explain it', () => {
    const draftB = draftWith({ localId: RECEIPT_B, currency: 'EUR' });
    const c = scoreMatch(draftB, claimedByA);
    expect(c.score).toBe(0);
    expect(c.blocked).toBe(true);
  });
});
