/**
 * Calendar-date and instant semantics.
 *
 * The brief requires that "date-only values and timestamps have explicit
 * semantics". This module is where that requirement is cashed out, so the rest
 * of the app never has to reason about it:
 *
 *   DateOnly ('YYYY-MM-DD')  — a CALENDAR date. No time, no timezone, no
 *                              offset. It is the date printed on the receipt,
 *                              in the merchant's own calendar. It denotes a
 *                              day, not a moment.
 *
 *   Instant  (ISO-8601 UTC)  — an absolute MOMENT on the timeline. Audit
 *                              fields, `occurredAt` on a card transaction.
 *
 * These are different kinds, not different formats of one kind. Converting
 * between them requires inventing information (a timezone), and inventing it
 * wrongly is the classic off-by-one-day bug: a 2026-01-01 receipt rendering as
 * 2025-12-31 for a user at UTC-5. There is exactly ONE conversion function here
 * (`instantToDateOnlyUTC`), it only goes instant -> date, and its doc comment
 * says in capitals where it may and may not be used. There is deliberately no
 * dateOnlyToInstant().
 *
 * PURITY: no Date, no Date.now(), no Intl, no locale, no I/O. All arithmetic is
 * exact integer civil-calendar arithmetic, and "today" is always an injected
 * parameter. That makes every function here deterministic and total: same
 * input, same output, on any device in any timezone, forever.
 */

import type { DateOnly, Instant } from './types';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Strict shape only — it says nothing about whether the date exists. Shape and
 * calendar validity are checked separately because '2026-02-30' passes the
 * first and must fail the second. (Note what we do NOT do: `new Date(s)` is
 * useless as a validator, since new Date('2026-02-30') silently rolls over to
 * March 2 rather than failing.)
 */
const DATE_ONLY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonical UTC instant. The trailing 'Z' is REQUIRED: `Instant` is defined as
 * UTC, and pinning one canonical serialization is what lets instants be
 * compared and deduplicated as plain strings elsewhere in the app. A
 * '+02:00' timestamp is a valid ISO-8601 string but is not an `Instant` as this
 * codebase defines it; normalize it at the network boundary, not here.
 *
 * Fractional seconds are accepted at 1-9 digits because real servers emit
 * milliseconds and Postgres emits microseconds. We EMIT exactly 3. Beware:
 * lexicographic ordering of instants is only sound when precision is uniform,
 * so callers that sort by string must normalize first.
 */
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Index 0 is January. */
const DAYS_IN_MONTH_COMMON = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Fixed English abbreviations. Intentionally NOT Intl.DateTimeFormat: that is
 * locale- and ICU-version-dependent, which would make rendering differ between
 * an iOS device, an Android device and CI. Receipt dates must read identically
 * everywhere, including in an exported audit trail. Real localization belongs
 * in the presentation layer with an explicit locale argument.
 */
const MONTH_ABBREV = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** 'YYYY' can only represent years 0000-9999; anything else is unrepresentable. */
const MIN_YEAR = 0;
const MAX_YEAR = 9999;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Proleptic Gregorian leap rule: every 4, except every 100, except every 400. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH_COMMON[month - 1] ?? 0;
}

/** Does this (y, m, d) triple name a day that actually exists? */
function isValidCivilDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Howard Hinnant's days-from-civil algorithm: the number of days from
 * 1970-01-01 to (y, m, d) in the proleptic Gregorian calendar.
 *
 * Deliberately NOT `(Date.parse(b) - Date.parse(a)) / 86400000`. Millisecond
 * math on local-time Dates is DST-sensitive — across a spring-forward boundary
 * two calendar days are only 23 hours apart, so that division yields 0.958 and
 * a truncating caller reports "0 days". Civil arithmetic counts days as days.
 *
 * Exact integer arithmetic; no floating point error is possible in the
 * supported year range.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  // Shift the year to start in March so the leap day lands at the very end,
  // which removes February as a special case from the rest of the formula.
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400; // [0, 399]
  const shiftedMonth = (month + 9) % 12; // Mar = 0 ... Feb = 11
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1; // [0, 365]
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  // 719468 = days from 0000-03-01 to 1970-01-01, re-basing the result on the epoch.
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Parse-or-throw. Used by the functions whose return type leaves no room for a
 * failure value. Throwing beats returning 0/NaN: a silently wrong date is an
 * expense report filed against the wrong period, whereas a throw is caught at
 * the validation boundary where the bad string entered the system.
 */
function requireDateOnly(s: DateOnly, argName: string): { year: number; month: number; day: number } {
  const parsed = parseDateOnly(s);
  if (parsed === null) {
    throw new RangeError(`Invalid DateOnly for '${argName}': ${JSON.stringify(s)} (expected YYYY-MM-DD naming a real calendar day)`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * True only for a strict 'YYYY-MM-DD' string naming a day that exists.
 *
 * Rejects '2026-02-30' and '2025-02-29' (2025 is not a leap year) as well as
 * '2026-13-01'; accepts '2024-02-29'. No trimming, no coercion, no rollover —
 * a value that needs cleaning up is invalid input, and cleaning it up silently
 * is how a typo becomes a plausible-looking wrong date.
 */
export function isValidDateOnly(s: string): boolean {
  return parseDateOnly(s) !== null;
}

/**
 * True for a canonical UTC ISO-8601 instant, e.g. '2026-08-11T14:03:22.000Z'.
 *
 * The date portion must itself be a real calendar day, so
 * '2026-02-30T00:00:00Z' is rejected. Second 60 (an ISO leap second) is
 * rejected: no runtime here represents it, and accepting a value we cannot
 * round-trip is worse than refusing it.
 */
export function isValidInstant(s: string): boolean {
  if (!INSTANT_SHAPE.test(s)) return false;
  // Offsets are fixed-width up to the optional fraction, so slicing is total.
  if (!isValidDateOnly(s.slice(0, 10))) return false;
  const hours = Number(s.slice(11, 13));
  const minutes = Number(s.slice(14, 16));
  const seconds = Number(s.slice(17, 19));
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

// ---------------------------------------------------------------------------
// Construction and parsing
// ---------------------------------------------------------------------------

/**
 * Structured view of a DateOnly, or null if the string is not one. Total: never
 * throws, so it is the right entry point at any untrusted boundary (OCR output,
 * server payloads, text input).
 */
export function parseDateOnly(s: string): { year: number; month: number; day: number } | null {
  if (!DATE_ONLY_SHAPE.test(s)) return null;
  // Every field is fixed-width, so these slices cannot be undefined.
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  if (!isValidCivilDate(year, month, day)) return null;
  return { year, month, day };
}

/**
 * Build a DateOnly from civil components, zero-padded.
 *
 * Throws on a non-existent date rather than rolling over: makeDateOnly(2026, 2,
 * 30) is a caller bug, and quietly returning '2026-03-02' (what the Date
 * constructor would do) hides it until it reaches a user's expense report.
 */
export function makeDateOnly(year: number, month: number, day: number): DateOnly {
  if (!isValidCivilDate(year, month, day)) {
    throw new RangeError(`Not a real calendar date: year=${year} month=${month} day=${day}`);
  }
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Comparison and arithmetic
// ---------------------------------------------------------------------------

/**
 * Negative if a < b, 0 if equal, positive if a > b. Suitable for Array#sort.
 *
 * Plain string comparison is CORRECT here, and that is a property of the
 * format rather than a lucky accident: 'YYYY-MM-DD' is big-endian (most
 * significant field first), fixed-width and zero-padded, so byte order and
 * chronological order coincide for every representable date. Both arguments
 * are validated first — comparing an unvalidated string would silently give
 * byte order for garbage input, which is exactly the kind of "works until it
 * doesn't" behavior this module exists to prevent.
 */
export function compareDateOnly(a: DateOnly, b: DateOnly): number {
  requireDateOnly(a, 'a');
  requireDateOnly(b, 'b');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Signed whole days from `a` to `b`: positive when `b` is later, negative when
 * earlier, 0 for the same day. daysBetweenDateOnly('2026-01-01','2026-01-02')
 * is 1.
 *
 * Exact civil arithmetic — never milliseconds, never Date. See `daysFromCivil`
 * for why (DST makes millisecond math wrong by a whole day around
 * transitions).
 */
export function daysBetweenDateOnly(a: DateOnly, b: DateOnly): number {
  const from = requireDateOnly(a, 'a');
  const to = requireDateOnly(b, 'b');
  return daysFromCivil(to.year, to.month, to.day) - daysFromCivil(from.year, from.month, from.day);
}

/**
 * Are `a` and `b` within `days` calendar days of each other, in either
 * direction? Symmetric and inclusive: days = 0 means "the same day", days = 3
 * is the tolerance window receipt-to-transaction matching uses, because a card
 * settles a day or two after the merchant's printed date.
 *
 * `days` must be a non-negative integer; a negative window is meaningless and a
 * fractional one has no meaning in calendar-day arithmetic, so both throw
 * rather than quietly matching nothing.
 */
export function dateOnlyIsWithinDays(a: DateOnly, b: DateOnly, days: number): boolean {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`'days' must be a non-negative integer, got ${days}`);
  }
  return Math.abs(daysBetweenDateOnly(a, b)) <= days;
}

// ---------------------------------------------------------------------------
// The one (lossy) conversion
// ---------------------------------------------------------------------------

/**
 * Take the UTC calendar day out of an absolute instant.
 *
 * ############################################################################
 * # THIS CONVERSION IS LOSSY AND OPINIONATED. READ BEFORE USING.             #
 * #                                                                          #
 * # An Instant names a moment; a DateOnly names a day. Which day a moment    #
 * # "falls on" depends entirely on the observer's timezone, so this function  #
 * # answers the question only for one arbitrarily chosen observer: UTC.       #
 * # '2026-08-12T01:30:00.000Z' returns '2026-08-12' even though it was still #
 * # the 11th in New York and already the 12th in Tokyo. The time of day, the #
 * # sub-second precision, and any notion of the user's local day are all      #
 * # discarded and cannot be recovered.                                       #
 * #                                                                          #
 * # USE IT FOR: displaying server-side audit timestamps (createdAt,          #
 * # lastServerSyncAt) where "the UTC day the server recorded it" is exactly   #
 * # what we mean, and grouping audit rows in a support view.                 #
 * #                                                                          #
 * # NEVER USE IT FOR: a receipt's transactionDate. That field is the date    #
 * # PRINTED ON THE RECEIPT in the merchant's calendar; it is captured or     #
 * # OCR'd as a DateOnly and must never be derived from any timestamp.        #
 * # Deriving it here is precisely the off-by-one-day bug: a 23:30 local      #
 * # purchase in UTC-5 would be filed on the following day, landing in the     #
 * # wrong expense period and failing to match the card transaction.          #
 * #                                                                          #
 * # There is no inverse function on purpose. dateOnlyToInstant() cannot be   #
 * # written without inventing a timezone, so this codebase does not have it. #
 * ############################################################################
 */
export function instantToDateOnlyUTC(i: Instant): DateOnly {
  if (!isValidInstant(i)) {
    throw new RangeError(`Invalid Instant: ${JSON.stringify(i)} (expected ISO-8601 UTC ending in 'Z')`);
  }
  // Already validated as a real calendar day by isValidInstant.
  return i.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Presentation and predicates
// ---------------------------------------------------------------------------

/**
 * '2026-08-11' -> '11 Aug 2026'.
 *
 * Day-first with a named month is unambiguous worldwide, unlike 08/11/2026,
 * which means two different days on two sides of the Atlantic — a real hazard
 * on an expense record that a finance team reviews. Deterministic: no Intl, no
 * device locale, no timezone, so the string in the UI matches the string in an
 * export and in a screenshot attached to a support ticket.
 */
export function formatDateOnlyHuman(d: DateOnly): string {
  const { year, month, day } = requireDateOnly(d, 'd');
  const monthName = MONTH_ABBREV[month - 1] ?? '';
  return `${day} ${monthName} ${year}`;
}

/**
 * Is `d` strictly after `todayUTC`? Same day is NOT future.
 *
 * `todayUTC` is injected rather than read from a clock — that keeps this module
 * pure and, more importantly, makes "today" an explicit decision by the caller.
 * It is genuinely ambiguous: a user in UTC+13 is already on tomorrow's UTC-day,
 * so a receipt they photograph tonight looks "future-dated" against a UTC
 * today. The caller owns that policy; validation layers typically allow a day
 * or so of slack rather than calling this predicate bare.
 */
export function isFutureDateOnly(d: DateOnly, todayUTC: DateOnly): boolean {
  return compareDateOnly(d, todayUTC) > 0;
}
