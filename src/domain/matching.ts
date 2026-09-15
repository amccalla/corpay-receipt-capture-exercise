/**
 * Receipt-to-card-transaction matching.
 *
 * This module answers one question — "which seeded card transactions could this
 * receipt be?" — and it answers it the same way every time. It is pure: no
 * clock, no randomness, no I/O. Every score is a deterministic function of the
 * two records and the options, so a candidate list can be snapshotted in a test
 * and explained to a user in the UI.
 *
 * Three rules drive the design, and all three come from the brief:
 *
 * 1. COMPANY IS A SECURITY BOUNDARY, NOT A FILTER.
 *    `findMatchCandidates` drops every transaction from another company before
 *    scoring, and `scoreMatch` independently returns 0 for a cross-company
 *    pair. Two gates, because leaking one company's card transactions into
 *    another company's match picker is a data breach, not a UI glitch.
 *
 * 2. DIFFERENT CURRENCIES ARE NOT COMPARABLE AMOUNTS.
 *    A currency mismatch scores 0 and is never a candidate. See `scoreMatch`.
 *
 * 3. ONE TRANSACTION, ONE RECEIPT — AND SAYING SO OUT LOUD.
 *    Edge case 6 ("two receipts matched to the same card transaction") is
 *    handled by *showing* the conflict, not by hiding it: a transaction another
 *    receipt already claimed still appears in the candidate list, flagged
 *    `blocked` with a human-readable reason, and `canAssignMatch` refuses the
 *    write. Filtering it out silently would leave the user staring at a perfect
 *    amount/date match that mysteriously is not offered.
 */

import {
  dateOnlyIsWithinDays,
  daysBetweenDateOnly,
  instantToDateOnlyUTC,
  isValidDateOnly,
  isValidInstant,
} from './dates';
import { moneyEquals } from './money';
import type { DateOnly, Money, ReceiptDraft, Transaction } from './types';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type MatchReason =
  | 'AMOUNT_EXACT'
  | 'AMOUNT_NEAR'
  | 'CURRENCY_MATCH'
  | 'MERCHANT_EXACT'
  | 'MERCHANT_FUZZY'
  | 'DATE_EXACT'
  | 'DATE_NEAR';

export interface MatchCandidate {
  readonly transaction: Transaction;
  /** 0..100, deterministic. 0 means "never offer this". */
  readonly score: number;
  readonly reasons: MatchReason[];
  readonly isExact: boolean;
  /** True when a DIFFERENT receipt already owns this transaction. */
  readonly blocked: boolean;
  readonly blockedReason: string | null;
}

// ---------------------------------------------------------------------------
// Tuning constants
//
// Private on purpose: they are a scoring policy, not a public contract. The
// weights sum to exactly 100 so a perfect match scores 100 without clamping,
// which makes the number meaningful rather than arbitrary.
// ---------------------------------------------------------------------------

const W_AMOUNT_EXACT = 50;
const W_AMOUNT_NEAR_MAX = 45;
const W_AMOUNT_NEAR_MIN = 15;
const W_CURRENCY = 10;
const W_MERCHANT_EXACT = 25;
const W_MERCHANT_FUZZY_MAX = 18;
const W_DATE_EXACT = 15;
/** Points lost per calendar day of drift, floored at 1 so DATE_NEAR is never free. */
const DATE_NEAR_DECAY_PER_DAY = 4;

/**
 * Amount counts as "near" within 5% of the transaction. Relative rather than
 * absolute because the reasons an amount drifts are proportional (FX spread on
 * a foreign card, a percentage service fee, a rounding difference) and because
 * an absolute threshold would need the currency's minor-unit exponent to mean
 * anything — 100 minor units is $1.00 but ¥100.
 *
 * A restaurant tip added after the receipt printed is a much larger, and much
 * more ambiguous, gap; widening this band to swallow it would start matching
 * genuinely different purchases. That is a business decision, not a constant.
 */
const AMOUNT_NEAR_RATIO = 0.05;

/**
 * Dice-coefficient floor for MERCHANT_FUZZY. Below this, two names share so
 * little that "SQ *BLUE BOTTLE" and "BLUEBIRD TAXI" would start pairing up.
 */
const MERCHANT_FUZZY_THRESHOLD = 0.6;

/**
 * Card networks settle one to three days after the merchant's printed date, so
 * `occurredAt` routinely lags `transactionDate`. The window also absorbs the
 * one-day error inherent in projecting an instant onto a UTC calendar day (see
 * `transactionCalendarDate`).
 */
const DEFAULT_DATE_TOLERANCE_DAYS = 3;

/** Top-N for a picker list. Callers that want everything pass a large limit. */
const DEFAULT_CANDIDATE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Merchant normalization
// ---------------------------------------------------------------------------

/**
 * Legal-form and filler tokens removed anywhere in the name. "Starbucks" and
 * "Starbucks Inc." are the same coffee shop; the suffix is registry noise that
 * appears on one side of the comparison and not the other.
 *
 * Deliberately conservative: two-letter forms that double as real words or name
 * fragments (AB, AS, OY) are NOT here, because stripping them would mangle more
 * names than it fixes.
 */
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  'THE',
  'AND',
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'LP',
  'LTD',
  'LTDA',
  'PLC',
  'CO',
  'CORP',
  'CORPORATION',
  'COMPANY',
  'GMBH',
  'AG',
  'SA',
  'SAS',
  'SARL',
  'BV',
  'NV',
  'PTY',
  'PTE',
  'SPA',
  'SRL',
  // Statement filler that is never brand-distinctive on its own.
  'STORE',
  'LOCATION',
  'BRANCH',
]);

/**
 * US state codes, removed only from the END of the name, where card statements
 * append the location: "STARBUCKS STORE 1234 SEATTLE WA 98101".
 *
 * Trailing-only for a reason — "LA TAQUERIA" must keep its "LA", and "IN-N-OUT"
 * its "IN". City names are NOT stripped: there is no safe finite list of them,
 * and guessing would delete real brand words. The leftover city token is
 * handled by fuzzy scoring instead, which tolerates an extra token on one side.
 */
const TRAILING_STATE_TOKENS: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

/** Combining diacritical marks left behind by NFKD decomposition. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Acquirer/processor tag that card networks prefix before an asterisk:
 * "SQ *BLUE BOTTLE", "TST* THE PICKLE", "PAYPAL *STEAM". The tag identifies the
 * payment processor, not the merchant, so it is pure noise for matching.
 */
const PROCESSOR_PREFIX = /^[A-Z0-9]{1,8}\s*\*+\s*/;

const ALL_DIGITS = /^\d+$/;

/**
 * Canonical form of a merchant name for comparison. Deterministic and
 * idempotent: `normalizeMerchant(normalizeMerchant(s)) === normalizeMerchant(s)`.
 *
 * What is stripped, and why each one:
 *  - Diacritics ("CAFÉ" -> "CAFE") — the receipt and the card network disagree
 *    about accents constantly.
 *  - Case — casefolded to upper.
 *  - A processor prefix before '*' (see PROCESSOR_PREFIX).
 *  - Periods and apostrophes are DELETED rather than split on, so "L.L.C."
 *    collapses to "LLC" and "MCDONALD'S" to "MCDONALDS"; every other
 *    punctuation mark becomes a space, so "WAL-MART" tokenizes as two words.
 *  - Store numbers, ZIP codes and a trailing US state code (see
 *    `stripLocationAndStoreNumbers`).
 *  - Legal-form and filler tokens anywhere (see NOISE_TOKENS).
 *
 * If stripping would empty the name, the pre-strip token list is returned
 * instead: a merchant genuinely called "The Co" should normalize to something,
 * not to nothing, because an empty string would silently match every other
 * over-stripped name.
 */
export function normalizeMerchant(s: string): string {
  const folded = s.normalize('NFKD').replace(COMBINING_MARKS, '').toUpperCase();
  const deAbbreviated = folded.replace(/[.'’]/g, '');
  const withoutProcessor = deAbbreviated.replace(PROCESSOR_PREFIX, '');
  // Anything that is not a letter or digit is a word boundary.
  const tokens = withoutProcessor.split(/[^A-Z0-9]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';

  const trimmed = stripLocationAndStoreNumbers(tokens);
  const denoised = trimmed.filter((t) => !NOISE_TOKENS.has(t));
  // Fall back to the UNSTRIPPED tokens rather than return '' — see doc comment.
  // Falling back to `trimmed` would not be enough: 'CO' is both a legal suffix
  // and Colorado, so "The Co" loses its second token to the state strip before
  // the noise filter ever runs, and would normalize to a bare "THE".
  return (denoised.length > 0 ? denoised : tokens).join(' ');
}

/**
 * Drop store numbers, ZIP codes and a trailing state code, keeping at least one
 * token.
 *
 * Digit-only tokens go from ANYWHERE except the first position: a store number
 * can sit in the middle ("7-ELEVEN #32104 AUSTIN TX"), while a LEADING number
 * is usually part of the brand ("7-Eleven", "99 Ranch Market") and deleting it
 * would turn two different chains into the same name. The state code is popped
 * afterwards, so a "SEATTLE WA 98101" tail collapses in the right order.
 */
function stripLocationAndStoreNumbers(tokens: string[]): string[] {
  const out = tokens.filter((t, i) => i === 0 || !ALL_DIGITS.test(t));
  while (out.length > 1) {
    const last = out[out.length - 1];
    if (last === undefined || !TRAILING_STATE_TOKENS.has(last)) break;
    out.pop();
  }
  return out.length > 0 ? out : tokens.slice();
}

// ---------------------------------------------------------------------------
// Fuzzy similarity — Sørensen–Dice over character bigrams
//
// Chosen over Levenshtein because it is order-insensitive at the character-pair
// level (so a reordered token pair still scores well), needs no matrix, and is
// stable: the same two strings always produce the same number, which is what
// makes candidate ordering reproducible.
// ---------------------------------------------------------------------------

function bigramCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i += 1) {
    const gram = s.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const left = bigramCounts(a);
  const right = bigramCounts(b);
  let overlap = 0;
  let total = 0;
  left.forEach((n, gram) => {
    total += n;
    const other = right.get(gram);
    if (other !== undefined) overlap += Math.min(n, other);
  });
  right.forEach((n) => {
    total += n;
  });
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * 0..1 similarity between two ALREADY-NORMALIZED merchant names.
 *
 * Comparison happens with spaces removed, so tokenization differences
 * ("WAL MART" vs "WALMART") do not cost anything. Containment scores high
 * because statements truncate and extend names constantly — "STARBUCKS" vs
 * "STARBUCKS PIKE PLACE" is the same merchant, not a 0.6 coincidence — but only
 * when the shorter side is long enough to be distinctive, otherwise "CO" would
 * be 90% of every name containing it.
 */
function merchantSimilarity(aNorm: string, bNorm: string): number {
  if (aNorm.length === 0 || bNorm.length === 0) return 0;
  if (aNorm === bNorm) return 1;
  const a = aNorm.replace(/ /g, '');
  const b = bNorm.replace(/ /g, '');
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 5 && (a.includes(b) || b.includes(a))) return 0.9;
  return diceCoefficient(a, b);
}

// ---------------------------------------------------------------------------
// Currency and date helpers
// ---------------------------------------------------------------------------

/**
 * money.ts is deliberately case-sensitive and says normalizing "is the caller's
 * job and should be visible in the caller". This is that visible place: OCR
 * output and seeded fixtures are untrusted input, so codes are trimmed and
 * upper-cased exactly once, here, before any comparison.
 */
function canonicalCurrency(c: string): string {
  return c.trim().toUpperCase();
}

function sameCurrency(a: string, b: string): boolean {
  return canonicalCurrency(a) === canonicalCurrency(b);
}

/**
 * The UTC calendar day a card transaction cleared on, or null if `occurredAt`
 * is not a well-formed instant.
 *
 * This IS the lossy projection dates.ts warns about, and it is used knowingly:
 * comparing a printed receipt date to a settlement timestamp is a cross-kind
 * comparison and there is no exact answer. The mitigation is that the result is
 * never treated as an equality oracle on its own — a same-day hit is worth more
 * than a near hit, and DEFAULT_DATE_TOLERANCE_DAYS is wide enough to cover both
 * settlement lag and a one-day timezone shift. Crucially, nothing here ever
 * writes back to `draft.transactionDate`, which is the failure dates.ts forbids.
 *
 * Returns null instead of throwing: a malformed `occurredAt` costs the pair its
 * date points but must not blow up the user's candidate list.
 */
function transactionCalendarDate(txn: Transaction): DateOnly | null {
  return isValidInstant(txn.occurredAt) ? instantToDateOnlyUTC(txn.occurredAt) : null;
}

function resolveDateTolerance(days: number | undefined): number {
  if (days === undefined) return DEFAULT_DATE_TOLERANCE_DAYS;
  // A negative or fractional window is a caller bug; degrade to same-day-only
  // rather than throwing inside a scoring loop the UI runs on every keystroke.
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.floor(days);
}

// ---------------------------------------------------------------------------
// Exact match
// ---------------------------------------------------------------------------

/**
 * The strict definition: same money (amount AND currency, via money.ts's
 * `moneyEquals`) and the same calendar date. Merchant is deliberately NOT part
 * of it — merchant strings are the noisiest field on both sides, and a receipt
 * that agrees on money and day is exact regardless of whether the statement
 * calls it "SQ *BLUE BOTTLE".
 *
 * Any missing field makes this false: "unknown" is not "equal".
 */
export function isExactMatch(draft: ReceiptDraft, txn: Transaction): boolean {
  const { amountMinorUnits, currency, transactionDate } = draft;
  if (amountMinorUnits === null || currency === null || transactionDate === null) return false;
  if (!isValidDateOnly(transactionDate)) return false;

  const draftMoney: Money = { minorUnits: amountMinorUnits, currency: canonicalCurrency(currency) };
  const txnMoney: Money = { minorUnits: txn.amountMinorUnits, currency: canonicalCurrency(txn.currency) };
  if (!moneyEquals(draftMoney, txnMoney)) return false;

  const txnDate = transactionCalendarDate(txn);
  return txnDate !== null && txnDate === transactionDate;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score one (receipt, transaction) pair from 0 to 100.
 *
 * WHY A CURRENCY MISMATCH IS A HARD 0, NOT A PENALTY:
 * two different currencies are not comparable amounts. Deciding whether EUR
 * 45.00 "is" USD 48.60 requires an FX rate, and a rate is only defined together
 * with a date, a direction and a spread — it is a business decision with money
 * riding on it, not a string comparison this module is entitled to make. So the
 * pair scores 0 and never becomes a candidate, and the amount contributes
 * nothing even to the merchant/date signals.
 *
 * For the same reason an amount with no currency earns no amount points: a bare
 * 1999 is not money, and 1999 JPY is not 1999 USD.
 */
export function scoreMatch(
  draft: ReceiptDraft,
  txn: Transaction,
  opts?: { dateToleranceDays?: number },
): MatchCandidate {
  const blockedReason = matchBlockedReason(txn, draft.localId);
  const blocked = blockedReason !== null;

  // Gate 1 of 2 on the company boundary (findMatchCandidates is gate 2).
  // Exact string equality: a boundary that tolerates whitespace is not a
  // boundary.
  if (txn.companyId !== draft.companyId) {
    return { transaction: txn, score: 0, reasons: [], isExact: false, blocked, blockedReason };
  }

  const draftCurrency = draft.currency;
  const currencyMatches = draftCurrency !== null && sameCurrency(draftCurrency, txn.currency);
  // Known-but-different is a hard stop. Unknown (null) is not a mismatch: it
  // just means the amount cannot be scored, which the amount block enforces.
  if (draftCurrency !== null && !currencyMatches) {
    return { transaction: txn, score: 0, reasons: [], isExact: false, blocked, blockedReason };
  }

  const reasons: MatchReason[] = [];
  let score = 0;

  // --- Amount (only meaningful once currency is known to agree) ---
  if (currencyMatches && draft.amountMinorUnits !== null) {
    const delta = Math.abs(draft.amountMinorUnits - txn.amountMinorUnits);
    if (delta === 0) {
      score += W_AMOUNT_EXACT;
      reasons.push('AMOUNT_EXACT');
    } else if (txn.amountMinorUnits !== 0) {
      const ratio = delta / Math.abs(txn.amountMinorUnits);
      if (ratio <= AMOUNT_NEAR_RATIO) {
        // Linear decay across the band, so a 0.1% drift outranks a 4.9% drift.
        const span = W_AMOUNT_NEAR_MAX - W_AMOUNT_NEAR_MIN;
        score += Math.round(W_AMOUNT_NEAR_MAX - (ratio / AMOUNT_NEAR_RATIO) * span);
        reasons.push('AMOUNT_NEAR');
      }
    }
  }

  // --- Currency ---
  if (currencyMatches) {
    score += W_CURRENCY;
    reasons.push('CURRENCY_MATCH');
  }

  // --- Merchant ---
  if (draft.vendor !== null) {
    const similarity = merchantSimilarity(normalizeMerchant(draft.vendor), normalizeMerchant(txn.merchant));
    if (similarity === 1) {
      score += W_MERCHANT_EXACT;
      reasons.push('MERCHANT_EXACT');
    } else if (similarity >= MERCHANT_FUZZY_THRESHOLD) {
      score += Math.round(similarity * W_MERCHANT_FUZZY_MAX);
      reasons.push('MERCHANT_FUZZY');
    }
  }

  // --- Date ---
  const tolerance = resolveDateTolerance(opts?.dateToleranceDays);
  const txnDate = transactionCalendarDate(txn);
  const draftDate = draft.transactionDate;
  if (txnDate !== null && draftDate !== null && isValidDateOnly(draftDate)) {
    if (txnDate === draftDate) {
      score += W_DATE_EXACT;
      reasons.push('DATE_EXACT');
    } else if (dateOnlyIsWithinDays(draftDate, txnDate, tolerance)) {
      const drift = Math.abs(daysBetweenDateOnly(draftDate, txnDate));
      score += Math.max(1, W_DATE_EXACT - DATE_NEAR_DECAY_PER_DAY * drift);
      reasons.push('DATE_NEAR');
    }
  }

  return {
    transaction: txn,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    isExact: isExactMatch(draft, txn),
    blocked,
    blockedReason,
  };
}

// ---------------------------------------------------------------------------
// Candidate search
// ---------------------------------------------------------------------------

/**
 * Ranked candidates for a draft, scoped to the draft's company.
 *
 * THE COMPANY FILTER IS A SECURITY BOUNDARY. `draft.companyId` is stamped at
 * capture time and never rewritten (see types.ts), so it remains correct even
 * when the app was killed and relaunched under a different company — edge case
 * 3. A transaction belonging to any other company is dropped here before it is
 * scored, so it cannot appear in a picker, a log line, or an error message,
 * however perfectly it matches on amount, date and merchant.
 *
 * ORDERING IS TOTAL AND INPUT-ORDER-INDEPENDENT: score descending, then
 * transaction id ascending. The id tiebreak matters because the seeded data is
 * deliberately close-but-not-identical, so ties are common; without it the list
 * would reshuffle whenever the transaction array arrived in a different order,
 * and "the top suggestion moved" is indistinguishable from a matching bug.
 *
 * Blocked transactions are RETAINED (see the file header): the conflict has to
 * be visible for the user to understand why they cannot have it.
 */
export function findMatchCandidates(
  draft: ReceiptDraft,
  transactions: Transaction[],
  opts?: { dateToleranceDays?: number; limit?: number },
): MatchCandidate[] {
  const limit = resolveLimit(opts?.limit);
  if (limit === 0) return [];

  const scored: MatchCandidate[] = [];
  for (const txn of transactions) {
    if (txn.companyId !== draft.companyId) continue;
    const candidate = scoreMatch(draft, txn, opts);
    // Score 0 means "no comparable evidence" (currency mismatch, or nothing in
    // common at all). Offering it would be noise.
    if (candidate.score <= 0) continue;
    scored.push(candidate);
  }

  scored.sort(compareCandidates);
  return scored.slice(0, limit);
}

function compareCandidates(a: MatchCandidate, b: MatchCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  // Raw code-unit comparison, not localeCompare: locale-aware collation depends
  // on the device's locale, which would make ordering environment-dependent.
  if (a.transaction.id < b.transaction.id) return -1;
  if (a.transaction.id > b.transaction.id) return 1;
  return 0;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

// ---------------------------------------------------------------------------
// Assignment guard — edge case 6
// ---------------------------------------------------------------------------

/** Shared by `scoreMatch` (to explain) and `canAssignMatch` (to refuse). */
function matchBlockedReason(txn: Transaction, receiptLocalId: string): string | null {
  const owner = txn.matchedReceiptId;
  if (owner === null || owner === receiptLocalId) return null;
  return `Transaction ${txn.id} is already matched to receipt ${owner}. A card transaction can have at most one receipt.`;
}

/**
 * May `receiptLocalId` be written into `txn.matchedReceiptId`?
 *
 * IDEMPOTENT BY DESIGN. Re-assigning the SAME receipt to the SAME transaction
 * is `ok: true`, and that is load-bearing, not politeness: edge case 1 is a
 * successful upload whose response was lost. The retry replays the same
 * idempotency key, the server returns the original record with the match
 * already saved, and the client re-applies it. If that second write failed, a
 * lost ACK would permanently strand the receipt in an error state — the retry
 * would be punished for having succeeded the first time.
 *
 * `matchedReceiptId` holds a receipt's device-local id, matching the parameter
 * `canAssignMatch` takes; the local id is the identifier that exists from the
 * moment of capture and survives a retry, whereas `serverReceiptId` is null
 * until the server has already answered.
 *
 * This guard does NOT check the company boundary, because a Transaction alone
 * cannot prove which company the receipt belongs to. Callers must scope
 * transactions with `findMatchCandidates` first.
 */
export function canAssignMatch(
  txn: Transaction,
  receiptLocalId: string,
): { ok: true } | { ok: false; reason: string } {
  if (receiptLocalId.length === 0) {
    return { ok: false, reason: 'Refusing to assign a match to an empty receipt id.' };
  }
  const reason = matchBlockedReason(txn, receiptLocalId);
  return reason === null ? { ok: true } : { ok: false, reason };
}
