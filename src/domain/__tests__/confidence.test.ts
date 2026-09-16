/**
 * Tests for match confidence.
 *
 * Two kinds of fixture are used on purpose:
 *
 *  - REAL candidates produced by `scoreMatch`, so the policy is tested against
 *    the scores matching.ts actually emits rather than against numbers this
 *    file invented. These prove the thresholds sit where the comments claim.
 *  - HAND-BUILT candidates, so a band boundary can be hit exactly (74/75/76)
 *    and an ambiguity margin can be exercised to the point. A `MatchCandidate`
 *    is a plain record, so constructing one is legitimate — but it is never
 *    used to assert something a real score could contradict.
 */

import {
  AMBIGUITY_MARGIN,
  AUTO_SELECT_THRESHOLD,
  REVIEW_THRESHOLD,
  bandFor,
  explainMatch,
  isAmbiguous,
  rankAndExplain,
  type ConfidenceBand,
} from '../confidence';
import { scoreMatch, type MatchCandidate, type MatchReason } from '../matching';
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
  occurredAt: '2026-08-11T15:22:00.000Z',
  matchedReceiptId: null,
};

const draftWith = (patch: Partial<ReceiptDraft>): ReceiptDraft => ({ ...BASE_DRAFT, ...patch });
const txnWith = (patch: Partial<Transaction>): Transaction => ({ ...BASE_TXN, ...patch });

/** A fabricated candidate, for hitting a boundary that real data cannot land on exactly. */
const candidateWith = (patch: Partial<MatchCandidate>): MatchCandidate => ({
  transaction: BASE_TXN,
  score: 50,
  reasons: ['AMOUNT_EXACT', 'CURRENCY_MATCH', 'MERCHANT_EXACT', 'DATE_EXACT'] as MatchReason[],
  isExact: false,
  blocked: false,
  blockedReason: null,
  ...patch,
});

/** Every caveat joined, for substring assertions without index coupling. */
const caveatText = (draft: ReceiptDraft, candidate: MatchCandidate): string =>
  explainMatch(draft, candidate).caveats.join(' | ');

// ---------------------------------------------------------------------------
// Bands and their boundaries
// ---------------------------------------------------------------------------

describe('bandFor', () => {
  it('places the thresholds in the documented order', () => {
    expect(REVIEW_THRESHOLD).toBeLessThan(AUTO_SELECT_THRESHOLD);
    expect(AMBIGUITY_MARGIN).toBeGreaterThan(0);
  });

  it('bands a zero or negative score as none', () => {
    expect(bandFor(candidateWith({ score: 0 }))).toBe('none');
    expect(bandFor(candidateWith({ score: -1 }))).toBe('none');
  });

  it('is exactly at, below and above the auto-select boundary', () => {
    expect(bandFor(candidateWith({ score: AUTO_SELECT_THRESHOLD - 1 }))).toBe('medium');
    expect(bandFor(candidateWith({ score: AUTO_SELECT_THRESHOLD }))).toBe('high');
    expect(bandFor(candidateWith({ score: AUTO_SELECT_THRESHOLD + 1 }))).toBe('high');
  });

  it('is exactly at, below and above the review boundary', () => {
    expect(bandFor(candidateWith({ score: REVIEW_THRESHOLD - 1 }))).toBe('low');
    expect(bandFor(candidateWith({ score: REVIEW_THRESHOLD }))).toBe('medium');
    expect(bandFor(candidateWith({ score: REVIEW_THRESHOLD + 1 }))).toBe('medium');
  });

  it('is exactly at, below and above the none/low boundary', () => {
    expect(bandFor(candidateWith({ score: -1 }))).toBe('none');
    expect(bandFor(candidateWith({ score: 0 }))).toBe('none');
    expect(bandFor(candidateWith({ score: 1 }))).toBe('low');
  });

  it('calls an exact match exact, but never rescues a zero score', () => {
    expect(bandFor(candidateWith({ score: 100, isExact: true }))).toBe('exact');
    expect(bandFor(candidateWith({ score: 0, isExact: true }))).toBe('none');
  });
});

describe('threshold derivations hold against real scores', () => {
  it('a same-money same-day match clears the auto-select threshold', () => {
    // Vendor dropped so the score is exactly the documented 50 + 10 + 15.
    const candidate = scoreMatch(draftWith({ vendor: null }), BASE_TXN);
    expect(candidate.score).toBe(AUTO_SELECT_THRESHOLD);
    expect(candidate.isExact).toBe(true);
    expect(bandFor(candidate)).toBe('exact');
  });

  it('agreeing name, day and currency WITHOUT an amount stays under review threshold', () => {
    const candidate = scoreMatch(draftWith({ amountMinorUnits: null }), BASE_TXN);
    expect(candidate.score).toBeLessThan(REVIEW_THRESHOLD);
    expect(explainMatch(draftWith({ amountMinorUnits: null }), candidate).requiresReview).toBe(true);
  });

  it('agreeing money alone clears the review threshold', () => {
    const draft = draftWith({ vendor: null, transactionDate: null });
    const candidate = scoreMatch(draft, BASE_TXN);
    expect(candidate.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    const verdict = explainMatch(draft, candidate);
    expect(verdict.band).toBe('medium');
    expect(verdict.requiresReview).toBe(false);
    expect(verdict.autoSelectable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict shape
// ---------------------------------------------------------------------------

describe('explainMatch', () => {
  it('explains a perfect match with no caveats and offers it for pre-selection', () => {
    const candidate = scoreMatch(BASE_DRAFT, BASE_TXN);
    const verdict = explainMatch(BASE_DRAFT, candidate);

    expect(verdict.band).toBe('exact');
    expect(verdict.caveats).toEqual([]);
    expect(verdict.autoSelectable).toBe(true);
    expect(verdict.requiresReview).toBe(false);
  });

  it('renders reasons in a fixed display order, not the scorer order', () => {
    const candidate = scoreMatch(BASE_DRAFT, BASE_TXN);
    const { reasons } = explainMatch(BASE_DRAFT, candidate);

    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toMatch(/amount/i);
    expect(reasons[1]).toMatch(/date/i);
    expect(reasons[2]).toMatch(/merchant/i);
    expect(reasons[3]).toMatch(/currency/i);
  });

  it('de-duplicates a repeated reason', () => {
    const candidate = candidateWith({
      reasons: ['AMOUNT_EXACT', 'AMOUNT_EXACT', 'CURRENCY_MATCH'] as MatchReason[],
    });
    expect(explainMatch(BASE_DRAFT, candidate).reasons).toHaveLength(2);
  });

  it('writes a summary with no percentages and no numbers at all', () => {
    const cases: MatchCandidate[] = [
      scoreMatch(BASE_DRAFT, BASE_TXN),
      candidateWith({ score: 80 }),
      candidateWith({ score: 60 }),
      candidateWith({ score: 10 }),
      candidateWith({ score: 0 }),
      candidateWith({ score: 100, blocked: true, blockedReason: 'taken' }),
    ];
    const seen = new Set<ConfidenceBand>();
    for (const c of cases) {
      const verdict = explainMatch(BASE_DRAFT, c);
      seen.add(verdict.band);
      expect(verdict.summary).not.toMatch(/[0-9%]/);
      // One sentence: exactly one terminator, at the end.
      expect(verdict.summary.match(/[.!?]/g)).toHaveLength(1);
      expect(verdict.summary.trim().endsWith('.')).toBe(true);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('is pure — the same inputs produce a deeply equal verdict', () => {
    const candidate = scoreMatch(BASE_DRAFT, BASE_TXN);
    expect(explainMatch(BASE_DRAFT, candidate)).toEqual(explainMatch(BASE_DRAFT, candidate));
  });
});

// ---------------------------------------------------------------------------
// Blocked candidates — edge case 6
// ---------------------------------------------------------------------------

describe('blocked candidates', () => {
  const takenTxn = txnWith({ matchedReceiptId: 'r-local-9' });

  it('never pre-selects one, however perfectly it scores, and says so plainly', () => {
    const candidate = scoreMatch(BASE_DRAFT, takenTxn);
    const verdict = explainMatch(BASE_DRAFT, candidate);

    expect(candidate.score).toBe(100);
    expect(verdict.band).toBe('exact');
    expect(verdict.autoSelectable).toBe(false);
    expect(verdict.requiresReview).toBe(true);
    expect(verdict.summary).toMatch(/already matched/i);
    expect(verdict.caveats.join(' ')).toMatch(/already matched/i);
  });

  it('keeps the plain sentence free of the raw identifiers in blockedReason', () => {
    const verdict = explainMatch(BASE_DRAFT, scoreMatch(BASE_DRAFT, takenTxn));
    expect(verdict.summary).not.toMatch(/r-local-9|txn-200/);
    expect(verdict.caveats.join(' ')).not.toMatch(/r-local-9|txn-200/);
  });

  it('re-derives blocked from the transaction when the candidate flag disagrees', () => {
    // A candidate scored for a DIFFERENT receipt carries blocked:false, because
    // that other receipt owns the transaction. It must not become selectable
    // just because it was handed to the wrong draft.
    const verdict = explainMatch(BASE_DRAFT, candidateWith({ score: 100, transaction: takenTxn }));
    expect(verdict.autoSelectable).toBe(false);
    expect(verdict.requiresReview).toBe(true);
  });

  it('does not treat the draft\'s own existing match as blocking', () => {
    const mine = txnWith({ matchedReceiptId: BASE_DRAFT.localId });
    const verdict = explainMatch(BASE_DRAFT, scoreMatch(BASE_DRAFT, mine));
    expect(verdict.autoSelectable).toBe(true);
    expect(verdict.caveats).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hard stops: currency and company
// ---------------------------------------------------------------------------

describe('currency mismatch', () => {
  const eurTxn = txnWith({ currency: 'EUR' });

  it('is band none through real scoring', () => {
    const candidate = scoreMatch(BASE_DRAFT, eurTxn);
    expect(candidate.score).toBe(0);
    expect(explainMatch(BASE_DRAFT, candidate).band).toBe('none');
  });

  it('is band none even when the candidate claims a perfect score', () => {
    const verdict = explainMatch(
      BASE_DRAFT,
      candidateWith({ score: 100, isExact: true, transaction: eurTxn }),
    );
    expect(verdict.band).toBe('none');
    expect(verdict.autoSelectable).toBe(false);
    expect(verdict.requiresReview).toBe(true);
    expect(verdict.summary).toMatch(/different currency/i);
  });

  it('names both currencies in the caveat', () => {
    const text = caveatText(BASE_DRAFT, scoreMatch(BASE_DRAFT, eurTxn));
    expect(text).toMatch(/USD/);
    expect(text).toMatch(/EUR/);
  });

  it('ignores case and padding, as matching.ts does', () => {
    const draft = draftWith({ currency: ' usd ' });
    expect(explainMatch(draft, candidateWith({ score: 90 })).band).toBe('high');
  });
});

describe('company mismatch', () => {
  it('is band none and says the transaction belongs to another company', () => {
    const foreign = txnWith({ companyId: OTHER_COMPANY });
    const verdict = explainMatch(BASE_DRAFT, candidateWith({ score: 100, transaction: foreign }));

    expect(verdict.band).toBe('none');
    expect(verdict.autoSelectable).toBe(false);
    expect(verdict.requiresReview).toBe(true);
    expect(verdict.caveats.join(' ')).toMatch(/different company/i);
  });
});

// ---------------------------------------------------------------------------
// Caveat generation — one case per absent reason
// ---------------------------------------------------------------------------

describe('caveats are generated from absent reasons', () => {
  it('says the amounts were not compared when the draft has no amount', () => {
    const draft = draftWith({ amountMinorUnits: null });
    expect(caveatText(draft, scoreMatch(draft, BASE_TXN))).toMatch(
      /does not have an amount yet.*not compared/i,
    );
  });

  it('says the amounts were not compared when the draft has no currency', () => {
    const draft = draftWith({ currency: null });
    const text = caveatText(draft, scoreMatch(draft, BASE_TXN));
    expect(text).toMatch(/does not say which currency/i);
    // And it says it ONCE: the missing currency already explains the amount.
    expect(text).not.toMatch(/amounts are different/i);
  });

  it('shows both amounts when they disagree', () => {
    const txn = txnWith({ amountMinorUnits: 5000 });
    const text = caveatText(BASE_DRAFT, scoreMatch(BASE_DRAFT, txn));
    // Formatted through money.ts: integer minor units, never a float.
    expect(text).toContain('USD 18.99');
    expect(text).toContain('USD 50.00');
  });

  it('falls back to a plain sentence rather than throwing on an unsupported currency', () => {
    const draft = draftWith({ currency: 'XTS' });
    const txn = txnWith({ currency: 'XTS', amountMinorUnits: 5000 });
    const run = (): string => caveatText(draft, scoreMatch(draft, txn));
    expect(run).not.toThrow();
    expect(run()).toMatch(/amounts are different/i);
  });

  it('says the names were not compared when the draft has no merchant', () => {
    for (const vendor of [null, '   ']) {
      const draft = draftWith({ vendor });
      expect(caveatText(draft, scoreMatch(draft, BASE_TXN))).toMatch(
        /does not have a merchant name yet/i,
      );
    }
  });

  it('says the names disagree when both are present and unalike', () => {
    const txn = txnWith({ merchant: 'Bluebird Taxi Service' });
    expect(caveatText(BASE_DRAFT, scoreMatch(BASE_DRAFT, txn))).toMatch(/do not look alike/i);
  });

  it('says the dates do not line up when both are present and far apart', () => {
    const txn = txnWith({ occurredAt: '2026-09-01T10:00:00.000Z' });
    expect(caveatText(BASE_DRAFT, scoreMatch(BASE_DRAFT, txn))).toMatch(/dates do not line up/i);
  });

  it('says the dates were not compared when the draft has no date', () => {
    const draft = draftWith({ transactionDate: null });
    const text = caveatText(draft, scoreMatch(draft, BASE_TXN));
    expect(text).toMatch(/does not have a date yet/i);
    expect(text).not.toMatch(/do not line up/i);
  });

  it('distinguishes an unreadable receipt date from a disagreeing one', () => {
    const draft = draftWith({ transactionDate: '2026-13-45' });
    const text = caveatText(draft, scoreMatch(draft, BASE_TXN));
    expect(text).toMatch(/could not be read/i);
    expect(text).not.toMatch(/do not line up/i);
  });

  it('distinguishes an unusable transaction date from a disagreeing one', () => {
    const txn = txnWith({ occurredAt: 'whenever' });
    const text = caveatText(BASE_DRAFT, scoreMatch(BASE_DRAFT, txn));
    expect(text).toMatch(/transaction does not have a usable date/i);
    expect(text).not.toMatch(/do not line up/i);
  });

  it('emits nothing when every field the draft has was compared and agreed', () => {
    expect(explainMatch(BASE_DRAFT, scoreMatch(BASE_DRAFT, BASE_TXN)).caveats).toEqual([]);
  });

  it('accumulates one caveat per independent gap', () => {
    const draft = draftWith({ vendor: null, transactionDate: null });
    const caveats = explainMatch(draft, scoreMatch(draft, BASE_TXN)).caveats;
    expect(caveats).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The ambiguity guard
// ---------------------------------------------------------------------------

describe('isAmbiguous', () => {
  it('is false for an empty or single-candidate list', () => {
    expect(isAmbiguous([])).toBe(false);
    expect(isAmbiguous([candidateWith({ score: 100 })])).toBe(false);
  });

  it('is true at exactly the margin and false one point beyond it', () => {
    const top = candidateWith({ score: 90, transaction: txnWith({ id: 'txn-a' }) });
    const atMargin = candidateWith({
      score: 90 - AMBIGUITY_MARGIN,
      transaction: txnWith({ id: 'txn-b' }),
    });
    const beyond = candidateWith({
      score: 90 - AMBIGUITY_MARGIN - 1,
      transaction: txnWith({ id: 'txn-b' }),
    });

    expect(isAmbiguous([top, atMargin])).toBe(true);
    expect(isAmbiguous([top, beyond])).toBe(false);
  });

  it('ignores zero-scoring candidates: no evidence is not a rival', () => {
    expect(isAmbiguous([candidateWith({ score: 0 }), candidateWith({ score: 0 })])).toBe(false);
    expect(
      isAmbiguous([
        candidateWith({ score: 100, transaction: txnWith({ id: 'txn-a' }) }),
        candidateWith({ score: 0, transaction: txnWith({ id: 'txn-b' }) }),
      ]),
    ).toBe(false);
  });

  it('counts a blocked rival, because two transactions still look alike', () => {
    const blockedTop = candidateWith({
      score: 100,
      blocked: true,
      blockedReason: 'taken',
      transaction: txnWith({ id: 'txn-a', matchedReceiptId: 'r-local-9' }),
    });
    const runnerUp = candidateWith({ score: 98, transaction: txnWith({ id: 'txn-b' }) });
    expect(isAmbiguous([blockedTop, runnerUp])).toBe(true);
    expect(rankAndExplain(BASE_DRAFT, [blockedTop, runnerUp]).every((c) => !c.verdict.autoSelectable)).toBe(
      true,
    );
  });
});

describe('rankAndExplain', () => {
  const TWIN_A = txnWith({ id: 'txn-aaa' });
  const TWIN_B = txnWith({ id: 'txn-bbb' });

  it('returns an empty list for no candidates', () => {
    expect(rankAndExplain(BASE_DRAFT, [])).toEqual([]);
  });

  it('suppresses auto-select for two near-identical candidates, however high they score', () => {
    const candidates = [scoreMatch(BASE_DRAFT, TWIN_A), scoreMatch(BASE_DRAFT, TWIN_B)];
    expect(candidates.map((c) => c.score)).toEqual([100, 100]);

    const ranked = rankAndExplain(BASE_DRAFT, candidates);
    expect(ranked.map((r) => r.verdict.band)).toEqual(['exact', 'exact']);
    expect(ranked.map((r) => r.verdict.autoSelectable)).toEqual([false, false]);
    for (const r of ranked) {
      expect(r.verdict.caveats.join(' ')).toMatch(/just as likely/i);
    }
  });

  it('pre-selects the single clear winner', () => {
    const winner = scoreMatch(BASE_DRAFT, TWIN_A);
    const alsoRan = scoreMatch(BASE_DRAFT, txnWith({ id: 'txn-zzz', merchant: 'Bluebird Taxi Service' }));
    const ranked = rankAndExplain(BASE_DRAFT, [alsoRan, winner]);

    expect(ranked[0]?.transaction.id).toBe('txn-aaa');
    expect(ranked[0]?.verdict.autoSelectable).toBe(true);
    expect(ranked[0]?.verdict.caveats.join(' ')).not.toMatch(/just as likely/i);
    expect(ranked[1]?.verdict.autoSelectable).toBe(false);
  });

  it('never pre-selects a runner-up, even one above the auto-select threshold', () => {
    const top = candidateWith({ score: 100, transaction: txnWith({ id: 'txn-aaa' }) });
    // Far enough behind to be unambiguous, but still a strong candidate.
    const second = candidateWith({ score: 80, transaction: txnWith({ id: 'txn-bbb' }) });
    const ranked = rankAndExplain(BASE_DRAFT, [second, top]);

    expect(ranked.map((r) => r.verdict.band)).toEqual(['high', 'high']);
    expect(ranked.map((r) => r.verdict.autoSelectable)).toEqual([true, false]);
  });

  it('warns only the tied candidates, not a far-behind one', () => {
    const a = candidateWith({ score: 90, transaction: txnWith({ id: 'txn-aaa' }) });
    const b = candidateWith({ score: 90 - AMBIGUITY_MARGIN, transaction: txnWith({ id: 'txn-bbb' }) });
    const far = candidateWith({ score: 20, transaction: txnWith({ id: 'txn-ccc' }) });
    const ranked = rankAndExplain(BASE_DRAFT, [far, b, a]);

    expect(ranked.map((r) => r.verdict.caveats.join(' ').includes('just as likely'))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('does not raise requiresReview merely because the choice was ambiguous', () => {
    const ranked = rankAndExplain(BASE_DRAFT, [
      scoreMatch(BASE_DRAFT, TWIN_A),
      scoreMatch(BASE_DRAFT, TWIN_B),
    ]);
    expect(ranked.map((r) => r.verdict.requiresReview)).toEqual([false, false]);
  });

  it('orders by score descending, then transaction id ascending', () => {
    const ranked = rankAndExplain(BASE_DRAFT, [
      candidateWith({ score: 60, transaction: txnWith({ id: 'txn-002' }) }),
      candidateWith({ score: 90, transaction: txnWith({ id: 'txn-999' }) }),
      candidateWith({ score: 90, transaction: txnWith({ id: 'txn-111' }) }),
    ]);
    expect(ranked.map((r) => r.transaction.id)).toEqual(['txn-111', 'txn-999', 'txn-002']);
  });

  it('is identical under every input ordering', () => {
    const candidates = [
      scoreMatch(BASE_DRAFT, txnWith({ id: 'txn-001' })),
      scoreMatch(BASE_DRAFT, txnWith({ id: 'txn-002', amountMinorUnits: 1949 })),
      scoreMatch(BASE_DRAFT, txnWith({ id: 'txn-003', merchant: 'Bluebird Taxi Service' })),
      scoreMatch(BASE_DRAFT, txnWith({ id: 'txn-004', occurredAt: '2026-08-13T09:00:00.000Z' })),
    ];
    // Fixed permutations, not a random shuffle: this module is pure and the
    // test must be too.
    const permutations: MatchCandidate[][] = [
      candidates,
      [...candidates].reverse(),
      [candidates[2], candidates[0], candidates[3], candidates[1]].filter(
        (c): c is MatchCandidate => c !== undefined,
      ),
      [candidates[3], candidates[2], candidates[1], candidates[0]].filter(
        (c): c is MatchCandidate => c !== undefined,
      ),
    ];

    const expected = JSON.stringify(rankAndExplain(BASE_DRAFT, candidates));
    for (const p of permutations) {
      expect(JSON.stringify(rankAndExplain(BASE_DRAFT, p))).toBe(expected);
    }
  });

  it('does not mutate the caller\'s array', () => {
    const candidates = [
      candidateWith({ score: 10, transaction: txnWith({ id: 'txn-low' }) }),
      candidateWith({ score: 90, transaction: txnWith({ id: 'txn-high' }) }),
    ];
    rankAndExplain(BASE_DRAFT, candidates);
    expect(candidates.map((c) => c.transaction.id)).toEqual(['txn-low', 'txn-high']);
  });
});
