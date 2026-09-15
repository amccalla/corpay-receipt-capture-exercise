/**
 * Regressions found by an adversarial review pass.
 *
 * Each of these was a real defect in code that already had a green test suite,
 * which is the reason they are pinned separately and with the failing input
 * spelled out: the original suites were not wrong so much as they never asked
 * these questions.
 */

import { formatMinorUnits, parseAmountToMinorUnits } from '../money';
import { safeStorageKey, validateReceiptFile } from '../validation';

describe('a currency symbol that contradicts the declared currency', () => {
  // Was: '¥500' in a USD field parsed as USD 500.00 — a 100x error, silently.
  it.each([
    ['¥500', 'USD'],
    ['€19.99', 'USD'],
    ['$19.99', 'EUR'],
    ['£10', 'JPY'],
  ])('rejects %s entered as %s', (input, currency) => {
    const r = parseAmountToMinorUnits(input, currency);
    expect(r.ok).toBe(false);
  });

  it('still accepts a symbol that does match', () => {
    expect(parseAmountToMinorUnits('$19.99', 'USD')).toEqual({ ok: true, minorUnits: 1999 });
    expect(parseAmountToMinorUnits('¥500', 'JPY')).toEqual({ ok: true, minorUnits: 500 });
    expect(parseAmountToMinorUnits('€19.99', 'EUR')).toEqual({ ok: true, minorUnits: 1999 });
  });

  it('treats a mismatched symbol exactly like a mismatched ISO code', () => {
    // The ISO-code path always rejected this; the symbol path did not. The
    // point of the fix is that they now agree.
    expect(parseAmountToMinorUnits('EUR19.99', 'USD').ok).toBe(false);
    expect(parseAmountToMinorUnits('€19.99', 'USD').ok).toBe(false);
  });
});

describe('comma ambiguity in three-decimal currencies', () => {
  // Was: '0,750' OMR parsed as 750000 minor units — OMR 750.000 instead of
  // OMR 0.750, a 1000x overstatement.
  it.each([
    ['0,750', 'OMR'],
    ['1,234', 'BHD'],
    ['12,500', 'TND'],
    ['1,500', 'KWD'],
  ])('rejects the ambiguous %s for %s', (input, currency) => {
    expect(parseAmountToMinorUnits(input, currency).ok).toBe(false);
  });

  it('rejects a leading 0-group comma for every currency, not just 3-decimal ones', () => {
    expect(parseAmountToMinorUnits('0,750', 'USD').ok).toBe(false);
    expect(parseAmountToMinorUnits('0,750', 'JPY').ok).toBe(false);
  });

  it('still accepts the unambiguous decimal-point form', () => {
    expect(parseAmountToMinorUnits('0.750', 'OMR')).toEqual({ ok: true, minorUnits: 750 });
    expect(parseAmountToMinorUnits('1.234', 'BHD')).toEqual({ ok: true, minorUnits: 1234 });
  });

  it('still accepts genuine thousands grouping in two-decimal currencies', () => {
    expect(parseAmountToMinorUnits('1,234.56', 'USD')).toEqual({ ok: true, minorUnits: 123456 });
    expect(parseAmountToMinorUnits('12,345', 'USD')).toEqual({ ok: true, minorUnits: 1234500 });
  });
});

describe('formatMinorUnits refuses what the parser would have refused', () => {
  // Was: Number.isInteger(1e21) is true, so this returned the string '1e+.21'.
  it.each([1e21, -1e21, 1.5e22, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 2])(
    'throws on %p rather than printing corrupt text',
    (v) => {
      expect(() => formatMinorUnits(v, 'USD')).toThrow(RangeError);
    },
  );

  it('still formats the largest exactly-representable value', () => {
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, 'USD')).toBe('90071992547409.91');
  });

  it('never returns a string containing exponential notation', () => {
    for (const v of [0, 1, 999, 100000, Number.MAX_SAFE_INTEGER]) {
      expect(formatMinorUnits(v, 'USD')).not.toMatch(/e/i);
    }
  });
});

describe('storage keys are deterministic per draft across HEIF label drift', () => {
  // Was: the degraded path (no readable header) kept the declared 'image/heif'
  // while the sniffed path returned 'image/heic', producing two object keys
  // for one draft — orphaned storage on every retry.
  const HEIC_HEADER = new Uint8Array([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  ]);

  it('produces the same key whether or not the header could be read', () => {
    const base = { fileName: 'IMG_0042.HEIC', declaredMime: 'image/heif', sizeBytes: 900_000 };

    const degraded = validateReceiptFile({ ...base, magicBytes: null });
    const sniffed = validateReceiptFile({ ...base, magicBytes: HEIC_HEADER });

    expect(degraded.ok).toBe(true);
    expect(sniffed.ok).toBe(true);
    if (!degraded.ok || !sniffed.ok) return;

    expect(safeStorageKey('co_acme', 'rcpt_01H9', degraded.normalizedMime)).toBe(
      safeStorageKey('co_acme', 'rcpt_01H9', sniffed.normalizedMime),
    );
  });

  it('keeps distinct drafts on distinct keys', () => {
    expect(safeStorageKey('co_a', 'rcpt_1', 'image/heic')).not.toBe(
      safeStorageKey('co_a', 'rcpt_2', 'image/heic'),
    );
    expect(safeStorageKey('co_a', 'rcpt_1', 'image/heic')).not.toBe(
      safeStorageKey('co_b', 'rcpt_1', 'image/heic'),
    );
  });
});
