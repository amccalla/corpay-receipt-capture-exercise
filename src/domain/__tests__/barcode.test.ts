import {
  currencyFromNumericCode,
  decodeBarcodePayload,
  parseFiscalQr,
  parseGs1,
} from '../barcode';
import type { BarcodeDecodeResult, BarcodeExtraction } from '../barcode';
import { exponentFor, isSupportedCurrency } from '../money';

/** ASCII GS (0x1D) — the FNC1 separator as a scanner renders it. */
const GS = '\x1D';

// ---------------------------------------------------------------------------
// Narrowing helpers, so the tests read as assertions rather than type gymnastics
// ---------------------------------------------------------------------------

function expectOk(result: BarcodeDecodeResult): BarcodeExtraction {
  if (!result.ok) throw new Error(`expected a successful decode, got: ${result.reason}`);
  return result.extraction;
}

function expectErr(result: BarcodeDecodeResult): string {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.extraction)}`);
  return result.reason;
}

function hasWarning(extraction: BarcodeExtraction, fragment: string): boolean {
  return extraction.warnings.some((w) => w.includes(fragment));
}

// ---------------------------------------------------------------------------
// Test-side encoders.
//
// Hand-rolled on purpose: the module decodes base64 and UTF-8 without Buffer or
// TextEncoder so it runs in React Native, and a test that encoded with Buffer
// would be testing Node rather than the payloads a phone actually sees. These
// are also independent implementations, so a shared bug is unlikely.
// ---------------------------------------------------------------------------

function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET.charAt(b0 >> 2);
    out += B64_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? '=' : B64_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? '=' : B64_ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

function tlvText(tag: number, value: string): number[] {
  const bytes = utf8Encode(value);
  return [tag, bytes.length, ...bytes];
}

function tlvRaw(tag: number, bytes: readonly number[]): number[] {
  return [tag, bytes.length, ...bytes];
}

function fiscalQr(...records: readonly (readonly number[])[]): string {
  return base64Encode(records.flat());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A GTIN-14 whose mod-10 check digit is correct. */
const GTIN = '09501101020917';
/** The same GTIN with the check digit knocked off by one. */
const GTIN_BAD_CHECK = '09501101020918';
/** A GLN-13 whose mod-10 check digit is correct. */
const GLN = '4012345678901';

/**
 * A realistic retail label: GTIN, expiry, a priced element with currency, a
 * batch and a serial. Note where the separators are, and are not.
 */
const RETAIL_LABEL =
  `01${GTIN}` + // fixed 14 -> no separator
  `17270331` + // fixed 6  -> no separator
  `3912840000123${GS}` + // variable -> separator
  `10ABC123${GS}` + // variable -> separator
  `21SER0001`; // variable, last -> no separator

// ===========================================================================
// currencyFromNumericCode
// ===========================================================================

describe('currencyFromNumericCode', () => {
  it('maps the codes the brief calls out', () => {
    expect(currencyFromNumericCode('840')).toBe('USD');
    expect(currencyFromNumericCode('978')).toBe('EUR');
    expect(currencyFromNumericCode('826')).toBe('GBP');
    expect(currencyFromNumericCode('392')).toBe('JPY');
    expect(currencyFromNumericCode('356')).toBe('INR');
    expect(currencyFromNumericCode('410')).toBe('KRW');
    expect(currencyFromNumericCode('048')).toBe('BHD');
    expect(currencyFromNumericCode('414')).toBe('KWD');
    expect(currencyFromNumericCode('512')).toBe('OMR');
    expect(currencyFromNumericCode('788')).toBe('TND');
    expect(currencyFromNumericCode('124')).toBe('CAD');
    expect(currencyFromNumericCode('036')).toBe('AUD');
  });

  it('requires exactly three digits — a two-digit code means a mis-framed payload', () => {
    // '48' is BHD's code without its leading zero. Accepting it would mean
    // accepting a payload read from the wrong offset, and the "amount" that
    // follows would then be sliced one character early.
    expect(currencyFromNumericCode('48')).toBeNull();
    expect(currencyFromNumericCode('0840')).toBeNull();
    expect(currencyFromNumericCode('')).toBeNull();
    expect(currencyFromNumericCode('usd')).toBeNull();
    expect(currencyFromNumericCode('8 4')).toBeNull();
    expect(currencyFromNumericCode('84a')).toBeNull();
  });

  it('returns null for codes it does not know', () => {
    expect(currencyFromNumericCode('999')).toBeNull();
    expect(currencyFromNumericCode('000')).toBeNull();
  });

  it('never names a currency money.ts cannot assign an exponent to', () => {
    // The two tables must not drift: a currency we can name but cannot give an
    // exponent is worse than one we cannot name, because it looks like success.
    for (let code = 0; code <= 999; code++) {
      const alpha = currencyFromNumericCode(String(code).padStart(3, '0'));
      if (alpha === null) continue;
      expect(isSupportedCurrency(alpha)).toBe(true);
      expect(() => exponentFor(alpha)).not.toThrow();
    }
  });
});

// ===========================================================================
// GS1: the separator rule — the classic parsing bug, in both directions
// ===========================================================================

describe('parseGs1 — fixed vs variable length separators', () => {
  it('reads a full retail label', () => {
    const e = expectOk(parseGs1(RETAIL_LABEL));
    expect(e.format).toBe('gs1-128');
    expect(e.fields).toEqual({
      '01': GTIN,
      '17': '2027-03-31',
      '3912': 'USD 1.23',
      '10': 'ABC123',
      '21': 'SER0001',
    });
    expect(e.amountMinorUnits).toBe(123);
    expect(e.currency).toBe('USD');
  });

  it('does NOT scan to the next separator to end a fixed-length field', () => {
    // The bug: AI 17 is exactly 6 characters. A parser that looked for the next
    // GS would read '2703313912840000123' as the expiry date and then resume
    // parsing from the middle of nowhere.
    const e = expectOk(parseGs1(RETAIL_LABEL));
    expect(e.fields['17']).toBe('2027-03-31');
    expect(e.fields['3912']).toBe('USD 1.23');
  });

  it('does NOT swallow the rest of the string into a variable-length field', () => {
    // The mirror-image bug: AI 10 is variable, so it ends at the GS. A parser
    // that ran to end-of-string would report the batch as
    // 'ABC123<GS>21SER0001' and lose the serial entirely.
    const e = expectOk(parseGs1(RETAIL_LABEL));
    expect(e.fields['10']).toBe('ABC123');
    expect(e.fields['21']).toBe('SER0001');
  });

  it('reads a variable-length field that ends the string, with no trailing separator', () => {
    const e = expectOk(parseGs1(`21SER0001`));
    expect(e.fields['21']).toBe('SER0001');
  });

  it('accepts a trailing separator after the last variable field', () => {
    expect(expectOk(parseGs1(`21SER0001${GS}`)).fields['21']).toBe('SER0001');
  });

  it('tolerates a separator that an encoder wrongly emitted after a fixed field', () => {
    // Not permitted by GS1, but several real encoders do it and the data either
    // side is unambiguous. The extraction must be identical to the clean form.
    const tolerant =
      `01${GTIN}${GS}` + `17270331${GS}` + `3912840000123${GS}` + `10ABC123${GS}` + `21SER0001`;
    expect(expectOk(parseGs1(tolerant))).toEqual(expectOk(parseGs1(RETAIL_LABEL)));
  });

  it('strips a symbology identifier and a leading FNC1', () => {
    expect(expectOk(parseGs1(`]C1${RETAIL_LABEL}`))).toEqual(expectOk(parseGs1(RETAIL_LABEL)));
    expect(expectOk(parseGs1(`]d2${RETAIL_LABEL}`))).toEqual(expectOk(parseGs1(RETAIL_LABEL)));
    expect(expectOk(parseGs1(`${GS}${RETAIL_LABEL}`))).toEqual(expectOk(parseGs1(RETAIL_LABEL)));
  });
});

// ===========================================================================
// GS1: truncation and hostile framing
// ===========================================================================

describe('parseGs1 — truncated and malformed payloads', () => {
  it('rejects a fixed-length field that runs off the end', () => {
    const reason = expectErr(parseGs1('010950110102'));
    expect(reason).toContain('AI 01');
    expect(reason).toContain('truncated');
    expect(reason).toContain('14');
  });

  it('rejects a separator sitting inside a fixed-length field', () => {
    // The encoder wrote a short GTIN and then separated. The value is short,
    // not merely oddly punctuated, so the whole label is untrustworthy.
    const reason = expectErr(parseGs1(`010950110102${GS}091712`));
    expect(reason).toContain('AI 01');
    expect(reason).toContain('group separator');
  });

  it('rejects a variable field over its maximum — a missing separator', () => {
    const reason = expectErr(parseGs1(`21${'A'.repeat(21)}`));
    expect(reason).toContain('AI 21');
    expect(reason).toContain('20-character maximum');
    expect(reason).toContain('missing a group separator');
  });

  it('rejects an empty variable field', () => {
    expect(expectErr(parseGs1(`10${GS}21SER`))).toContain('empty value');
  });

  it('rejects non-numeric data in a numeric AI', () => {
    expect(expectErr(parseGs1('010950110102091X'))).toContain('must be numeric');
  });

  it('rejects an AI that is cut off mid-code', () => {
    // '39' promises a four-digit AI; only three characters remain.
    expect(expectErr(parseGs1('391'))).toContain('Application Identifier');
  });

  it('rejects a payload that does not start with digits', () => {
    expect(expectErr(parseGs1('HELLO'))).toContain('Application Identifier');
  });

  it('rejects an empty payload', () => {
    expect(expectErr(parseGs1(''))).toContain('Empty');
    expect(expectErr(parseGs1(GS))).toContain('Empty');
  });

  it('rejects an absurdly long payload rather than parsing it', () => {
    expect(expectErr(parseGs1('0'.repeat(5000)))).toContain('too long');
  });
});

// ===========================================================================
// GS1: unknown Application Identifiers
// ===========================================================================

describe('parseGs1 — unknown AIs', () => {
  it('stops at an unknown AI instead of swallowing the rest of the string', () => {
    // AI 99 is not in our table, so its LENGTH is unknown and we cannot find
    // where the next AI starts. Keep what is proven; read nothing further.
    const e = expectOk(parseGs1(`01${GTIN}9912345678`));
    expect(e.fields['01']).toBe(GTIN);
    expect(Object.keys(e.fields)).toEqual(['01']);
    expect(hasWarning(e, "unrecognised Application Identifier '99'")).toBe(true);
    expect(hasWarning(e, 'remaining 10 characters')).toBe(true);
  });

  it('never invents a field value for the unknown AI', () => {
    const e = expectOk(parseGs1(`01${GTIN}9912345678`));
    for (const value of Object.values(e.fields)) {
      expect(value).not.toContain('12345678');
    }
    expect(e.fields['99']).toBeUndefined();
  });

  it('stops at an unknown member of a known AI family', () => {
    // '39' means a four-digit AI, so we can read the code — but 392n (amount
    // payable per variable measure) is not in our subset.
    const e = expectOk(parseGs1(`01${GTIN}3922000123`));
    expect(hasWarning(e, "unrecognised Application Identifier '3922'")).toBe(true);
    expect(e.amountMinorUnits).toBeNull();
  });

  it('stops at an unknown member of the 41x family', () => {
    const e = expectOk(parseGs1(`01${GTIN}410${GLN}`));
    expect(hasWarning(e, "unrecognised Application Identifier '410'")).toBe(true);
  });

  it('warns about duplicate AIs and keeps the first value', () => {
    const e = expectOk(parseGs1('1727033117280331'));
    expect(e.fields['17']).toBe('2027-03-31');
    expect(hasWarning(e, 'appears more than once')).toBe(true);
  });
});

// ===========================================================================
// GS1: dates
// ===========================================================================

describe('parseGs1 — YYMMDD dates', () => {
  it('applies the century pivot at the 50/51 boundary', () => {
    expect(expectOk(parseGs1('17500101')).fields['17']).toBe('2050-01-01');
    expect(expectOk(parseGs1('17510101')).fields['17']).toBe('1951-01-01');
  });

  it('places both ends of the pivot window correctly', () => {
    expect(expectOk(parseGs1('17000101')).fields['17']).toBe('2000-01-01');
    expect(expectOk(parseGs1('17990101')).fields['17']).toBe('1999-01-01');
  });

  it("reads DD '00' as the last day of the month", () => {
    // GS1 defines day 00 as end-of-month; it exists because a best-before date
    // is often printed as a month. Day 1 would move the date a month early and
    // day 0 is not a real DateOnly at all.
    const e = expectOk(parseGs1('15270200'));
    expect(e.fields['15']).toBe('2027-02-28');
    expect(hasWarning(e, 'end of month')).toBe(true);
  });

  it("gets DD '00' right in a leap year", () => {
    expect(expectOk(parseGs1('15280200')).fields['15']).toBe('2028-02-29');
    expect(expectOk(parseGs1('15270400')).fields['15']).toBe('2027-04-30');
    expect(expectOk(parseGs1('15271200')).fields['15']).toBe('2027-12-31');
  });

  it('warns and drops a date that names no real day', () => {
    const e = expectOk(parseGs1('17270230'));
    expect(e.fields['17']).toBeUndefined();
    expect(hasWarning(e, 'not a real date')).toBe(true);
  });

  it('warns and drops an impossible month', () => {
    expect(expectOk(parseGs1('17271301')).fields['17']).toBeUndefined();
  });

  it('reads every date AI in the subset', () => {
    const e = expectOk(parseGs1('11260101' + '13260102' + '15260103' + '17260104'));
    expect(e.fields).toMatchObject({
      '11': '2026-01-01',
      '13': '2026-01-02',
      '15': '2026-01-03',
      '17': '2026-01-04',
    });
  });

  it('never puts a product date into transactionDate', () => {
    // Production/packaging/best-before/expiry are not when the user paid.
    // Filing an expense against an expiry date puts it in the wrong period.
    const e = expectOk(parseGs1(RETAIL_LABEL));
    expect(e.transactionDate).toBeNull();
    expect(hasWarning(e, 'never the purchase date')).toBe(true);
  });
});

// ===========================================================================
// GS1: money — the decimal-count vs currency-exponent disagreement
// ===========================================================================

describe('parseGs1 — amounts', () => {
  it('converts 391n through the currency exponent', () => {
    const e = expectOk(parseGs1('3912840000123'));
    expect(e.currency).toBe('USD');
    expect(e.amountMinorUnits).toBe(123);
    expect(e.fields['3912']).toBe('USD 1.23');
  });

  it('handles a zero-decimal currency when the payload agrees', () => {
    const e = expectOk(parseGs1('3910392500'));
    expect(e.currency).toBe('JPY');
    expect(e.amountMinorUnits).toBe(500); // 500 yen, not 5.00
    expect(e.fields['3910']).toBe('JPY 500');
  });

  it('handles a three-decimal currency when the payload agrees', () => {
    const e = expectOk(parseGs1('39134140012500'));
    expect(e.currency).toBe('KWD');
    expect(e.amountMinorUnits).toBe(12500); // 12.500 KWD = 12500 fils
    expect(e.fields['3913']).toBe('KWD 12.500');
  });

  it('REFUSES the amount when the declared decimals contradict the currency', () => {
    // 3912 says two decimals; JPY has none. Scaling by the payload stores
    // 50000 yen, scaling by the currency stores 5 yen. Both are silent and
    // 100x wrong, so neither is acceptable and no amount is recorded.
    const e = expectOk(parseGs1('3912392000500'));
    expect(e.amountMinorUnits).toBeNull();
    expect(hasWarning(e, 'declares 2 decimal places but JPY has 0')).toBe(true);
    expect(hasWarning(e, 'contradicts itself')).toBe(true);
  });

  it('still keeps the currency when only the amount is untrustworthy', () => {
    // The numeric code is an independent field and is not in doubt; pre-filling
    // it saves the user a step even though the amount must be retyped.
    expect(expectOk(parseGs1('3912392000500')).currency).toBe('JPY');
  });

  it('refuses a three-decimal payload for a two-decimal currency', () => {
    const e = expectOk(parseGs1('3913840001234'));
    expect(e.amountMinorUnits).toBeNull();
    expect(e.currency).toBe('USD');
    expect(hasWarning(e, 'declares 3 decimal places but USD has 2')).toBe(true);
  });

  it('refuses an amount from 390n, which carries no currency', () => {
    // Without a currency there is no exponent, and without an exponent there
    // are no minor units. The printed value is surfaced for the user instead.
    const e = expectOk(parseGs1('3902000123'));
    expect(e.amountMinorUnits).toBeNull();
    expect(e.currency).toBeNull();
    expect(e.fields['3902']).toBe('1.23');
    expect(hasWarning(e, 'no currency')).toBe(true);
  });

  it('prefers 391n over 390n when a label carries both', () => {
    const e = expectOk(parseGs1(`3902000999${GS}3912840000123`));
    expect(e.amountMinorUnits).toBe(123);
    expect(e.currency).toBe('USD');
  });

  it('warns when the ISO numeric code is one we cannot name', () => {
    const e = expectOk(parseGs1('3912999000123'));
    expect(e.amountMinorUnits).toBeNull();
    expect(e.currency).toBeNull();
    expect(e.fields['3912']).toBe('#999 1.23');
    expect(hasWarning(e, 'does not support')).toBe(true);
  });

  it('pads a short amount to the declared decimal places', () => {
    expect(expectOk(parseGs1('39128405')).fields['3912']).toBe('USD 0.05');
    expect(expectOk(parseGs1('3912840000')).fields['3912']).toBe('USD 0.00');
  });

  it('rejects a 391n element too short to hold a code and an amount', () => {
    const e = expectOk(parseGs1('3912840'));
    expect(hasWarning(e, 'too short')).toBe(true);
    expect(e.amountMinorUnits).toBeNull();
  });

  it('says so when a label carries no amount at all', () => {
    expect(hasWarning(expectOk(parseGs1(`01${GTIN}`)), 'carries no amount')).toBe(true);
  });

  it('never produces a fractional minor-unit value', () => {
    for (const payload of ['3912840000123', '3910392500', '39134140012500']) {
      const amount = expectOk(parseGs1(payload)).amountMinorUnits;
      if (amount !== null) expect(Number.isSafeInteger(amount)).toBe(true);
    }
  });
});

// ===========================================================================
// GS1: check digits and identifiers
// ===========================================================================

describe('parseGs1 — check digits and identifiers', () => {
  it('accepts a GTIN with a correct check digit silently', () => {
    expect(hasWarning(expectOk(parseGs1(`01${GTIN}`)), 'check digit')).toBe(false);
  });

  it('warns about a bad GTIN check digit but still reports the value', () => {
    const e = expectOk(parseGs1(`01${GTIN_BAD_CHECK}`));
    expect(e.fields['01']).toBe(GTIN_BAD_CHECK);
    expect(hasWarning(e, 'check digit')).toBe(true);
    expect(hasWarning(e, 'Rescan')).toBe(true);
  });

  it('reads a GLN and says it is not a vendor name', () => {
    const e = expectOk(parseGs1(`414${GLN}`));
    expect(e.fields['414']).toBe(GLN);
    expect(e.vendor).toBeNull();
    expect(hasWarning(e, `GLN ${GLN} is an identifier, not a vendor name`)).toBe(true);
  });

  it('warns about a bad GLN check digit', () => {
    expect(hasWarning(expectOk(parseGs1('4144012345678902')), 'check digit')).toBe(true);
  });

  it('never invents a vendor from a GS1 label', () => {
    expect(expectOk(parseGs1(RETAIL_LABEL)).vendor).toBeNull();
    expect(hasWarning(expectOk(parseGs1(RETAIL_LABEL)), 'Enter the vendor manually')).toBe(true);
  });
});

// ===========================================================================
// Fiscal QR
// ===========================================================================

const FISCAL_HAPPY = fiscalQr(
  tlvText(1, 'Corner Newsstand'),
  tlvText(2, '310122393500003'),
  tlvText(3, '2026-08-11T14:03:22+03:00'),
  tlvText(4, '1150.00'),
  tlvText(5, '150.00'),
);

describe('parseFiscalQr', () => {
  it('decodes a well-formed invoice QR', () => {
    const e = expectOk(parseFiscalQr(FISCAL_HAPPY));
    expect(e.format).toBe('fiscal-qr');
    expect(e.vendor).toBe('Corner Newsstand');
    expect(e.fields).toEqual({
      '1': 'Corner Newsstand',
      '2': '310122393500003',
      '3': '2026-08-11T14:03:22+03:00',
      '4': '1150.00',
      '5': '150.00',
    });
  });

  it('takes the invoice date exactly as the issuer wrote it', () => {
    // NOT instantToDateOnlyUTC. That function's own doc comment forbids using
    // it for transactionDate: re-projecting +03:00 through UTC would move a
    // 01:30 local purchase to the previous day. The issuer already printed the
    // date in their own calendar, so we read it, we do not convert it.
    expect(expectOk(parseFiscalQr(FISCAL_HAPPY)).transactionDate).toBe('2026-08-11');
  });

  it('keeps a local date that would move if it were converted to UTC', () => {
    const payload = fiscalQr(tlvText(1, 'Late Night Diner'), tlvText(3, '2026-01-01T01:30:00+09:00'));
    // In UTC this instant is 2025-12-31T16:30Z — a different year. The receipt
    // says 2026-01-01, so the expense belongs in 2026.
    expect(expectOk(parseFiscalQr(payload)).transactionDate).toBe('2026-01-01');
  });

  it('REFUSES to record an amount, because the format carries no currency', () => {
    // '1150.00' is 115000 minor units in a 2-decimal currency and is not a
    // representable JPY amount at all. Assuming the issuing country's currency
    // is the exact assumption money.ts exists to forbid.
    const e = expectOk(parseFiscalQr(FISCAL_HAPPY));
    expect(e.amountMinorUnits).toBeNull();
    expect(e.currency).toBeNull();
    expect(hasWarning(e, 'no currency code')).toBe(true);
    expect(hasWarning(e, '1150.00')).toBe(true);
  });

  it('warns about an unparseable timestamp rather than guessing', () => {
    const e = expectOk(parseFiscalQr(fiscalQr(tlvText(1, 'X'), tlvText(3, '11/08/2026'))));
    expect(e.transactionDate).toBeNull();
    expect(hasWarning(e, 'not an ISO-8601 date')).toBe(true);
  });

  it('warns about a timestamp naming no real day', () => {
    const e = expectOk(parseFiscalQr(fiscalQr(tlvText(1, 'X'), tlvText(3, '2026-02-30T10:00:00Z'))));
    expect(e.transactionDate).toBeNull();
  });

  it('says so when there is no seller name and no timestamp', () => {
    const e = expectOk(parseFiscalQr(fiscalQr(tlvText(4, '10.00'))));
    expect(e.vendor).toBeNull();
    expect(hasWarning(e, 'no seller name')).toBe(true);
    expect(hasWarning(e, 'no timestamp')).toBe(true);
  });

  it('skips tags it does not read without losing alignment', () => {
    // Tags 6-8 carry a hash and a signature in the real format. They are
    // length-framed, so skipping them must not shift anything after them.
    const payload = fiscalQr(
      tlvText(1, 'Hashed Goods'),
      tlvRaw(6, [0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]),
      tlvRaw(7, [0x01, 0x02]),
      tlvText(4, '42.50'),
    );
    const e = expectOk(parseFiscalQr(payload));
    expect(e.vendor).toBe('Hashed Goods');
    expect(e.fields['4']).toBe('42.50');
    expect(e.fields['6']).toBeUndefined();
    expect(e.fields['7']).toBeUndefined();
  });

  it('keeps the first value of a duplicated tag', () => {
    const e = expectOk(parseFiscalQr(fiscalQr(tlvText(1, 'First'), tlvText(1, 'Second'))));
    expect(e.vendor).toBe('First');
    expect(hasWarning(e, 'more than once')).toBe(true);
  });
});

describe('parseFiscalQr — non-ASCII seller names', () => {
  it('decodes multi-byte UTF-8', () => {
    const name = 'مؤسسة التجارة';
    expect(expectOk(parseFiscalQr(fiscalQr(tlvText(1, name)))).vendor).toBe(name);
  });

  it('decodes three-byte and four-byte sequences, including astral code points', () => {
    const name = 'Café Ñuñoa ☺ 🧾';
    expect(expectOk(parseFiscalQr(fiscalQr(tlvText(1, name)))).vendor).toBe(name);
  });

  it('decodes CJK', () => {
    const name = 'コーヒーショップ';
    expect(expectOk(parseFiscalQr(fiscalQr(tlvText(1, name)))).vendor).toBe(name);
  });

  it('rejects invalid UTF-8 rather than producing replacement characters', () => {
    // A name full of U+FFFD is indistinguishable from a name that contains
    // them, and this value ends up on an expense record.
    const e = expectOk(parseFiscalQr(fiscalQr(tlvRaw(1, [0xff, 0xfe]), tlvText(4, '1.00'))));
    expect(e.vendor).toBeNull();
    expect(hasWarning(e, 'not valid UTF-8')).toBe(true);
    expect(e.fields['4']).toBe('1.00');
  });

  it('rejects an overlong encoding of "/"', () => {
    // 0xc0 0xaf is the classic path-traversal smuggling form of '/'.
    const e = expectOk(parseFiscalQr(fiscalQr(tlvRaw(1, [0xc0, 0xaf]))));
    expect(e.vendor).toBeNull();
    expect(hasWarning(e, 'not valid UTF-8')).toBe(true);
  });

  it('rejects an encoded surrogate half', () => {
    // ED A0 80 is CESU-8 for U+D800, which is not a valid Unicode scalar.
    expect(expectOk(parseFiscalQr(fiscalQr(tlvRaw(1, [0xed, 0xa0, 0x80])))).vendor).toBeNull();
  });

  it('rejects a multi-byte sequence truncated by the record length', () => {
    // The lead byte promises two continuation bytes that lie outside this
    // record. The decoder must stop at the record boundary, not read on.
    const e = expectOk(parseFiscalQr(fiscalQr(tlvRaw(1, [0xe2, 0x98]), tlvText(4, '2.00'))));
    expect(e.vendor).toBeNull();
    expect(e.fields['4']).toBe('2.00');
  });

  it('strips control characters from a seller name', () => {
    expect(expectOk(parseFiscalQr(fiscalQr(tlvText(1, 'Ac\x07me\x00 Ltd')))).vendor).toBe(
      'Acme Ltd',
    );
  });

  it('truncates an absurdly long seller name and says so', () => {
    const e = expectOk(parseFiscalQr(fiscalQr(tlvText(1, 'N'.repeat(200)))));
    expect(e.vendor).toHaveLength(120);
    expect(hasWarning(e, 'shortened')).toBe(true);
  });

  it('treats a whitespace-only seller name as absent', () => {
    const e = expectOk(parseFiscalQr(fiscalQr(tlvText(1, '   '), tlvText(4, '1.00'))));
    expect(e.vendor).toBeNull();
    expect(hasWarning(e, 'Tag 1 is empty')).toBe(true);
  });
});

describe('parseFiscalQr — invalid base64', () => {
  it('fails instead of throwing on obvious junk', () => {
    expect(expectErr(parseFiscalQr('not valid base64!!!'))).toContain('Not valid base64');
  });

  it('rejects characters outside the alphabet even at the right length', () => {
    expect(expectErr(parseFiscalQr('####'))).toContain('Not valid base64');
    expect(expectErr(parseFiscalQr('AB$='))).toContain('Not valid base64');
  });

  it('requires padding — an unpadded string lost characters in transit', () => {
    expect(FISCAL_HAPPY.length % 4).toBe(0);
    expect(expectErr(parseFiscalQr(FISCAL_HAPPY.slice(0, FISCAL_HAPPY.length - 1)))).toContain(
      'Not valid base64',
    );
  });

  it('rejects pad characters inside the body', () => {
    expect(expectErr(parseFiscalQr('A=AA'))).toContain('Not valid base64');
    expect(expectErr(parseFiscalQr('===='))).toContain('Not valid base64');
  });

  it('rejects URL-safe base64 rather than silently losing sextets', () => {
    expect(expectErr(parseFiscalQr('a-_A'))).toContain('Not valid base64');
  });

  it('rejects an empty payload', () => {
    expect(expectErr(parseFiscalQr(''))).toContain('Not valid base64');
  });

  it('rejects an absurdly long payload', () => {
    expect(expectErr(parseFiscalQr('A'.repeat(5000)))).toContain('too long');
  });
});

describe('parseFiscalQr — hostile TLV framing', () => {
  it('refuses a declared length that overruns the buffer', () => {
    // 4 bytes total: tag 1, length 200, two bytes of value. Reading 200 would
    // walk off the end of the array.
    const reason = expectErr(parseFiscalQr(base64Encode([1, 200, 0x41, 0x42])));
    expect(reason).toContain('declares 200 bytes');
    expect(reason).toContain('only 2 remain');
  });

  it('refuses an overrun that only appears in a later record', () => {
    const reason = expectErr(parseFiscalQr(base64Encode([1, 2, 0x41, 0x42, 4, 100, 0x31])));
    expect(reason).toContain('tag 4');
    expect(reason).toContain('declares 100 bytes');
  });

  it('refuses a length byte that overruns by exactly one', () => {
    const reason = expectErr(parseFiscalQr(base64Encode([1, 3, 0x41, 0x42])));
    expect(reason).toContain('declares 3 bytes');
    expect(reason).toContain('only 2 remain');
  });

  it('refuses a truncated TLV header', () => {
    expect(expectErr(parseFiscalQr(base64Encode([1])))).toContain('Truncated TLV header');
    expect(expectErr(parseFiscalQr(base64Encode([1, 2, 0x41, 0x42, 5])))).toContain(
      'Truncated TLV header',
    );
  });

  it('accepts a record whose length exactly consumes the buffer', () => {
    // The boundary the overrun check must not be off-by-one about.
    expect(expectOk(parseFiscalQr(base64Encode([1, 2, 0x41, 0x42]))).vendor).toBe('AB');
  });

  it('accepts a zero-length record and calls it empty', () => {
    const e = expectOk(parseFiscalQr(base64Encode([1, 0, 4, 4, 0x31, 0x2e, 0x30, 0x30])));
    expect(e.vendor).toBeNull();
    expect(e.fields['4']).toBe('1.00');
  });
});

// ===========================================================================
// decodeBarcodePayload — routing
// ===========================================================================

describe('decodeBarcodePayload', () => {
  it('routes a GS1 payload to the GS1 parser', () => {
    expect(expectOk(decodeBarcodePayload(RETAIL_LABEL))).toEqual(expectOk(parseGs1(RETAIL_LABEL)));
  });

  it('routes a fiscal QR to the fiscal parser', () => {
    expect(expectOk(decodeBarcodePayload(FISCAL_HAPPY))).toEqual(expectOk(parseFiscalQr(FISCAL_HAPPY)));
  });

  it('propagates a malformed-GS1 failure rather than downgrading it to unknown', () => {
    // Silently calling a half-read barcode "unrecognised" would hide the fact
    // that the scanner got half a label.
    expect(expectErr(decodeBarcodePayload('010950110102'))).toContain('truncated');
  });

  it('propagates a hostile-TLV failure', () => {
    expect(expectErr(decodeBarcodePayload(base64Encode([1, 200, 0x41, 0x42])))).toContain(
      'declares 200 bytes',
    );
  });

  it('reports a plain URL as recognised-but-unusable, not as an error', () => {
    const e = expectOk(decodeBarcodePayload('https://example.com/receipt/12345'));
    expect(e.format).toBe('unknown');
    expect(e.vendor).toBeNull();
    expect(e.amountMinorUnits).toBeNull();
    expect(e.currency).toBeNull();
    expect(e.transactionDate).toBeNull();
    expect(e.fields).toEqual({});
    expect(hasWarning(e, 'Enter the details manually')).toBe(true);
    expect(hasWarning(e, 'https://example.com/receipt/12345')).toBe(true);
  });

  it('reports arbitrary text as unknown', () => {
    for (const payload of [
      'WIFI:S:CafeGuest;T:WPA;P:hunter2;;',
      'BEGIN:VCARD\nVERSION:3.0\nEND:VCARD',
      'tel:+15551234567',
      'Just some words',
      '9912345678',
    ]) {
      expect(expectOk(decodeBarcodePayload(payload)).format).toBe('unknown');
    }
  });

  it('reports base64 that is not a fiscal QR as unknown, not as a malformed invoice', () => {
    // 'Hello world' is valid base64 but its first byte is not a plausible tag.
    const payload = base64Encode(utf8Encode('Hello world'));
    expect(payload).toBe('SGVsbG8gd29ybGQ=');
    expect(expectOk(decodeBarcodePayload(payload)).format).toBe('unknown');
  });

  it('truncates and de-controls the payload echo in the unknown warning', () => {
    const e = expectOk(decodeBarcodePayload(`bad\x07text${'x'.repeat(200)}`));
    expect(e.warnings.join(' ')).toContain('...');
    expect(e.warnings.join(' ')).not.toContain('\x07');
  });

  it('rejects an empty or whitespace payload', () => {
    expect(expectErr(decodeBarcodePayload(''))).toContain('Empty');
    expect(expectErr(decodeBarcodePayload('   '))).toContain('Empty');
  });

  it('rejects an absurdly long payload', () => {
    expect(expectErr(decodeBarcodePayload('x'.repeat(5000)))).toContain('too long');
  });

  it('is deterministic — the same payload always decodes identically', () => {
    for (const payload of [RETAIL_LABEL, FISCAL_HAPPY, 'https://example.com', '3912392000500']) {
      expect(decodeBarcodePayload(payload)).toEqual(decodeBarcodePayload(payload));
    }
  });

  it('never throws, whatever it is handed', () => {
    const hostile = [
      '',
      GS,
      GS.repeat(50),
      ']C1',
      '01',
      '39',
      '3',
      '\x00\x01\x02',
      '😀',
      'AAAA',
      'A'.repeat(4096),
      `01${GTIN}${GS.repeat(9)}21X`,
      '99'.repeat(100),
      base64Encode([1, 255, 1, 255, 1, 255]),
    ];
    for (const payload of hostile) {
      expect(() => decodeBarcodePayload(payload)).not.toThrow();
    }
  });
});

// ===========================================================================
// The invariant the router's single-pass design rests on
// ===========================================================================

describe('format detection is unambiguous', () => {
  it('a fiscal QR can never look like GS1', () => {
    // A fiscal QR's first TLV tag is 1-8, so its first byte is 0x01-0x08. The
    // first base64 character encodes that byte's top six bits — 0, 1 or 2,
    // i.e. 'A', 'B' or 'C'. Base64's digits start at index 52, so a fiscal QR
    // can never begin with a digit, nor with ']'. A GS1 payload always begins
    // with one or the other, so the two detectors are disjoint and
    // decodeBarcodePayload needs no fallback between them.
    for (let tag = 1; tag <= 8; tag++) {
      for (let length = 0; length <= 255; length++) {
        const first = base64Encode([tag, length]).charAt(0);
        expect(first).toMatch(/^[ABC]$/);
        expect(first).not.toMatch(/[0-9\]]/);
      }
    }
  });
});
