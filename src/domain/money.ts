/**
 * Money: integer minor units + an ISO-4217 code. Never a float.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The brief demands "explicit semantics" for amounts. Three things go wrong in
 * expense apps, and all three are prevented here rather than downstream:
 *
 * 1. FLOATS. `19.99 * 100` is `1998.9999999999998`. Any code path that turns
 *    user text into minor units via multiplication is one rounding rule away
 *    from a one-cent discrepancy that no one can reconcile. This module parses
 *    the integer and fractional parts AS STRINGS and never multiplies.
 *
 * 2. ASSUMED EXPONENT. Defaulting an unknown currency to 2 decimals is how a
 *    JPY amount becomes 100x wrong: ¥500 stored as 50000 minor units reads back
 *    as ¥50,000. `exponentFor()` throws on anything it does not know.
 *
 * 3. SILENT ROUNDING. `1.999 USD` is a user typo, not a value to round. It is
 *    rejected so the user fixes it, rather than the app quietly deciding.
 *
 * The module is pure: no I/O, no clock, no randomness. Everything is a total
 * function of its arguments.
 */

import type { CurrencyCode, Money } from './types';

// ---------------------------------------------------------------------------
// Currency tables
// ---------------------------------------------------------------------------

/**
 * Currencies with NO minor unit. ¥500 is 500 minor units, not 50000.
 *
 * This is the full ISO-4217 exponent-0 set, not just the handful an app is
 * likely to see. A partial list is worse than no list: an unlisted zero-decimal
 * currency either throws (loud, fine) or gets assumed to be 2 (silent, 100x
 * wrong). Listing them all removes the second possibility entirely.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** Currencies with three decimal places — 1 BHD is 1000 fils. */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

/**
 * Ordinary two-decimal currencies we accept. Enumerated rather than treated as
 * "everything else" so that a typo ('EURO', 'US') is rejected instead of
 * silently becoming a valid-looking 2-decimal currency.
 */
const TWO_DECIMAL_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
  'AED',
  'ARS',
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'KES',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'TWD',
  'USD',
  'ZAR',
]);

/**
 * `CurrencyCode` is a bare `string` in the fixed contract, so the type system
 * cannot help us here — membership is checked at runtime, at every entry point.
 *
 * Deliberately CASE-SENSITIVE. The contract says codes are "uppercase by
 * construction"; accepting 'usd' here would make this function the place where
 * that invariant quietly stops being true. Normalising input is the caller's
 * job and should be visible in the caller.
 */
export function isSupportedCurrency(c: string): boolean {
  return (
    TWO_DECIMAL_CURRENCIES.has(c) ||
    ZERO_DECIMAL_CURRENCIES.has(c) ||
    THREE_DECIMAL_CURRENCIES.has(c)
  );
}

/**
 * The currency's minor-unit exponent: 2 for USD, 0 for JPY, 3 for BHD.
 *
 * Throws on an unknown code. This is the single most important "no" in the
 * module — see note 2 in the file header.
 */
export function exponentFor(currency: CurrencyCode): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  if (TWO_DECIMAL_CURRENCIES.has(currency)) return 2;
  throw new RangeError(
    `Unknown currency '${currency}': refusing to assume a minor-unit exponent. ` +
      `Assuming 2 would store JPY 100x wrong.`,
  );
}

// ---------------------------------------------------------------------------
// Parsing user text
// ---------------------------------------------------------------------------

export type ParseAmountResult =
  | { ok: true; minorUnits: number }
  | { ok: false; error: string };

/**
 * Untrusted-input guard. An amount field never legitimately contains 64
 * characters; anything longer is pasted junk and is rejected before it reaches
 * the regex.
 */
const MAX_INPUT_LENGTH = 64;

/**
 * Accepts either plain digits (`1234`) or correctly-grouped thousands
 * (`1,234`, `12,345,678`), optionally followed by a `.` fraction.
 *
 * It deliberately does NOT accept `1,50` or `1.234,56` (the European
 * convention). Those are genuinely ambiguous without a locale, and guessing
 * turns €1,50 into €150. We reject and let the UI ask.
 */
const AMOUNT_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/** ASCII hyphen-minus and the Unicode minus sign a numeric keypad may emit. */
const NEGATIVE_MARKERS = /[-−]/;

/**
 * Parse USER TEXT into minor units.
 *
 * Handles: surrounding whitespace, a leading ISO code or Unicode currency
 * symbol, and thousands separators.
 *
 * Rejects (rather than coercing): empty input, negatives, non-numeric text
 * including 'NaN'/'Infinity'/'1e5', ambiguous separator layouts, more decimal
 * places than the currency has, and values too large to hold exactly in a
 * JS number.
 *
 * Returns a result object rather than throwing — including for an unsupported
 * currency. Every failure here is something a UI must show to a user, and a
 * mixed throw/return contract guarantees some caller forgets the try/catch.
 * (`exponentFor()` still throws, because its callers have no user to tell.)
 */
export function parseAmountToMinorUnits(
  input: string,
  currency: CurrencyCode,
): ParseAmountResult {
  if (!isSupportedCurrency(currency)) {
    return { ok: false, error: `Unsupported currency '${currency}'.` };
  }
  const exponent = exponentFor(currency);

  if (input.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: 'Amount is too long to be a valid amount.' };
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Enter an amount.' };
  }

  // Negativity is checked on the RAW text, before any stripping, so that
  // '-$5.00', '$-5.00' and the accounting form '(5.00)' all fail the same way.
  if (NEGATIVE_MARKERS.test(trimmed) || /^\(.*\)$/.test(trimmed)) {
    return { ok: false, error: 'Amount cannot be negative.' };
  }

  let body = trimmed;

  // Strip one leading ISO code ('USD 19.99'), then any leading Unicode currency
  // symbols ('$', '€', '¥', '₹'...). Only these two forms are stripped: a bare
  // letter prefix like 'abc19' stays put and is rejected as junk below.
  if (body.startsWith(currency)) {
    body = body.slice(currency.length);
  }
  body = body.replace(/^\p{Sc}+/u, '').trim();

  if (body === '') {
    return { ok: false, error: 'Enter an amount.' };
  }

  // '.99' is a common shorthand; normalise it rather than reject it. This is
  // string surgery, not arithmetic, so no precision is involved.
  if (body.startsWith('.')) {
    body = `0${body}`;
  }

  const match = AMOUNT_RE.exec(body);
  if (match === null) {
    return {
      ok: false,
      error: `'${trimmed}' is not a valid amount. Use digits with an optional '.' decimal, e.g. 1,234.56`,
    };
  }

  const fraction = match[2] ?? '';
  if (fraction.length > exponent) {
    return {
      ok: false,
      error:
        exponent === 0
          ? `${currency} has no decimal places; enter a whole number.`
          : `${currency} has ${exponent} decimal places; '${trimmed}' has ${fraction.length}.`,
    };
  }

  // NOTE: trailing zeros beyond the exponent are rejected too ('500.00' JPY).
  // They lose no value, but accepting them means the app round-trips a
  // precision the currency does not have, and the user never learns that JPY
  // has no subunit. The error message says exactly what is wrong.

  const wholeDigits = (match[1] ?? '').replace(/,/g, '');
  // Right-pad the fraction to the exponent: '.5' in USD is 50 cents, not 5.
  const fractionDigits = fraction.padEnd(exponent, '0');

  const minorDigits = stripLeadingZeros(wholeDigits + fractionDigits);
  if (exceedsSafeInteger(minorDigits)) {
    return {
      ok: false,
      error: 'Amount is too large to record exactly.',
    };
  }

  // Safe: `minorDigits` is a digit-only string proven <= MAX_SAFE_INTEGER, so
  // Number() is exact. This is the only string->number conversion in the file.
  return { ok: true, minorUnits: minorDigits === '' ? 0 : Number(minorDigits) };
}

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+/, '');
}

/**
 * Compare a digit string against Number.MAX_SAFE_INTEGER without converting it
 * to a number first — converting is precisely the step that would lose the
 * information we are testing for.
 */
function exceedsSafeInteger(digits: string): boolean {
  const max = String(Number.MAX_SAFE_INTEGER); // '9007199254740991'
  if (digits.length !== max.length) return digits.length > max.length;
  // Equal-length digit strings compare lexicographically exactly as numbers do.
  return digits > max;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * `1999, 'USD'` -> `'19.99'`. Pure integer/string math — no division, so no
 * float ever appears.
 *
 * Negative values format with a leading '-'. `parseAmountToMinorUnits` refuses
 * negative user input, but refunds and correction deltas are legitimate stored
 * values, and a formatter that silently dropped the sign would be a bug.
 *
 * Throws on a non-integer or non-finite `minorUnits`: a fractional minor unit
 * means a float leaked into the pipeline, which is exactly what this module
 * exists to catch. Failing loudly beats printing '19.995'.
 */
export function formatMinorUnits(minorUnits: number, currency: CurrencyCode): string {
  if (!Number.isInteger(minorUnits)) {
    throw new RangeError(
      `minorUnits must be an integer, got ${minorUnits}. A fractional minor unit means a float leaked in.`,
    );
  }
  const exponent = exponentFor(currency);

  const negative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits));
  const sign = negative ? '-' : '';

  if (exponent === 0) return `${sign}${digits}`;

  // Pad to at least one whole digit plus `exponent` fraction digits, then cut.
  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);
  return `${sign}${whole}.${fraction}`;
}

/** e.g. `'USD 19.99'`. Code first: the number is meaningless without it. */
export function formatMoney(m: Money): string {
  return `${m.currency} ${formatMinorUnits(m.minorUnits, m.currency)}`;
}

/**
 * Equal amount AND equal currency. `1000 USD` and `1000 JPY` are not equal and
 * are not comparable; there is deliberately no cross-currency path here,
 * because that would require an exchange rate and a rate has a timestamp.
 */
export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minorUnits === b.minorUnits;
}
