/**
 * Deterministic fake OCR adapter.
 *
 * The brief does not require a real provider, and a real one would make the
 * app untestable: you cannot assert on "OCR came back uncertain" if you cannot
 * make it come back uncertain on demand. So extraction here is a pure function
 * of the storage key — the same blob always yields the same reading, and a
 * test can search the key space for a key whose reading has the shape it wants.
 *
 * Purity rules: no Date, no Date.now(), no Math.random(), no I/O. Every
 * decision is derived by hashing.
 *
 * SEMANTICS
 *   amountMinorUnits  integer count of the currency's smallest unit. For JPY,
 *                     minor units ARE yen (exponent 0) — 2400 means Y2,400.
 *                     Never a float, never "dollars".
 *   transactionDate   DateOnly 'YYYY-MM-DD'. The date printed on the paper, in
 *                     the merchant's local calendar. It is not an instant and
 *                     is never given a timezone here.
 *   confidence        0..1, quantized to 2dp so it renders without noise.
 */

import { SEED_MERCHANT_NAMES } from './seed';

export interface OcrResult {
  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: string | null;
  readonly transactionDate: string | null;
  /** 0..1 inclusive-ish; see LOW_CONFIDENCE_THRESHOLD. */
  readonly confidence: number;
}

/**
 * Below this, the reading is not trustworthy enough to auto-confirm and the
 * receipt must go to a human. 0.75 is a product decision, not a law; it lives
 * here as a named constant so the UI can explain itself.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

/** Default universe. Pass a different `seed` to get a different fake world. */
export const DEFAULT_OCR_SEED = 0x811c9dc5;

/**
 * Vendors the extractor can report. The seeded merchants are included on
 * purpose so that a reading sometimes has a genuine transaction candidate;
 * the extras exist so it sometimes does not, which is a case the matcher has
 * to handle rather than assume away.
 */
const VENDOR_LEXICON: readonly string[] = [
  ...SEED_MERCHANT_NAMES,
  'Corner Newsstand',
  'Airport Duty Free',
  'Rivera Hardware',
];

/** USD-heavy on purpose; JPY is rare but present so zero-decimal math is live. */
const CURRENCY_TABLE: readonly string[] = [
  'USD',
  'USD',
  'USD',
  'USD',
  'USD',
  'USD',
  'USD',
  'EUR',
  'EUR',
  'JPY',
];

/** Receipts in this fake world were all printed inside a 21-day window. */
const WINDOW_START_Y = 2026;
const WINDOW_START_M = 8;
const WINDOW_START_D = 1;
const WINDOW_DAYS = 21;

// ---------------------------------------------------------------------------
// Hashing — every stream below is a pure function of (storageKey, seed, salt)
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. charCodeAt keeps it well-defined for any UTF-16 string. */
function fnv1a32(input: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32 finalizer — decorrelates the cheap FNV output. */
function mix32(x: number): number {
  let z = (x + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * An independent uint32 stream per field, so that dropping the vendor does not
 * shift the amount. Without the salt, "same hash, different modulus" would
 * correlate every field to every other one.
 */
function stream(base: number, salt: string): number {
  return mix32(fnv1a32(salt, base));
}

/** uint32 -> [0, 1). */
function unit(u: number): number {
  return (u >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Calendar arithmetic (Howard Hinnant's civil algorithms)
// ---------------------------------------------------------------------------
//
// Done by hand rather than with Date so the module has no dependency on a
// runtime clock or a host timezone. A DateOnly must never be produced by
// formatting an instant in whatever zone the device happens to be in.

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function dateOnlyFromDays(days: number): string {
  const c = civilFromDays(days);
  return `${c.y}-${pad2(c.m)}-${pad2(c.d)}`;
}

const WINDOW_START_DAY = daysFromCivil(WINDOW_START_Y, WINDOW_START_M, WINDOW_START_D);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function pick<T>(table: readonly T[], u: number): T {
  const value = table[u % table.length];
  // `table` is a non-empty module constant and the index is a non-negative
  // integer modulo its length, so this is unreachable. It exists because the
  // compiler cannot know that and we do not use non-null assertions.
  if (value === undefined) throw new Error('empty lookup table');
  return value;
}

/**
 * Read a receipt image.
 *
 * Deterministic: the same storageKey (and seed) always produces the same
 * result, byte for byte. Fields go null and confidence drops for some keys —
 * that is not a bug to be smoothed over, it is the input that drives the
 * `needsReview` state.
 *
 * A field is dropped when its own draw exceeds `confidence`, which makes the
 * confidence number mean something real: low-confidence readings are also the
 * patchy ones, exactly as a real extractor behaves.
 */
export function extractFromReceipt(storageKey: string, opts?: { seed?: number }): OcrResult {
  const seed = mix32((opts?.seed ?? DEFAULT_OCR_SEED) >>> 0);
  const base = fnv1a32(storageKey, seed);

  // Quantized to 2dp: a UI that prints "83%" should not be lying about the
  // 14 digits it is hiding.
  const confidence = Math.round(unit(stream(base, 'confidence')) * 100) / 100;

  const keep = (salt: string): boolean => unit(stream(base, salt)) <= confidence;

  const currency = pick(CURRENCY_TABLE, stream(base, 'currency'));

  // The amount is shaped by the currency's exponent even when the currency
  // itself was unreadable: a JPY receipt carries whole yen, never cents.
  const amountRaw = stream(base, 'amount');
  const amountMinorUnits =
    currency === 'JPY'
      ? 150 + (amountRaw % 9851) // Y150 .. Y10,000
      : 199 + (amountRaw % 24801); // $1.99 .. $250.00

  const dateDays = WINDOW_START_DAY + (stream(base, 'date') % WINDOW_DAYS);

  return {
    vendor: keep('keep.vendor') ? pick(VENDOR_LEXICON, stream(base, 'vendor')) : null,
    amountMinorUnits: keep('keep.amount') ? amountMinorUnits : null,
    // Currency is dropped independently of amount: a smudged currency symbol
    // over a legible total is one of the commonest real failures, and it is
    // the one the app must never paper over by assuming USD.
    currency: keep('keep.currency') ? currency : null,
    transactionDate: keep('keep.date') ? dateOnlyFromDays(dateDays) : null,
    confidence,
  };
}

/**
 * Whether this reading needs a human.
 *
 * Two independent reasons: the extractor said it was unsure, or it failed to
 * read a field the app cannot do without. A missing amount at confidence 0.99
 * still needs a human.
 */
export function isLowConfidence(r: OcrResult): boolean {
  if (r.confidence < LOW_CONFIDENCE_THRESHOLD) return true;
  return (
    r.vendor === null ||
    r.amountMinorUnits === null ||
    r.currency === null ||
    r.transactionDate === null
  );
}
