/**
 * Match confidence: turning a score into a DECISION.
 *
 * matching.ts answers "how well do these two records agree?" with a number.
 * A number is not an answer a person can act on: "73%" tells a user nothing
 * about whether to tap Confirm, and it tells a finance reviewer nothing about
 * what to check. This module converts that number, plus the evidence behind it,
 * into a stated policy — a band, a plain sentence, the evidence for, the
 * evidence against, and two booleans the UI can obey.
 *
 * Four rules drive the design:
 *
 * 1. THE MACHINE MAY ONLY CHOOSE WHEN THERE IS NOTHING TO CHOOSE BETWEEN.
 *    A single high-scoring candidate may be pre-selected. Two candidates that
 *    look equally right may not be — see `isAmbiguous`. "Two transactions look
 *    equally right" is precisely the situation where a pre-selection is a
 *    silent guess wearing the user's authority, and the user is the highest
 *    authority in this codebase (see ORIGIN_PRECEDENCE in types.ts).
 *
 * 2. EVERY VERDICT SHOWS ITS OTHER HALF.
 *    `reasons` is what agrees; `caveats` is what is missing or contradictory.
 *    Caveats are DERIVED from which MatchReasons are absent relative to what
 *    the draft could have supported, never hand-written per case, so a new
 *    field or a new reason cannot quietly stop being explained.
 *
 * 3. A CURRENCY MISMATCH IS NEVER A MATCH.
 *    Same hard stop, same reason as matching.ts: comparing two currencies needs
 *    an FX rate, and a rate is a business decision with a date on it.
 *
 * 4. DETERMINISM.
 *    Pure: no clock, no randomness, no I/O. Same inputs produce the same
 *    verdicts in the same order, with ties broken by transaction id, so a
 *    ranked list can be snapshotted in a test and reproduced in a support
 *    ticket.
 *
 * NOT TO BE CONFUSED WITH OCR CONFIDENCE (ocr.ts), which scores how well a
 * machine READ one receipt. This module scores how well a receipt AGREES with a
 * card transaction. They are independent axes: a crisply-read receipt can still
 * match three transactions equally badly.
 */

import { isValidDateOnly, isValidInstant } from './dates';
import type { MatchCandidate, MatchReason } from './matching';
import { formatMoney, isSupportedCurrency } from './money';
import type { ReceiptDraft, Transaction } from './types';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type ConfidenceBand = 'exact' | 'high' | 'medium' | 'low' | 'none';

export interface ConfidenceVerdict {
  readonly band: ConfidenceBand;
  /** One plain sentence. No jargon, no percentages, no identifiers. */
  readonly summary: string;
  /** The evidence FOR, as human text, in a fixed display order. */
  readonly reasons: readonly string[];
  /** The honest other half: what is missing or contradictory. */
  readonly caveats: readonly string[];
  /** May the UI pre-select this without the user choosing? */
  readonly autoSelectable: boolean;
  /** Flag for human review even if the user confirms. */
  readonly requiresReview: boolean;
}

// ---------------------------------------------------------------------------
// Policy constants
//
// These are DERIVED from matching.ts's published weights (amount exact 50,
// currency 10, merchant exact 25, date exact 15, summing to 100), not picked
// for how they look. Both thresholds sit on a sentence about evidence, which is
// what makes them arguable in a design review rather than magic.
// ---------------------------------------------------------------------------

/**
 * At or above this, a SINGLE candidate may be pre-selected for the user.
 *
 * 75 = amount exact (50) + currency (10) + date exact (15): the money and the
 * calendar day both agree, which is matching.ts's own definition of an exact
 * match, with the merchant name — the noisiest field on both sides — thrown in
 * as a bonus rather than a requirement. Nothing weaker than "same money, same
 * day" earns the right to answer on the user's behalf.
 */
export const AUTO_SELECT_THRESHOLD = 75;

/**
 * Below this, a submitted match is flagged for human review even after the user
 * confirms it.
 *
 * 55 is placed so that agreement on the MONEY clears it (amount exact 50 +
 * currency 10 = 60) while the best possible case WITHOUT agreeing money does
 * not (merchant exact 25 + currency 10 + date exact 15 = 50). A receipt and a
 * transaction that share a name and a day but not an amount are two different
 * purchases at the same shop until a person says otherwise.
 */
export const REVIEW_THRESHOLD = 55;

/**
 * Two candidates whose scores differ by at most this many points are "equally
 * right" for the purpose of auto-selection.
 *
 * 5 is one notch above the finest distinction matching.ts draws between two
 * otherwise-identical transactions: DATE_NEAR decays 4 points per day of
 * settlement drift, so the same purchase seen on adjacent settlement days is
 * 4 points apart and must not be resolved by the machine. Coarser signals —
 * a merchant name (25 or ~11+), a currency (10) — are decisive and stay so.
 */
export const AMBIGUITY_MARGIN = 5;

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * The band for one candidate, from its score and flags alone.
 *
 * SCORE-ONLY BY DESIGN: a `MatchCandidate` does not carry the draft, so this
 * function cannot see a currency mismatch directly. It does not need to —
 * matching.ts returns a hard 0 for a mismatched currency, which lands here as
 * `none`. `explainMatch` re-checks the draft's currency anyway, so the "a
 * currency mismatch is never a match" rule has two independent gates, exactly
 * as the company boundary does in matching.ts.
 */
export function bandFor(candidate: MatchCandidate): ConfidenceBand {
  // Checked before `isExact` so that a zero score — a cross-company pair, a
  // currency mismatch, no evidence at all — can never be labelled a match.
  if (candidate.score <= 0) return 'none';
  if (candidate.isExact) return 'exact';
  if (candidate.score >= AUTO_SELECT_THRESHOLD) return 'high';
  if (candidate.score >= REVIEW_THRESHOLD) return 'medium';
  return 'low';
}

const BAND_SUMMARY: Readonly<Record<ConfidenceBand, string>> = {
  exact: 'This transaction is for the same amount on the same day, so it is almost certainly the right one.',
  high: 'This looks like the right transaction.',
  medium: 'This could be the right transaction, but check it before you confirm.',
  low: 'Very little about this transaction matches the receipt.',
  none: 'This transaction does not match the receipt.',
};

/** Said instead of the band sentence when the candidate simply cannot be picked. */
const UNSELECTABLE_SUMMARY = {
  company: 'This transaction belongs to a different company, so it cannot be used.',
  blocked: 'Another receipt is already matched to this transaction, so you cannot choose it.',
  currency: 'This transaction is in a different currency, so it cannot be compared to the receipt.',
} as const;

// ---------------------------------------------------------------------------
// Reasons as human text
// ---------------------------------------------------------------------------

const REASON_TEXT: Readonly<Record<MatchReason, string>> = {
  AMOUNT_EXACT: 'The amount is exactly the same.',
  AMOUNT_NEAR: 'The amount is very close, but not identical.',
  DATE_EXACT: 'It happened on the date shown on the receipt.',
  DATE_NEAR: 'It happened within a few days of the date on the receipt.',
  MERCHANT_EXACT: 'The merchant name is the same.',
  MERCHANT_FUZZY: 'The merchant name is nearly the same.',
  CURRENCY_MATCH: 'Both are in the same currency.',
};

/**
 * Display order, strongest evidence first — and deliberately NOT the order the
 * reasons happen to sit in on the candidate. Rendering order is a presentation
 * decision that must not change if matching.ts ever reorders its pushes.
 */
const REASON_DISPLAY_ORDER: readonly MatchReason[] = [
  'AMOUNT_EXACT',
  'AMOUNT_NEAR',
  'DATE_EXACT',
  'DATE_NEAR',
  'MERCHANT_EXACT',
  'MERCHANT_FUZZY',
  // Last: on its own it is the weakest possible agreement, and when the amount
  // already matched it is implied.
  'CURRENCY_MATCH',
];

function humanReasons(candidate: MatchCandidate): string[] {
  // Driven by the fixed order and de-duplicated as a side effect, so a caller
  // that hands us a repeated reason still gets a stable, single line.
  return REASON_DISPLAY_ORDER.filter((r) => candidate.reasons.includes(r)).map((r) => REASON_TEXT[r]);
}

// ---------------------------------------------------------------------------
// Caveats — generated from ABSENT reasons, never hardcoded per case
// ---------------------------------------------------------------------------

const HAS_AMOUNT_REASON: readonly MatchReason[] = ['AMOUNT_EXACT', 'AMOUNT_NEAR'];
const HAS_MERCHANT_REASON: readonly MatchReason[] = ['MERCHANT_EXACT', 'MERCHANT_FUZZY'];
const HAS_DATE_REASON: readonly MatchReason[] = ['DATE_EXACT', 'DATE_NEAR'];

function hasAny(candidate: MatchCandidate, group: readonly MatchReason[]): boolean {
  return group.some((r) => candidate.reasons.includes(r));
}

/**
 * matching.ts is deliberately case-sensitive about currency codes and says
 * normalising "is the caller's job and should be visible in the caller". This
 * is that visible place for this module, and it matches matching.ts's own
 * private helper exactly so the two cannot disagree about what a mismatch is.
 */
function canonicalCurrency(c: string): string {
  return c.trim().toUpperCase();
}

/**
 * "The amounts are different" is true but weak; the numbers are what a person
 * needs. Formatting goes through money.ts so the printed value is integer
 * string math, never a float.
 *
 * money.ts throws — correctly — on an unknown currency or a non-safe integer.
 * A caveat generator runs inside a render, so it degrades to the plain sentence
 * instead of taking the screen down with it.
 */
function amountsDifferCaveat(draftMinorUnits: number, txn: Transaction, currency: string): string {
  const plain = 'The amounts are different.';
  if (!isSupportedCurrency(currency)) return plain;
  if (!Number.isSafeInteger(draftMinorUnits) || !Number.isSafeInteger(txn.amountMinorUnits)) return plain;
  const receipt = formatMoney({ minorUnits: draftMinorUnits, currency });
  const transaction = formatMoney({ minorUnits: txn.amountMinorUnits, currency });
  return `The receipt says ${receipt} but this transaction is ${transaction}.`;
}

/**
 * Everything wrong with, or unknown about, this pairing.
 *
 * The shape of every clause is the same: could the DRAFT have supported this
 * reason, and did the reason show up? Field missing means "not compared"; field
 * present with no reason means "compared, and it disagrees". That derivation is
 * the whole point — nothing here is a per-scenario string table.
 */
function caveatsFor(
  draft: ReceiptDraft,
  candidate: MatchCandidate,
  ctx: { blocked: boolean; companyMismatch: boolean; currencyMismatch: boolean },
): string[] {
  const txn = candidate.transaction;
  const out: string[] = [];

  if (ctx.companyMismatch) {
    out.push('This transaction belongs to a different company, so it can never be matched to this receipt.');
  }
  if (ctx.blocked) {
    out.push('Another receipt is already matched to this transaction, so it cannot be chosen.');
  }

  // --- Currency. Its absence also explains the amount, so the amount clause
  // --- below stays quiet rather than saying the same thing twice.
  const draftCurrency = draft.currency === null ? null : canonicalCurrency(draft.currency);
  if (ctx.currencyMismatch && draftCurrency !== null) {
    out.push(
      `The receipt is in ${draftCurrency} but this transaction is in ${canonicalCurrency(txn.currency)}, ` +
        'so the amounts cannot be compared.',
    );
  } else if (draftCurrency === null) {
    out.push('The receipt does not say which currency it is in, so the amounts were not compared.');
  }

  // --- Amount ---
  if (draft.amountMinorUnits === null) {
    out.push('The receipt does not have an amount yet, so the amounts were not compared.');
  } else if (draftCurrency !== null && !ctx.currencyMismatch && !hasAny(candidate, HAS_AMOUNT_REASON)) {
    out.push(amountsDifferCaveat(draft.amountMinorUnits, txn, draftCurrency));
  }

  // --- Merchant. Whitespace counts as absent: matching.ts normalises a blank
  // --- name to '', which can never earn a merchant reason.
  if (draft.vendor === null || draft.vendor.trim().length === 0) {
    out.push('The receipt does not have a merchant name yet, so the names were not compared.');
  } else if (!hasAny(candidate, HAS_MERCHANT_REASON)) {
    out.push('The merchant names do not look alike.');
  }

  // --- Date. A malformed value on either side is "not compared", NOT "does not
  // --- line up": telling a user their dates disagree when one of them was
  // --- never readable sends them looking for the wrong problem.
  if (draft.transactionDate === null) {
    out.push('The receipt does not have a date yet, so the dates were not compared.');
  } else if (!isValidDateOnly(draft.transactionDate)) {
    out.push('The date on the receipt could not be read, so the dates were not compared.');
  } else if (!isValidInstant(txn.occurredAt)) {
    out.push('This transaction does not have a usable date, so the dates were not compared.');
  } else if (!hasAny(candidate, HAS_DATE_REASON)) {
    out.push('The dates do not line up.');
  }

  return out;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Explain ONE candidate against the draft it was scored for.
 *
 * `autoSelectable` here judges the candidate on its own merits only, because a
 * lone candidate carries no information about its rivals. `rankAndExplain` is
 * the function with list context, and it is the one that applies the ambiguity
 * guard — a caller that pre-selects straight from `explainMatch` has skipped
 * the guard, which is why the guard lives at the list level and is documented
 * on both.
 */
export function explainMatch(draft: ReceiptDraft, candidate: MatchCandidate): ConfidenceVerdict {
  const txn = candidate.transaction;

  const companyMismatch = txn.companyId !== draft.companyId;

  // Two gates again. The scorer's flag is authoritative for the receipt it was
  // computed against; re-deriving it from the transaction means a candidate
  // scored for a DIFFERENT receipt cannot be explained here as selectable.
  const blocked =
    candidate.blocked || (txn.matchedReceiptId !== null && txn.matchedReceiptId !== draft.localId);

  const draftCurrency = draft.currency === null ? null : canonicalCurrency(draft.currency);
  // Known-but-different is a mismatch; unknown is not. Same distinction
  // matching.ts draws, and it matters: a receipt whose currency has not been
  // filled in yet is incomplete, not contradictory.
  const currencyMismatch = draftCurrency !== null && draftCurrency !== canonicalCurrency(txn.currency);

  const band: ConfidenceBand = companyMismatch || currencyMismatch ? 'none' : bandFor(candidate);

  const summary = companyMismatch
    ? UNSELECTABLE_SUMMARY.company
    : blocked
      ? UNSELECTABLE_SUMMARY.blocked
      : currencyMismatch
        ? UNSELECTABLE_SUMMARY.currency
        : BAND_SUMMARY[band];

  // The band is a label; the threshold is the policy. Requiring both to agree
  // means a hand-built candidate whose `isExact` flag contradicts its score
  // cannot talk its way into being chosen for the user.
  const autoSelectable =
    !blocked &&
    !companyMismatch &&
    !currencyMismatch &&
    candidate.score >= AUTO_SELECT_THRESHOLD &&
    (band === 'exact' || band === 'high');

  // A blocked or cross-company candidate that somehow gets confirmed is a
  // one-transaction-two-receipts or a company-boundary incident, so it is
  // flagged regardless of how well it scored.
  const requiresReview =
    blocked || companyMismatch || currencyMismatch || candidate.score < REVIEW_THRESHOLD;

  return {
    band,
    summary,
    reasons: humanReasons(candidate),
    caveats: caveatsFor(draft, candidate, { blocked, companyMismatch, currencyMismatch }),
    autoSelectable,
    requiresReview,
  };
}

// ---------------------------------------------------------------------------
// Ambiguity guard
// ---------------------------------------------------------------------------

/**
 * The SAME total order `findMatchCandidates` publishes: score descending, then
 * transaction id ascending, compared by raw code unit so the result does not
 * depend on the device locale. Re-stated rather than imported because
 * matching.ts keeps its comparator private while documenting the ordering as
 * part of its contract; the two must not drift.
 */
function compareByScoreThenId(a: MatchCandidate, b: MatchCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.transaction.id < b.transaction.id) return -1;
  if (a.transaction.id > b.transaction.id) return 1;
  return 0;
}

/** Scoring candidates only, in rank order. Score 0 is "no evidence", not a rival. */
function rankedScoring(candidates: readonly MatchCandidate[]): MatchCandidate[] {
  return candidates.filter((c) => c.score > 0).sort(compareByScoreThenId);
}

/**
 * Are the top two candidates too close to tell apart?
 *
 * A zero-scoring candidate is excluded first: "no evidence either way" is not
 * two answers that look equally right, and letting two 0s count as a tie would
 * make every hopeless list ambiguous and hide the real signal.
 *
 * BLOCKED CANDIDATES STILL COUNT AS RIVALS. If the best match is a transaction
 * another receipt already claimed and the runner-up is a hair behind, the
 * honest reading is that two transactions look alike and one of the two
 * receipts is probably on the wrong one. That is a question for a person.
 */
export function isAmbiguous(candidates: readonly MatchCandidate[]): boolean {
  const ranked = rankedScoring(candidates);
  const first = ranked[0];
  const second = ranked[1];
  if (first === undefined || second === undefined) return false;
  return first.score - second.score <= AMBIGUITY_MARGIN;
}

const AMBIGUITY_CAVEAT =
  'Another transaction looks just as likely as this one, so please choose the right one yourself.';

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank candidates and explain every one of them.
 *
 * TWO SUPPRESSIONS OF `autoSelectable` HAPPEN HERE, and neither can be made by
 * `explainMatch` alone because both need the list:
 *
 *  - Only the top-ranked candidate may ever be pre-selected. A strong candidate
 *    sitting behind a stronger one is still not the answer.
 *  - If the top two are within AMBIGUITY_MARGIN, NOTHING is pre-selected, no
 *    matter how high it scores, and every candidate in that tie gains a caveat
 *    saying why. The caveat goes only to the tied candidates: telling a
 *    far-behind candidate that "another looks just as likely" would be false.
 *
 * `requiresReview` is deliberately NOT raised by ambiguity. Review exists to
 * get a human to look; a user picking between two look-alikes IS that human,
 * and they are holding the paper receipt.
 */
export function rankAndExplain(
  draft: ReceiptDraft,
  candidates: readonly MatchCandidate[],
): readonly (MatchCandidate & { readonly verdict: ConfidenceVerdict })[] {
  const ranked = [...candidates].sort(compareByScoreThenId);
  const ambiguous = isAmbiguous(ranked);
  const topScore = rankedScoring(ranked)[0]?.score ?? 0;

  return ranked.map((candidate, index) => {
    const base = explainMatch(draft, candidate);
    const tied = ambiguous && candidate.score > 0 && topScore - candidate.score <= AMBIGUITY_MARGIN;
    const verdict: ConfidenceVerdict = {
      ...base,
      autoSelectable: base.autoSelectable && index === 0 && !ambiguous,
      caveats: tied ? [...base.caveats, AMBIGUITY_CAVEAT] : base.caveats,
    };
    return { ...candidate, verdict };
  });
}
