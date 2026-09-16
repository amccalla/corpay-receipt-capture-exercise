/**
 * Extraction merge - the ONE door through which an automatic reading (barcode
 * or OCR) may touch a draft.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The brief's edge case 5 is "OCR returns after the user corrected the vendor
 * and amount". A late extraction arriving on a background queue MUST NOT undo
 * a human's correction. That rule is impossible to enforce if every screen and
 * every worker is free to spread extractor output over a draft, so no other
 * module writes `vendor`, `amountMinorUnits`, `currency` or `transactionDate`
 * from an extractor: they call `mergeExtraction()`, which is the only code that
 * consults `provenance`.
 *
 * THREE RULES, IN ORDER
 *
 * 1. PRECEDENCE DECIDES WHO MAY WRITE. `originMayOverwrite()` in types.ts is
 *    the whole policy: empty < ocr < barcode < user. A field owned by 'user' is
 *    never written by a machine again, and re-running the SAME extractor is a
 *    no-op (precedence is strict), which makes a retried or duplicated
 *    extraction harmless.
 *
 * 2. THE VALUE IS VALIDATED BEFORE IT IS WRITTEN. Extractor output is untrusted
 *    input with a TypeScript type sitting on top of it - the type is a promise
 *    made by the adapter, not a fact. A malformed value is REFUSED, never
 *    partially applied, so a bad reading cannot corrupt a draft that was
 *    previously correct.
 *
 * 3. AMOUNT AND CURRENCY ARE ONE VALUE (see MONEY IS ATOMIC below).
 *
 * PURITY: no clock, no randomness, no I/O. `now` is a parameter, and it is only
 * stamped onto the draft when something actually changed.
 */

import { isValidDateOnly, isValidInstant } from './dates';
import { formatMoney, isSupportedCurrency } from './money';
import type {
  CurrencyCode,
  DateOnly,
  FieldOrigin,
  FieldProvenance,
  Instant,
  Money,
  ReceiptDraft,
} from './types';
import { originMayOverwrite } from './types';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * What an extractor offers. Every field is nullable because a real extractor
 * reads smudged thermal paper and comes back with holes - see
 * `extractFromReceipt`, which drops fields independently on purpose.
 *
 * `currency` and `transactionDate` are typed as plain `string` rather than
 * `CurrencyCode`/`DateOnly` deliberately: neither alias is a validated type,
 * and the wider type is a reminder that these values arrive unchecked and leave
 * this module either validated or refused.
 */
export interface ExtractionInput {
  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: string | null;
  readonly transactionDate: string | null;
}

/**
 * What happened to one field. Emitted for every extractable field on every
 * call, applied or not, so a caller can log or surface "OCR read a vendor but
 * your correction was kept" instead of silently discarding the reading.
 *
 * `field` is the FieldProvenance key ('amount', not 'amountMinorUnits'), so an
 * outcome can be joined against provenance without a translation table.
 */
export type MergeFieldOutcome =
  | { field: string; applied: true; from: FieldOrigin; to: FieldOrigin; value: string }
  | {
      field: string;
      applied: false;
      reason: 'HELD_BY_HIGHER_PRECEDENCE' | 'NO_VALUE_OFFERED' | 'INVALID_VALUE';
      /**
       * The origin that owns the field this merge could not write. For a
       * coupled refusal (see MONEY IS ATOMIC) it is the owner of the OTHER half
       * of the money value - that is the origin a caller has to explain.
       */
      heldBy: FieldOrigin;
    };

export interface MergeResult {
  readonly draft: ReceiptDraft;
  readonly outcomes: readonly MergeFieldOutcome[];
  /** False when nothing was applied - the caller can skip the persist entirely. */
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

/**
 * A merchant name longer than this is not a merchant name; it is a page of OCR
 * noise that leaked out of a layout-detection failure. The cap keeps that out
 * of the database, the UI and the audit log.
 */
const MAX_VENDOR_CHARS = 200;

/**
 * C0/C1 control characters, plus the invisible and bidirectional formatting
 * marks that make one string render as another. A genuine merchant name in any
 * script contains none of them, and this module is a point where text derived
 * from an attacker-supplied image enters the record. Written as escapes so this
 * file stays greppable text.
 */
const CONTROL_CHARS =
  /[\x00-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/**
 * Minor units must be a NON-NEGATIVE SAFE integer.
 *
 * - A non-integer means a float leaked in, which is the exact failure money.ts
 *   exists to prevent; `formatMinorUnits` would throw on it downstream, so
 *   refusing here turns a crash in the UI into a refused reading.
 * - Beyond MAX_SAFE_INTEGER the value was already rounded on the way in, so we
 *   would be storing a number nobody ever read off a receipt.
 * - Negative: a receipt total is not negative. Refunds are their own document
 *   and are not what an extractor is looking at here.
 */
function isStorableMinorUnits(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Trimmed vendor, or null when the offered value is not a usable name. */
function cleanVendor(offered: string): string | null {
  // Trim only. Anything further (case-folding, collapsing whitespace, dropping
  // punctuation) is a matching concern and belongs in
  // `matching.normalizeMerchant` - it must not already have happened to the
  // value we store and show the user.
  const trimmed = offered.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_VENDOR_CHARS) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Per-field decisions
// ---------------------------------------------------------------------------

type RefusalReason = 'HELD_BY_HIGHER_PRECEDENCE' | 'NO_VALUE_OFFERED' | 'INVALID_VALUE';

type Decision<T> =
  | { readonly applied: true; readonly value: T }
  | { readonly applied: false; readonly reason: RefusalReason; readonly heldBy: FieldOrigin };

function refuse(reason: RefusalReason, heldBy: FieldOrigin): Decision<never> {
  return { applied: false, reason, heldBy };
}

function toOutcome<T>(
  field: string,
  decision: Decision<T>,
  from: FieldOrigin,
  to: FieldOrigin,
  render: (value: T) => string,
): MergeFieldOutcome {
  if (!decision.applied) {
    return { field, applied: false, reason: decision.reason, heldBy: decision.heldBy };
  }
  return { field, applied: true, from, to, value: render(decision.value) };
}

function decideVendor(
  offered: string | null,
  current: FieldOrigin,
  incoming: FieldOrigin,
): Decision<string> {
  if (offered === null) return refuse('NO_VALUE_OFFERED', current);
  // Precedence is checked BEFORE validity on purpose: a field this origin was
  // never entitled to write should report why it was locked rather than grade
  // the quality of a value that was never going to land. It also means hostile
  // text never even reaches the validators for a user-owned field.
  if (!originMayOverwrite(current, incoming)) return refuse('HELD_BY_HIGHER_PRECEDENCE', current);
  const cleaned = cleanVendor(offered);
  if (cleaned === null) return refuse('INVALID_VALUE', current);
  return { applied: true, value: cleaned };
}

function decideDate(
  offered: string | null,
  current: FieldOrigin,
  incoming: FieldOrigin,
): Decision<DateOnly> {
  if (offered === null) return refuse('NO_VALUE_OFFERED', current);
  if (!originMayOverwrite(current, incoming)) return refuse('HELD_BY_HIGHER_PRECEDENCE', current);
  // No trimming, no repair, no second date parser: dates.ts is the only thing
  // in this codebase that decides what a DateOnly is, and it refuses values
  // that "just need cleaning up" precisely because cleaning them up silently is
  // how a typo becomes a plausible wrong date.
  if (!isValidDateOnly(offered)) return refuse('INVALID_VALUE', current);
  return { applied: true, value: offered };
}

/**
 * MONEY IS ATOMIC.
 *
 * `amountMinorUnits` is meaningless without the currency it was read in: the
 * integer 2400 is 24.00 USD or 2400 JPY depending on the exponent, and that is
 * a 100x error, silent, in the direction of over-reimbursement. So this module
 * treats {amount, currency} as ONE money value with two provenance slots, and
 * enforces:
 *
 *   A. AN AMOUNT IS ONLY EVER WRITTEN ALONGSIDE THE CURRENCY IT WAS READ IN.
 *      The extraction must offer a supported currency, and the draft must end
 *      this merge holding exactly that currency. A bare amount with no currency
 *      is refused outright - `extractFromReceipt` drops the currency
 *      independently of the amount ("a smudged currency symbol over a legible
 *      total"), and inferring the draft's existing code, or USD, is the
 *      papering-over that causes the bug.
 *
 *   B. A CURRENCY IS ONLY WRITTEN WHEN IT CANNOT RE-DENOMINATE SOMEONE ELSE'S
 *      NUMBER. Writing a currency onto a draft that already holds an amount
 *      rewrites what that amount MEANS, so it is allowed only when the amount
 *      is replaced in the same merge, when there is no amount yet, or when the
 *      code is not actually changing. This bites even for a higher-precedence
 *      origin: a barcode that reads 'JPY' but no total may not re-denominate an
 *      OCR'd 2400 into 2400 yen. It never read that number, so it does not get
 *      to redefine it.
 *
 * The one relaxation is safe in both directions: when the offered currency
 * EQUALS the one the draft already holds, the amount may land alone (its
 * interpretation is unchanged) and a currency write is a pure provenance
 * upgrade.
 */
function decideMoney(
  draft: ReceiptDraft,
  input: ExtractionInput,
  incoming: FieldOrigin,
): { readonly amount: Decision<Money>; readonly currency: Decision<CurrencyCode> } {
  const { amount: amountOrigin, currency: currencyOrigin } = draft.provenance;
  const offeredAmount = input.amountMinorUnits;
  const offeredCurrency = input.currency;

  // "Eligible" = the amount half passes its own three gates (offered, allowed,
  // valid). Rule B needs this, and deriving it from the amount's own gates -
  // never from the amount's final decision - is what keeps the two decisions
  // acyclic.
  const amountEligible =
    offeredAmount !== null &&
    originMayOverwrite(amountOrigin, incoming) &&
    isStorableMinorUnits(offeredAmount);

  let currency: Decision<CurrencyCode>;
  if (offeredCurrency === null) {
    currency = refuse('NO_VALUE_OFFERED', currencyOrigin);
  } else if (!originMayOverwrite(currencyOrigin, incoming)) {
    currency = refuse('HELD_BY_HIGHER_PRECEDENCE', currencyOrigin);
  } else if (!isSupportedCurrency(offeredCurrency)) {
    // Case-sensitive, per money.ts's contract: 'usd' is refused rather than
    // up-cased. An extractor that cannot emit a canonical ISO-4217 code has not
    // earned the benefit of the doubt on the digits it emitted either.
    currency = refuse('INVALID_VALUE', currencyOrigin);
  } else if (
    offeredCurrency !== draft.currency &&
    draft.amountMinorUnits !== null &&
    !amountEligible
  ) {
    // Rule B. `heldBy` is the AMOUNT's origin: the currency is blocked by
    // whoever owns the number it would have re-denominated.
    currency = refuse('HELD_BY_HIGHER_PRECEDENCE', amountOrigin);
  } else {
    currency = { applied: true, value: offeredCurrency };
  }

  const targetCurrency = currency.applied ? currency.value : draft.currency;

  let amount: Decision<Money>;
  if (offeredAmount === null) {
    amount = refuse('NO_VALUE_OFFERED', amountOrigin);
  } else if (!originMayOverwrite(amountOrigin, incoming)) {
    amount = refuse('HELD_BY_HIGHER_PRECEDENCE', amountOrigin);
  } else if (!isStorableMinorUnits(offeredAmount)) {
    amount = refuse('INVALID_VALUE', amountOrigin);
  } else if (offeredCurrency === null || !isSupportedCurrency(offeredCurrency)) {
    // Rule A. A count of minor units with no currency code is not a Money and
    // is not storable as one, however plausible the digits look.
    amount = refuse('INVALID_VALUE', amountOrigin);
  } else if (targetCurrency !== offeredCurrency) {
    // Rule A. The amount was read in a currency this draft will not be holding
    // - the currency half belongs to an origin this one cannot overrule - so
    // the number would land under the wrong code. Refuse the whole value.
    amount = refuse('HELD_BY_HIGHER_PRECEDENCE', currencyOrigin);
  } else {
    amount = { applied: true, value: { minorUnits: offeredAmount, currency: offeredCurrency } };
  }

  return { amount, currency };
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * Apply an automatic extraction to a draft.
 *
 * Returns the draft UNCHANGED - the same object reference - when nothing was
 * applied, so `changed === false` is a reliable signal to skip the write.
 * `updatedAt` is stamped with `now` only when something actually landed: an
 * extraction that changed nothing must not make a draft look freshly touched.
 *
 * Never touches `state`, `serverReceiptId`, `idempotencyKey`, `companyId`,
 * `localId` or the match fields. An extraction is a statement about what the
 * paper says, never about what the server did or which company owns the record.
 *
 * @throws RangeError if `now` is not a canonical UTC Instant. `updatedAt` is an
 * audit field that the rest of the app orders as a plain string, so a
 * non-canonical value poisons comparisons far away from here.
 */
export function mergeExtraction(
  draft: ReceiptDraft,
  input: ExtractionInput,
  origin: FieldOrigin,
  now: Instant,
): MergeResult {
  if (!isValidInstant(now)) {
    throw new RangeError(
      `mergeExtraction needs a canonical UTC Instant for 'now', got ${JSON.stringify(now)}`,
    );
  }

  const prov = draft.provenance;

  // An 'empty' incoming origin needs no special case: ORIGIN_PRECEDENCE ranks
  // it lowest and overwriting is strict, so "nobody" can never write a field -
  // including one that is itself still empty.
  const vendor = decideVendor(input.vendor, prov.vendor, origin);
  const money = decideMoney(draft, input, origin);
  const transactionDate = decideDate(input.transactionDate, prov.transactionDate, origin);

  const outcomes: readonly MergeFieldOutcome[] = [
    toOutcome('vendor', vendor, prov.vendor, origin, (v) => v),
    // Rendered through money.ts as 'USD 18.99': an amount printed on its own is
    // exactly the ambiguity this module refuses to traffic in, so the outcome
    // log does not print one either.
    toOutcome('amount', money.amount, prov.amount, origin, formatMoney),
    toOutcome('currency', money.currency, prov.currency, origin, (v) => v),
    toOutcome('transactionDate', transactionDate, prov.transactionDate, origin, (v) => v),
  ];

  const changed = outcomes.some((o) => o.applied);
  if (!changed) {
    // The same reference, not a copy: a cheap identity check for callers, and
    // proof that a refused merge cannot have mutated anything.
    return { draft, outcomes, changed: false };
  }

  // Every applied write strictly raises its field's origin (precedence is a
  // strict comparison), so provenance always differs when `changed` is true.
  const nextProvenance: FieldProvenance = {
    vendor: vendor.applied ? origin : prov.vendor,
    amount: money.amount.applied ? origin : prov.amount,
    currency: money.currency.applied ? origin : prov.currency,
    transactionDate: transactionDate.applied ? origin : prov.transactionDate,
  };

  const nextDraft: ReceiptDraft = {
    ...draft,
    vendor: vendor.applied ? vendor.value : draft.vendor,
    amountMinorUnits: money.amount.applied ? money.amount.value.minorUnits : draft.amountMinorUnits,
    currency: money.currency.applied ? money.currency.value : draft.currency,
    transactionDate: transactionDate.applied ? transactionDate.value : draft.transactionDate,
    provenance: nextProvenance,
    updatedAt: now,
  };

  return { draft: nextDraft, outcomes, changed: true };
}

// ---------------------------------------------------------------------------
// Provenance for human entry
// ---------------------------------------------------------------------------

/** What the capture form actually received from the person using it. */
export interface UserEntry {
  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  /**
   * Whether the person actively chose a currency, as opposed to accepting
   * whatever the form defaulted to. These are NOT the same event and recording
   * them as if they were is a lie about who decided.
   */
  readonly currencyChosen: boolean;
  readonly transactionDate: string | null;
}

/**
 * Build the provenance for a human-entered form.
 *
 * A field is marked 'user' ONLY if the person actually supplied it. The obvious
 * shortcut - stamp all four as 'user' whenever the form is saved - is wrong in a
 * way that is easy to miss: the currency picker starts on a default, so a user
 * who photographs a euro receipt, types the amount and never notices the
 * picker would have 'USD' recorded as a human decision and locked against
 * correction forever.
 *
 * Leaving an untouched field 'empty' is safe because the amount is still
 * protected: `mergeExtraction`'s Rule B refuses a currency change that would
 * re-denominate an amount the incoming origin cannot overwrite. So an
 * extraction may fill a blank the user left, but it can never quietly restate
 * the number they typed in a different currency.
 */
export function provenanceForUserEntry(entry: UserEntry): FieldProvenance {
  const has = (v: string | null): boolean => v !== null && v.trim() !== '';
  return {
    vendor: has(entry.vendor) ? 'user' : 'empty',
    amount: entry.amountMinorUnits !== null ? 'user' : 'empty',
    currency: entry.currencyChosen ? 'user' : 'empty',
    transactionDate: has(entry.transactionDate) ? 'user' : 'empty',
  };
}
