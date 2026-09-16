/**
 * Barcode / QR payload decoding.
 *
 * WHY THIS IS REAL INSTEAD OF FAKE
 * --------------------------------
 * The camera layer hands us a decoded payload string. The brief prefers "a
 * deterministic fake ... to a fragile external demo", and the public barcode
 * formats happen to be BOTH real and perfectly deterministic: GS1 Application
 * Identifiers and fiscal-invoice TLV QRs are byte-exact specifications with no
 * network, no clock and no model behind them. So this module implements the
 * actual formats. Every test case below is a payload a real scanner could emit.
 *
 * WHAT COMES OUT, AND WHAT DELIBERATELY DOES NOT
 * ----------------------------------------------
 * A `BarcodeExtraction` is a *claim about the fields we could read*. It is not
 * a receipt and it is not a confirmation. It carries `barcode` provenance when
 * merged (see ORIGIN_PRECEDENCE in types.ts): structured, check-digited data
 * outranks OCR, and is still outranked permanently by a human correction.
 *
 * The module refuses to guess in three specific places, because each guess is a
 * bug this codebase has already decided to prevent:
 *
 *   1. AMOUNT WITHOUT A KNOWN EXPONENT. AI 390n/391n state their own decimal
 *      count `n`, which can disagree with the currency's real ISO-4217 exponent
 *      (a `3902` payload declaring 2 decimals for JPY, which has 0). Scaling
 *      through the disagreement is a silent 100x error, so we drop the amount
 *      and say why. Every amount that IS produced goes through money.ts.
 *   2. A PRODUCT DATE IS NOT A PURCHASE DATE. GS1 AIs 11/13/15/17 are
 *      production / packaging / best-before / expiry. None of them is when the
 *      user paid. Mapping any of them onto `transactionDate` would file the
 *      expense against the wrong period, so `transactionDate` stays null for
 *      GS1 and the dates are surfaced for display only.
 *   3. AN UNKNOWN AI HAS AN UNKNOWN LENGTH. We stop and report, rather than
 *      swallowing the remainder of the string as one enormous field value.
 *
 * PURITY: no React, no Expo, no I/O, no Date, no Date.now(), no Math.random(),
 * no Buffer, no atob, no TextDecoder. Base64 and UTF-8 are decoded here by hand
 * so the module runs identically in React Native, in Node and in CI. Every
 * function is total: hostile input returns a result, it never throws.
 */

import { isValidDateOnly } from './dates';
import { exponentFor, isSupportedCurrency, parseAmountToMinorUnits } from './money';
import type { DateOnly } from './types';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type BarcodeFormat = 'gs1-128' | 'fiscal-qr' | 'unknown';

export interface BarcodeExtraction {
  readonly format: BarcodeFormat;
  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: string | null;
  readonly transactionDate: DateOnly | null;
  /** Everything we read, keyed by AI code ('01', '3912') or TLV tag ('1'), for display. */
  readonly fields: Readonly<Record<string, string>>;
  /** User-facing sentences explaining why an expected field is missing or suspect. */
  readonly warnings: readonly string[];
}

export type BarcodeDecodeResult =
  | { ok: true; extraction: BarcodeExtraction }
  | { ok: false; reason: string };

/**
 * Untrusted-input ceiling. The densest real 2D symbol (a DataMatrix or QR at
 * maximum version) tops out well under this; anything longer is not a scan.
 */
const MAX_PAYLOAD_CHARS = 4096;

/** Longest vendor name we will carry forward from a payload. */
const MAX_VENDOR_CHARS = 120;

/** ASCII GS (0x1D) — how a scanner renders the FNC1 separator in a string. */
// ASCII GS (0x1D) is the GS1 FNC1 separator. Escaped rather than literal:
// an invisible control character in source is unreviewable, and it makes
// this file binary to git, grep and diff.
const GS = '\x1D';

// ---------------------------------------------------------------------------
// ISO-4217 numeric -> alphabetic
// ---------------------------------------------------------------------------

/**
 * AI 391n carries the ISO-4217 NUMERIC code; money.ts speaks ALPHABETIC codes.
 *
 * Every entry here is deliberately also a currency money.ts supports, because a
 * code we can name but cannot assign an exponent to is worse than one we cannot
 * name at all: it looks like success. A test asserts that invariant so the two
 * tables cannot drift apart.
 */
const NUMERIC_TO_ALPHA: Readonly<Record<string, string>> = {
  '032': 'ARS',
  '036': 'AUD',
  '048': 'BHD',
  '108': 'BIF',
  '124': 'CAD',
  '152': 'CLP',
  '156': 'CNY',
  '170': 'COP',
  '174': 'KMF',
  '203': 'CZK',
  '208': 'DKK',
  '262': 'DJF',
  '324': 'GNF',
  '344': 'HKD',
  '348': 'HUF',
  '352': 'ISK',
  '356': 'INR',
  '360': 'IDR',
  '368': 'IQD',
  '376': 'ILS',
  '392': 'JPY',
  '400': 'JOD',
  '404': 'KES',
  '410': 'KRW',
  '414': 'KWD',
  '434': 'LYD',
  '458': 'MYR',
  '484': 'MXN',
  '512': 'OMR',
  '548': 'VUV',
  '554': 'NZD',
  '566': 'NGN',
  '578': 'NOK',
  '600': 'PYG',
  '608': 'PHP',
  '643': 'RUB',
  '646': 'RWF',
  '682': 'SAR',
  '702': 'SGD',
  '704': 'VND',
  '710': 'ZAR',
  '752': 'SEK',
  '756': 'CHF',
  '764': 'THB',
  '784': 'AED',
  '788': 'TND',
  '800': 'UGX',
  '818': 'EGP',
  '826': 'GBP',
  '840': 'USD',
  '901': 'TWD',
  '946': 'RON',
  '949': 'TRY',
  '950': 'XAF',
  '952': 'XOF',
  '953': 'XPF',
  '978': 'EUR',
  '985': 'PLN',
  '986': 'BRL',
};

/**
 * '840' -> 'USD'. Returns null for anything we cannot name.
 *
 * Strictly three digits. '48' is NOT accepted as BHD: the field is fixed-width
 * in the payload, so a two-digit code means the payload was mis-framed and the
 * "amount" that follows is being read from the wrong offset. Padding it here
 * would turn a framing error into a plausible-looking wrong number.
 */
export function currencyFromNumericCode(code: string): string | null {
  if (!/^\d{3}$/.test(code)) return null;
  return NUMERIC_TO_ALPHA[code] ?? null;
}

// ---------------------------------------------------------------------------
// GS1 Application Identifier tables
// ---------------------------------------------------------------------------

type AiCharset = 'numeric' | 'alphanumeric';

interface AiDef {
  /** Human label for warning text. */
  readonly title: string;
  /** Length of the value in characters, or null when the value is variable. */
  readonly fixedLength: number | null;
  /** Maximum value length. Equals `fixedLength` for fixed AIs. */
  readonly maxLength: number;
  readonly charset: AiCharset;
  /** True when a GS1 check digit is appended to the value (GTIN, GLN). */
  readonly checkDigit: boolean;
}

/**
 * The AI subset this app understands, keyed by the AI's *base* code. For the
 * decimal-bearing AIs the base is three digits ('390', '391') and the fourth
 * digit is `n`, the decimal count — it is not part of the key.
 */
const AI_DEFS: Readonly<Record<string, AiDef>> = {
  '01': { title: 'GTIN', fixedLength: 14, maxLength: 14, charset: 'numeric', checkDigit: true },
  '10': { title: 'Batch/lot', fixedLength: null, maxLength: 20, charset: 'alphanumeric', checkDigit: false },
  '11': { title: 'Production date', fixedLength: 6, maxLength: 6, charset: 'numeric', checkDigit: false },
  '13': { title: 'Packaging date', fixedLength: 6, maxLength: 6, charset: 'numeric', checkDigit: false },
  '15': { title: 'Best-before date', fixedLength: 6, maxLength: 6, charset: 'numeric', checkDigit: false },
  '17': { title: 'Expiry date', fixedLength: 6, maxLength: 6, charset: 'numeric', checkDigit: false },
  '21': { title: 'Serial number', fixedLength: null, maxLength: 20, charset: 'alphanumeric', checkDigit: false },
  '390': { title: 'Amount payable', fixedLength: null, maxLength: 15, charset: 'numeric', checkDigit: false },
  '391': {
    title: 'Amount payable with ISO currency',
    fixedLength: null,
    maxLength: 18,
    charset: 'numeric',
    checkDigit: false,
  },
  '414': { title: 'Location GLN', fixedLength: 13, maxLength: 13, charset: 'numeric', checkDigit: true },
};

/** AI codes whose last digit is the decimal-place indicator `n`. */
const DECIMAL_BEARING_BASES: ReadonlySet<string> = new Set(['390', '391']);

/**
 * How many digits the AI itself occupies, keyed by its first two digits.
 *
 * This table is the whole reason GS1 is parseable at all: the AI is 2, 3 or 4
 * digits long and NOTHING in the payload marks where it ends, so the leading
 * pair must tell you. '39' introduces the four-digit 390n-393n family; '41'
 * introduces the three-digit 410-417 family; the rest of our subset is two.
 *
 * A prefix that is absent here is an AI whose LENGTH we do not know, which is a
 * different and much worse situation than an AI whose meaning we do not know —
 * we cannot even find where the next AI starts. That is why parsing stops.
 */
const AI_LENGTH_BY_PREFIX: Readonly<Record<string, number>> = {
  '01': 2,
  '10': 2,
  '11': 2,
  '13': 2,
  '15': 2,
  '17': 2,
  '21': 2,
  '39': 4,
  '41': 3,
};

/**
 * Two-digit-year pivot: 00-50 => 20xx, 51-99 => 19xx.
 *
 * GS1's own rule is a sliding 51-year window anchored on the CURRENT year,
 * which needs a clock. This module is pure by contract, and a clock-dependent
 * date parser is also untestable without freezing time. A fixed pivot is
 * deterministic, is correct for every date from 1951 to 2050, and is wrong only
 * for payloads this app will never see (a receipt printed before 1951, or one
 * whose best-before date falls after 2050). Documented rather than hidden.
 */
const CENTURY_PIVOT = 50;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Build a DateOnly, or null if the triple names no real day.
 *
 * Uses dates.ts as the single calendar authority rather than duplicating the
 * leap-year rule. `makeDateOnly` is deliberately NOT used: it throws, and this
 * module's input is a hostile string, so a '260230' payload must produce a
 * warning rather than an exception escaping into the camera callback.
 */
function dateOnlyFromCivil(year: number, month: number, day: number): DateOnly | null {
  const candidate = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  return isValidDateOnly(candidate) ? candidate : null;
}

/** Last day of a month, found by probing dates.ts's validator — see above. */
function lastDayOfMonth(year: number, month: number): DateOnly | null {
  for (const day of [31, 30, 29, 28]) {
    const candidate = dateOnlyFromCivil(year, month, day);
    if (candidate !== null) return candidate;
  }
  return null;
}

interface Yymmdd {
  readonly date: DateOnly | null;
  /** True when DD was '00' and we resolved it to the month's last day. */
  readonly wasEndOfMonth: boolean;
}

/**
 * GS1 YYMMDD.
 *
 * DD may be '00', which GS1 defines as "end of the month" (it exists because a
 * best-before date is often printed as a month, not a day). We resolve it to
 * the actual last day of that month — 2027-02 becomes 2027-02-28, 2028-02
 * becomes 2028-02-29 — and flag it, so the UI can say the day was inferred
 * rather than printed. Leaving it as day 0 would be an invalid DateOnly, and
 * defaulting it to the 1st would move a best-before date up to a month earlier.
 */
function parseYymmdd(raw: string): Yymmdd {
  if (!/^\d{6}$/.test(raw)) return { date: null, wasEndOfMonth: false };
  const yy = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  const day = Number(raw.slice(4, 6));
  const year = yy <= CENTURY_PIVOT ? 2000 + yy : 1900 + yy;
  if (month < 1 || month > 12) return { date: null, wasEndOfMonth: false };
  if (day === 0) return { date: lastDayOfMonth(year, month), wasEndOfMonth: true };
  return { date: dateOnlyFromCivil(year, month, day), wasEndOfMonth: false };
}

/**
 * GS1 modulo-10 check digit: weight the digits 3,1,3,1... from the right of the
 * payload (the check digit itself is the rightmost character and is excluded),
 * then the check digit is whatever takes the total to a multiple of 10.
 */
function gs1CheckDigitIsValid(digits: string): boolean {
  if (digits.length < 2 || !/^\d+$/.test(digits)) return false;
  const body = digits.slice(0, digits.length - 1);
  const expected = Number(digits.slice(digits.length - 1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // Rightmost body digit gets weight 3, then alternate.
    const weight = (body.length - 1 - i) % 2 === 0 ? 3 : 1;
    sum += Number(body.charAt(i)) * weight;
  }
  return (10 - (sum % 10)) % 10 === expected;
}

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/**
 * '000123' with 2 decimals -> '1.23'. Pure string surgery: no division, no
 * multiplication, so no float can appear. The result is then handed to
 * money.ts, which is the only thing allowed to turn it into minor units.
 */
function insertDecimalPoint(digits: string, decimals: number): string {
  if (decimals === 0) return stripLeadingZeros(digits);
  const padded = digits.padStart(decimals + 1, '0');
  const whole = stripLeadingZeros(padded.slice(0, padded.length - decimals));
  const fraction = padded.slice(padded.length - decimals);
  return `${whole}.${fraction}`;
}

/**
 * Control characters are never legitimate in a name or an identifier.
 *
 * Two constants, not one: a /g regex carries a mutable `lastIndex`, so calling
 * `.test()` on it repeatedly returns alternating answers. The global form is
 * used only for `replace`; the test form has no flag and is therefore stateless.
 */
const CONTROL_CHARS_GLOBAL = /[\x00-\x1F\x7F-\x9F]/g;
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/;

function sanitizeText(value: string): string {
  return value.replace(CONTROL_CHARS_GLOBAL, '').trim();
}

/** A short, control-character-free echo of untrusted input, safe to show. */
function preview(payload: string): string {
  const cleaned = sanitizeText(payload);
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}...` : cleaned;
}

function unknownExtraction(payload: string): BarcodeExtraction {
  return {
    format: 'unknown',
    vendor: null,
    amountMinorUnits: null,
    currency: null,
    transactionDate: null,
    fields: {},
    warnings: [
      `This code scanned cleanly but is not a receipt data format we can read (${preview(payload)}). Enter the details manually.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// GS1-128
// ---------------------------------------------------------------------------

/**
 * Symbology identifiers some scanners prepend: ']C1' (GS1-128), ']e0' (GS1
 * DataBar), ']d2' (GS1 DataMatrix), ']Q3' (GS1 QR). They describe the symbol,
 * not the data. A leading GS is the FNC1 start character rendered literally.
 */
function stripGs1Envelope(payload: string): string {
  let body = payload;
  if (/^\][A-Za-z]\d/.test(body)) body = body.slice(3);
  while (body.startsWith(GS)) body = body.slice(1);
  return body;
}

type AiResolution =
  | { kind: 'ok'; ai: string; base: string; def: AiDef; decimals: number | null; aiLength: number }
  | { kind: 'unknown'; ai: string }
  | { kind: 'malformed'; reason: string };

function resolveAi(body: string, at: number): AiResolution {
  const prefix = body.slice(at, at + 2);
  if (!/^\d{2}$/.test(prefix)) {
    return {
      kind: 'malformed',
      reason: `Expected a 2-digit Application Identifier at position ${at}, found ${JSON.stringify(preview(body.slice(at, at + 4)))}.`,
    };
  }
  const aiLength = AI_LENGTH_BY_PREFIX[prefix];
  if (aiLength === undefined) return { kind: 'unknown', ai: prefix };

  const ai = body.slice(at, at + aiLength);
  if (ai.length < aiLength || !/^\d+$/.test(ai)) {
    return {
      kind: 'malformed',
      reason: `Application Identifier starting '${prefix}' is ${aiLength} digits long but the payload ends after ${ai.length}.`,
    };
  }

  // 390n / 391n: the AI is four digits and the last is the decimal count.
  const base = aiLength === 4 ? ai.slice(0, 3) : ai;
  const def = AI_DEFS[base];
  if (def === undefined) return { kind: 'unknown', ai };
  const decimals = DECIMAL_BEARING_BASES.has(base) ? Number(ai.charAt(3)) : null;
  return { kind: 'ok', ai, base, def, decimals, aiLength };
}

interface AmountCandidate {
  readonly minorUnits: number | null;
  readonly currency: string | null;
}

/**
 * Parse a GS1 Application Identifier string.
 *
 * THE SEPARATOR RULE, which is the classic GS1 parsing bug in both directions:
 *
 *   - A PREDEFINED-LENGTH AI (01, 11, 13, 15, 17, 414) is followed immediately
 *     by the next AI with NO separator. A parser that scans to the next GS to
 *     find the end of AI 17's value will read the expiry date, the next AI and
 *     part of its data as one six-character-that-isn't date.
 *   - A VARIABLE-LENGTH AI (10, 21, 390n, 391n) runs to the next GS, or to the
 *     end of the string if it is last. A parser that assumes a separator is
 *     always there truncates the final field; one that forgets the separator
 *     swallows every remaining AI into the value.
 *
 * Both directions are tested explicitly.
 *
 * A GS appearing after a fixed-length field is tolerated and consumed. Strictly
 * it is not permitted, but several real encoders emit one, and the data either
 * side of it is unambiguous — rejecting a label we can read perfectly well
 * helps nobody.
 */
export function parseGs1(payload: string): BarcodeDecodeResult {
  if (payload.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, reason: 'Barcode payload is too long to be a real scan.' };
  }
  const body = stripGs1Envelope(payload);
  if (body === '') return { ok: false, reason: 'Empty GS1 payload.' };

  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  const seenBases = new Set<string>();
  let amountNoCurrency: string | null = null;
  let amountWithCurrency: AmountCandidate | null = null;
  let sawAnyAmountAi = false;
  let glnForDisplay: string | null = null;

  let at = 0;
  while (at < body.length) {
    const resolved = resolveAi(body, at);

    if (resolved.kind === 'malformed') {
      return { ok: false, reason: resolved.reason };
    }

    if (resolved.kind === 'unknown') {
      // We know neither this AI's meaning nor its LENGTH, so we cannot find
      // where the next AI begins. Consuming the remainder as this AI's value
      // would silently invent a field; guessing a length would silently
      // misalign every field after it. We stop, keep what is already proven,
      // and say out loud how much was left unread.
      const remaining = body.length - at;
      warnings.push(
        `Stopped at unrecognised Application Identifier '${resolved.ai}': its length is not known, so the remaining ${remaining} character${remaining === 1 ? '' : 's'} of the barcode could not be read safely.`,
      );
      break;
    }

    const { ai, base, def, decimals } = resolved;
    const valueStart = at + resolved.aiLength;
    let value: string;

    if (def.fixedLength !== null) {
      value = body.slice(valueStart, valueStart + def.fixedLength);
      if (value.length < def.fixedLength) {
        return {
          ok: false,
          reason: `AI ${ai} (${def.title}) is truncated: expected ${def.fixedLength} characters, found ${value.length}.`,
        };
      }
      if (value.includes(GS)) {
        // A separator inside a fixed-length field means the encoder wrote
        // fewer characters than the AI requires, then separated. The value is
        // short, not merely oddly punctuated.
        return {
          ok: false,
          reason: `AI ${ai} (${def.title}) is truncated: a group separator appears inside its ${def.fixedLength}-character value.`,
        };
      }
      at = valueStart + def.fixedLength;
      // Tolerate (and consume) a separator an encoder emitted anyway.
      if (body.charAt(at) === GS) at += 1;
    } else {
      const sepAt = body.indexOf(GS, valueStart);
      const end = sepAt === -1 ? body.length : sepAt;
      value = body.slice(valueStart, end);
      if (value.length === 0) {
        return { ok: false, reason: `AI ${ai} (${def.title}) has an empty value.` };
      }
      if (value.length > def.maxLength) {
        return {
          ok: false,
          reason: `AI ${ai} (${def.title}) is ${value.length} characters, over its ${def.maxLength}-character maximum — the payload is missing a group separator.`,
        };
      }
      at = sepAt === -1 ? body.length : sepAt + 1;
    }

    if (def.charset === 'numeric' && !/^\d+$/.test(value)) {
      return { ok: false, reason: `AI ${ai} (${def.title}) must be numeric, got ${JSON.stringify(preview(value))}.` };
    }
    if (def.charset === 'alphanumeric' && CONTROL_CHARS.test(value)) {
      return { ok: false, reason: `AI ${ai} (${def.title}) contains control characters.` };
    }

    if (seenBases.has(base)) {
      // GS1 forbids repeating a non-repeatable AI. Keeping the first value and
      // reporting the conflict beats letting a duplicate overwrite a field the
      // user may already be looking at.
      warnings.push(`AI ${ai} (${def.title}) appears more than once; keeping the first value.`);
      continue;
    }
    seenBases.add(base);

    if (def.checkDigit && !gs1CheckDigitIsValid(value)) {
      warnings.push(
        `${def.title} ${value} fails its GS1 check digit — the barcode may have been misread. Rescan before trusting it.`,
      );
    }

    switch (base) {
      case '11':
      case '13':
      case '15':
      case '17': {
        const { date, wasEndOfMonth } = parseYymmdd(value);
        if (date === null) {
          warnings.push(`AI ${ai} (${def.title}) is not a real date ('${value}'); ignoring it.`);
        } else {
          fields[ai] = date;
          if (wasEndOfMonth) {
            warnings.push(
              `AI ${ai} (${def.title}) gives day '00', which GS1 defines as end of month; read as ${date}.`,
            );
          }
        }
        break;
      }

      case '390': {
        sawAnyAmountAi = true;
        const printed = insertDecimalPoint(value, decimals ?? 0);
        fields[ai] = printed;
        amountNoCurrency = printed;
        break;
      }

      case '391': {
        sawAnyAmountAi = true;
        if (value.length < 4) {
          warnings.push(`AI ${ai} (${def.title}) is too short to hold a 3-digit currency code and an amount.`);
          break;
        }
        const numericCode = value.slice(0, 3);
        const alpha = currencyFromNumericCode(numericCode);
        const printed = insertDecimalPoint(value.slice(3), decimals ?? 0);
        fields[ai] = `${alpha ?? `#${numericCode}`} ${printed}`;
        if (alpha === null) {
          warnings.push(
            `AI ${ai} names ISO-4217 numeric currency ${numericCode}, which this app does not support; the amount ${printed} was not recorded.`,
          );
          break;
        }
        amountWithCurrency = resolveCurrencyAmount(ai, alpha, printed, decimals ?? 0, warnings);
        break;
      }

      case '414':
        fields[ai] = value;
        glnForDisplay = value;
        break;

      default:
        fields[ai] = value;
        break;
    }
  }

  // ---- Resolve the amount ------------------------------------------------
  // 391n wins over 390n whenever both are present: it is the only one of the
  // two that names its currency, and an amount without a currency is not money.
  let amountMinorUnits: number | null = null;
  let currency: string | null = null;
  if (amountWithCurrency !== null) {
    amountMinorUnits = amountWithCurrency.minorUnits;
    currency = amountWithCurrency.currency;
  } else if (amountNoCurrency !== null) {
    warnings.push(
      `The barcode gives an amount of ${amountNoCurrency} but no currency (AI 390n carries none), so it was not recorded as money. Choose a currency and enter it.`,
    );
  }
  if (!sawAnyAmountAi) {
    warnings.push('This barcode carries no amount (AI 390n or 391n). Enter the amount manually.');
  }

  // ---- Fields GS1 structurally cannot supply ------------------------------
  warnings.push(
    glnForDisplay === null
      ? 'A GS1 barcode identifies products, not merchants, so there is no vendor name on it. Enter the vendor manually.'
      : `A GS1 barcode identifies products, not merchants: location GLN ${glnForDisplay} is an identifier, not a vendor name. Enter the vendor manually.`,
  );
  warnings.push(
    'GS1 dates are product dates (production, packaging, best-before, expiry), never the purchase date, so the transaction date was left blank. Enter it manually.',
  );

  return {
    ok: true,
    extraction: {
      format: 'gs1-128',
      vendor: null,
      amountMinorUnits,
      currency,
      // See warning above: no GS1 AI in this subset means "when the user paid".
      transactionDate: null,
      fields,
      warnings,
    },
  };
}

/**
 * Turn a 391n amount into minor units, or refuse to.
 *
 * THIS IS THE FUNCTION THE BRIEF'S MONEY RULE LIVES IN. The barcode states its
 * own decimal count `n`; the currency has an ISO-4217 exponent. When they
 * disagree the payload is internally inconsistent — a `3902` element declaring
 * two decimals for JPY, which has none — and there is no safe reading. Scaling
 * by the barcode's `n` stores ¥500 as 50000; scaling by the currency's exponent
 * stores ¥5. Both are silent, both are 100x wrong, and a finance team would
 * find neither. So the amount is dropped and the user is told why.
 *
 * The currency IS kept: the numeric code is a separate, independently correct
 * field, and pre-filling it saves the user a step.
 */
function resolveCurrencyAmount(
  ai: string,
  alpha: string,
  printed: string,
  decimals: number,
  warnings: string[],
): AmountCandidate {
  if (!isSupportedCurrency(alpha)) {
    warnings.push(`Currency ${alpha} is not supported, so the amount ${printed} was not recorded.`);
    return { minorUnits: null, currency: null };
  }
  const exponent = exponentFor(alpha);
  if (decimals !== exponent) {
    warnings.push(
      `AI ${ai} declares ${decimals} decimal place${decimals === 1 ? '' : 's'} but ${alpha} has ${exponent}. ` +
        `The barcode contradicts itself, so the amount (${printed}) was not recorded — enter it manually.`,
    );
    return { minorUnits: null, currency: alpha };
  }
  const parsed = parseAmountToMinorUnits(printed, alpha);
  if (!parsed.ok) {
    warnings.push(`Amount ${printed} ${alpha} from AI ${ai} could not be recorded: ${parsed.error}`);
    return { minorUnits: null, currency: alpha };
  }
  return { minorUnits: parsed.minorUnits, currency: alpha };
}

// ---------------------------------------------------------------------------
// Base64 (no Buffer, no atob — this has to run in React Native)
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_INDEX: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charAt(i)] = i;
  return table;
})();

/**
 * Standard base64 -> bytes, or null if the string is not standard base64.
 *
 * Padding is REQUIRED (length a multiple of 4). Fiscal QR specifications mandate
 * padded base64, and accepting an unpadded string here would mean accepting a
 * payload that lost its final characters in transit — which decodes to a
 * plausible-looking truncated TLV rather than an obvious failure.
 *
 * Deliberately not URL-safe base64: '-' and '_' are not in the alphabet, so a
 * URL-safe string fails rather than silently losing two sextets.
 */
function base64Decode(input: string): Uint8Array | null {
  if (input.length === 0 || input.length % 4 !== 0) return null;

  let padding = 0;
  if (input.endsWith('==')) padding = 2;
  else if (input.endsWith('=')) padding = 1;

  const body = input.slice(0, input.length - padding);
  const out = new Uint8Array((input.length / 4) * 3 - padding);

  let written = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i++) {
    // '=' is absent from B64_INDEX, so a pad character inside the body fails here.
    const sextet = B64_INDEX[body.charAt(i)];
    if (sextet === undefined) return null;
    acc = (acc << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (acc >> bits) & 0xff;
      written += 1;
    }
  }
  return written === out.length ? out : null;
}

/**
 * UTF-8 bytes -> string, or null if the bytes are not valid UTF-8.
 *
 * Strict rather than replacement-character lenient: a seller name full of
 * U+FFFD is indistinguishable from a name that really contains them, and this
 * value goes onto an expense record. Overlong encodings, surrogate code points
 * and values above U+10FFFF are all rejected — they are the classic way to
 * smuggle a character past a validator. Never reads past `end`.
 */
function utf8Decode(bytes: Uint8Array, start: number, end: number): string | null {
  let out = '';
  let i = start;
  while (i < end) {
    const b0 = bytes[i];
    if (b0 === undefined) return null;

    let codePoint: number;
    let continuationBytes: number;
    if (b0 < 0x80) {
      codePoint = b0;
      continuationBytes = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      // 0xc0/0xc1 excluded: they can only introduce an overlong 2-byte form.
      codePoint = b0 & 0x1f;
      continuationBytes = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      codePoint = b0 & 0x0f;
      continuationBytes = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      codePoint = b0 & 0x07;
      continuationBytes = 3;
    } else {
      return null;
    }

    if (i + continuationBytes >= end) return null;
    for (let k = 1; k <= continuationBytes; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      codePoint = (codePoint << 6) | (b & 0x3f);
    }

    if (continuationBytes === 2 && codePoint < 0x800) return null;
    if (continuationBytes === 3 && codePoint < 0x10000) return null;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    if (codePoint > 0x10ffff) return null;

    out += String.fromCodePoint(codePoint);
    i += continuationBytes + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fiscal-invoice QR (base64 TLV)
// ---------------------------------------------------------------------------

interface TlvRecord {
  readonly tag: number;
  readonly start: number;
  readonly length: number;
}

type TlvParse = { ok: true; records: readonly TlvRecord[] } | { ok: false; reason: string };

/**
 * Tag / length / value, one byte each for tag and length.
 *
 * HOSTILE INPUT IS THE POINT OF THIS FUNCTION. A declared length is a number an
 * attacker controls, so it is checked against the remaining buffer BEFORE any
 * slice, every time. There is no path here that reads past the end: a length
 * that overruns ends the parse with a reason, and the caller gets a failure
 * result rather than a truncated-but-plausible invoice.
 */
function parseTlv(bytes: Uint8Array): TlvParse {
  const records: TlvRecord[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 2 > bytes.length) {
      return { ok: false, reason: `Truncated TLV header at byte ${i}: a tag and length need 2 bytes, 1 remains.` };
    }
    const tag = bytes[i];
    const length = bytes[i + 1];
    if (tag === undefined || length === undefined) {
      return { ok: false, reason: `Truncated TLV header at byte ${i}.` };
    }
    const valueStart = i + 2;
    const remaining = bytes.length - valueStart;
    if (length > remaining) {
      return {
        ok: false,
        reason: `TLV tag ${tag} declares ${length} bytes of value but only ${remaining} remain in the payload.`,
      };
    }
    records.push({ tag, start: valueStart, length });
    i = valueStart + length;
  }
  if (records.length === 0) return { ok: false, reason: 'Payload contains no TLV records.' };
  return { ok: true, records };
}

/** Tags this app reads. 6-8 exist in the wild (hashes, signatures) and are skipped. */
const TLV_TAG_SELLER = 1;
const TLV_TAG_VAT_NUMBER = 2;
const TLV_TAG_TIMESTAMP = 3;
const TLV_TAG_TOTAL_WITH_VAT = 4;
const TLV_TAG_VAT_TOTAL = 5;

/**
 * Decode a fiscal-invoice QR: base64 over TLV records.
 *
 * WHY NO AMOUNT COMES OUT OF THIS, EVER
 * -------------------------------------
 * The format carries the total as a DECIMAL STRING and carries NO currency
 * code. Minor units are meaningless without a currency, because the exponent is
 * a property of the currency (money.ts, note 2): '1000.50' is 100050 minor
 * units in SAR and is not a representable JPY amount at all. The obvious
 * shortcut — assume the issuing country's currency — is exactly the assumption
 * money.ts exists to forbid, and it would be wrong the first time a traveller
 * scans an invoice abroad. So the total is surfaced verbatim in `fields` for
 * the user to confirm alongside a currency they choose, and
 * `amountMinorUnits`/`currency` stay null with a warning that says so.
 *
 * The timestamp IS used for `transactionDate`, and the way it is used matters:
 * we take the date component AS WRITTEN. That is not the forbidden
 * instant->day conversion (`instantToDateOnlyUTC`, whose doc comment bans it
 * for `transactionDate`) — we are not choosing an observer's timezone, we are
 * reading the calendar date the issuer themselves printed on the invoice, which
 * is by definition the merchant's local calendar date. Re-projecting it through
 * UTC would be what creates the off-by-one-day bug, not what avoids it.
 */
export function parseFiscalQr(payload: string): BarcodeDecodeResult {
  if (payload.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, reason: 'QR payload is too long to be a real scan.' };
  }
  const bytes = base64Decode(payload);
  if (bytes === null) {
    return { ok: false, reason: 'Not valid base64: this is not a fiscal invoice QR.' };
  }
  const tlv = parseTlv(bytes);
  if (!tlv.ok) {
    return { ok: false, reason: `Malformed fiscal invoice QR. ${tlv.reason}` };
  }

  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  let vendor: string | null = null;
  let transactionDate: DateOnly | null = null;
  let total: string | null = null;

  const seenTags = new Set<number>();

  for (const record of tlv.records) {
    if (
      record.tag !== TLV_TAG_SELLER &&
      record.tag !== TLV_TAG_VAT_NUMBER &&
      record.tag !== TLV_TAG_TIMESTAMP &&
      record.tag !== TLV_TAG_TOTAL_WITH_VAT &&
      record.tag !== TLV_TAG_VAT_TOTAL
    ) {
      // Tags 6-8 carry a hash and a signature. They are correctly framed and
      // were skipped by length, so nothing is misaligned; they are simply not
      // expense data.
      continue;
    }
    if (seenTags.has(record.tag)) {
      warnings.push(`Tag ${record.tag} appears more than once; keeping the first value.`);
      continue;
    }
    seenTags.add(record.tag);

    const text = utf8Decode(bytes, record.start, record.start + record.length);
    if (text === null) {
      warnings.push(`Tag ${record.tag} is not valid UTF-8 and was ignored.`);
      continue;
    }
    const clean = sanitizeText(text);
    if (clean === '') {
      warnings.push(`Tag ${record.tag} is empty.`);
      continue;
    }

    switch (record.tag) {
      case TLV_TAG_SELLER: {
        if (clean.length > MAX_VENDOR_CHARS) {
          vendor = clean.slice(0, MAX_VENDOR_CHARS);
          warnings.push(`Seller name was longer than ${MAX_VENDOR_CHARS} characters and was shortened; check it.`);
        } else {
          vendor = clean;
        }
        fields[String(record.tag)] = vendor;
        break;
      }
      case TLV_TAG_TIMESTAMP: {
        fields[String(record.tag)] = clean;
        // Take the leading calendar date exactly as the issuer wrote it. No
        // timezone is applied, invented or removed — see the header comment.
        const datePart = clean.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(clean) && isValidDateOnly(datePart)) {
          transactionDate = datePart;
        } else {
          warnings.push(`Invoice timestamp '${clean}' is not an ISO-8601 date; the transaction date was left blank.`);
        }
        break;
      }
      case TLV_TAG_TOTAL_WITH_VAT: {
        fields[String(record.tag)] = clean;
        total = clean;
        break;
      }
      default: {
        fields[String(record.tag)] = clean;
        break;
      }
    }
  }

  if (vendor === null) warnings.push('This QR carries no seller name. Enter the vendor manually.');
  if (transactionDate === null && !seenTags.has(TLV_TAG_TIMESTAMP)) {
    warnings.push('This QR carries no timestamp. Enter the transaction date manually.');
  }
  warnings.push(
    total === null
      ? 'This QR carries no invoice total. Enter the amount manually.'
      : `The invoice total is ${total}, but a fiscal QR carries no currency code, so it was not recorded as money. Confirm the amount and choose a currency.`,
  );

  return {
    ok: true,
    extraction: {
      format: 'fiscal-qr',
      vendor,
      // See the header comment: no currency in the format means no exponent,
      // and no exponent means no minor units. We refuse rather than assume.
      amountMinorUnits: null,
      currency: null,
      transactionDate,
      fields,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Does this payload structurally claim to be GS1? Cheap; no full parse. */
function looksLikeGs1(payload: string): boolean {
  if (/^\][A-Za-z]\d/.test(payload)) return true;
  const body = stripGs1Envelope(payload);
  if (body === '') return false;
  const resolved = resolveAi(body, 0);
  return resolved.kind === 'ok';
}

/**
 * Does this payload structurally claim to be a fiscal QR? Requires valid
 * base64 whose first byte is a plausible tag (1-8). That is enough to separate
 * an invoice from an arbitrary base64-shaped string without committing to a
 * full parse, so 'SGVsbG8gd29ybGQ=' falls through to `unknown` rather than
 * being reported as a malformed invoice.
 */
function looksLikeFiscalQr(payload: string): boolean {
  const bytes = base64Decode(payload);
  if (bytes === null || bytes.length < 2) return false;
  const firstTag = bytes[0];
  return firstTag !== undefined && firstTag >= 1 && firstTag <= 8;
}

/**
 * The entry point the camera layer calls.
 *
 * A payload we recognise but cannot use is a SUCCESS with `format: 'unknown'`,
 * not an error: the scan worked, the code simply was not receipt data (a
 * loyalty URL, a wifi config, a tracking number). The user should be told to
 * type the details in, not shown a failure they cannot act on.
 *
 * A payload that claims a format and then contradicts itself IS an error —
 * silently downgrading a truncated GS1 label to 'unknown' would hide the fact
 * that the scanner read half a barcode.
 */
export function decodeBarcodePayload(payload: string): BarcodeDecodeResult {
  if (payload.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, reason: 'Barcode payload is too long to be a real scan.' };
  }
  if (payload.trim() === '') {
    return { ok: false, reason: 'Empty barcode payload.' };
  }

  // The two detectors cannot both fire, so there is no precedence question and
  // no need to try one format and fall back to the other. A fiscal QR's first
  // TLV tag is 1-8, i.e. a first byte of 0x01-0x08; the first base64 character
  // encodes that byte's top six bits, which is 0, 1 or 2 — 'A', 'B' or 'C'.
  // Base64 digits start at index 52, so a fiscal QR can never begin with a
  // digit, and it can never begin with ']' either. A GS1 payload always begins
  // with one or the other. A test pins that so this reasoning cannot rot.
  if (looksLikeGs1(payload)) {
    return parseGs1(payload);
  }

  if (looksLikeFiscalQr(payload)) {
    return parseFiscalQr(payload);
  }

  return { ok: true, extraction: unknownExtraction(payload) };
}
