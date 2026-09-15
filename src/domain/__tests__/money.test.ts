import type { Money } from '../types';
import {
  THREE_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
  exponentFor,
  formatMinorUnits,
  formatMoney,
  isSupportedCurrency,
  moneyEquals,
  parseAmountToMinorUnits,
} from '../money';

/** Narrowing helper so tests read as assertions, not as type gymnastics. */
function expectOk(input: string, currency: string): number {
  const r = parseAmountToMinorUnits(input, currency);
  if (!r.ok) throw new Error(`expected '${input}' (${currency}) to parse, got: ${r.error}`);
  return r.minorUnits;
}

function expectErr(input: string, currency: string): string {
  const r = parseAmountToMinorUnits(input, currency);
  if (r.ok) throw new Error(`expected '${input}' (${currency}) to be rejected, got ${r.minorUnits}`);
  return r.error;
}

// ---------------------------------------------------------------------------
// exponentFor
// ---------------------------------------------------------------------------

describe('exponentFor', () => {
  it('returns 2 for ordinary currencies', () => {
    for (const c of ['USD', 'EUR', 'GBP', 'CAD', 'MXN', 'HUF', 'INR']) {
      expect(exponentFor(c)).toBe(2);
    }
  });

  it('returns 0 for zero-decimal currencies', () => {
    for (const c of ['JPY', 'KRW', 'VND', 'CLP', 'ISK']) {
      expect(exponentFor(c)).toBe(0);
    }
  });

  it('returns 3 for three-decimal currencies', () => {
    for (const c of ['BHD', 'JOD', 'KWD', 'OMR', 'TND']) {
      expect(exponentFor(c)).toBe(3);
    }
  });

  it('agrees with the exported sets for every member', () => {
    for (const c of ZERO_DECIMAL_CURRENCIES) expect(exponentFor(c)).toBe(0);
    for (const c of THREE_DECIMAL_CURRENCIES) expect(exponentFor(c)).toBe(3);
  });

  it('never lets a currency be both zero- and three-decimal', () => {
    for (const c of ZERO_DECIMAL_CURRENCIES) {
      expect(THREE_DECIMAL_CURRENCIES.has(c)).toBe(false);
    }
  });

  // The whole point: an unknown code must be loud, not silently 2 decimals.
  const unknownCodes: string[] = ['XYZ', '', 'US', 'EURO', 'usd', 'Usd', ' USD', 'USD '];
  it.each(unknownCodes)('throws rather than assuming 2 decimals for %p', (code) => {
    expect(() => exponentFor(code)).toThrow(RangeError);
  });
});

describe('isSupportedCurrency', () => {
  it('accepts known codes across all three exponents', () => {
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('JPY')).toBe(true);
    expect(isSupportedCurrency('BHD')).toBe(true);
  });

  it('is case-sensitive: normalising is the caller job, not a hidden fixup', () => {
    expect(isSupportedCurrency('usd')).toBe(false);
    expect(isSupportedCurrency('Usd')).toBe(false);
  });

  it('rejects junk and near-misses', () => {
    for (const c of ['', ' ', 'XYZ', 'US', 'USDD', '$', '123']) {
      expect(isSupportedCurrency(c)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The float trap
// ---------------------------------------------------------------------------

describe('parseAmountToMinorUnits — the float trap', () => {
  // These are the canonical values where `Number(x) * 100` is not an integer.
  // Asserting the trap here documents WHY the implementation is string-based.
  it('naive float multiplication really is wrong for these inputs', () => {
    expect(Number('19.99') * 100).not.toBe(1999);
    expect(Number('8.87') * 100).not.toBe(887);
    expect(Number('1.13') * 100).not.toBe(113);
    expect(Number('0.29') * 100).not.toBe(29);
  });

  const exactCases: [string, number][] = [
    ['19.99', 1999],
    ['0.07', 7],
    ['1.10', 110],
    ['8.87', 887],
    ['1.13', 113],
    ['0.29', 29],
    ['12.30', 1230],
    ['4.35', 435],
  ];
  it.each(exactCases)('parses %p to %p exactly', (input, expected) => {
    expect(expectOk(input, 'USD')).toBe(expected);
  });

  it('does not round a value that a float would have smeared', () => {
    // 2.675 is the textbook float-rounding example (2.675 -> 2.67499999...).
    // We reject it outright: it is over-precision for USD, not a rounding job.
    expect(expectErr('2.675', 'USD')).toMatch(/2 decimal places/);
  });

  it('round-trips every cent value from 0 to 1000 without drift', () => {
    for (let cents = 0; cents <= 1000; cents += 1) {
      const text = formatMinorUnits(cents, 'USD');
      expect(expectOk(text, 'USD')).toBe(cents);
    }
  });
});

// ---------------------------------------------------------------------------
// Exponent-sensitive parsing
// ---------------------------------------------------------------------------

describe('parseAmountToMinorUnits — zero-decimal currencies', () => {
  it('treats JPY 500 as 500 minor units, not 50000', () => {
    expect(expectOk('500', 'JPY')).toBe(500);
    expect(expectOk('1,250', 'JPY')).toBe(1250);
    expect(expectOk('0', 'KRW')).toBe(0);
  });

  it('rejects any decimal place, including a value-free trailing zero', () => {
    expect(expectErr('500.00', 'JPY')).toMatch(/no decimal places/);
    expect(expectErr('500.5', 'JPY')).toMatch(/no decimal places/);
    expect(expectErr('0.0', 'VND')).toMatch(/no decimal places/);
  });
});

describe('parseAmountToMinorUnits — three-decimal currencies', () => {
  it('scales BHD by 1000', () => {
    expect(expectOk('1.234', 'BHD')).toBe(1234);
    expect(expectOk('1', 'KWD')).toBe(1000);
    expect(expectOk('0.005', 'OMR')).toBe(5);
  });

  it('right-pads a short fraction rather than misreading it', () => {
    // '1.2' BHD is 1.200, i.e. 1200 fils — NOT 12.
    expect(expectOk('1.2', 'BHD')).toBe(1200);
    expect(expectOk('1.20', 'BHD')).toBe(1200);
  });

  it('rejects a fourth decimal place', () => {
    expect(expectErr('1.2345', 'BHD')).toMatch(/3 decimal places/);
  });
});

// ---------------------------------------------------------------------------
// Input shapes we accept
// ---------------------------------------------------------------------------

describe('parseAmountToMinorUnits — accepted input shapes', () => {
  const shapes: [string, number][] = [
    ['19.99', 1999],
    ['  19.99  ', 1999],
    ['\t19.99\n', 1999],
    ['$19.99', 1999],
    ['$ 19.99', 1999],
    [' $19.99 ', 1999],
    ['USD 19.99', 1999],
    ['USD19.99', 1999],
    ['1,234.56', 123456],
    ['12,345,678.90', 1234567890],
    ['1,234', 123400],
    ['.99', 99],
    ['0.99', 99],
    ['00019.99', 1999],
    ['19', 1900],
    ['19.9', 1990],
    ['0', 0],
    ['0.00', 0],
  ];
  it.each(shapes)('accepts %p as %p minor units', (input, expected) => {
    expect(expectOk(input, 'USD')).toBe(expected);
  });

  it('strips any leading Unicode currency symbol, not just $', () => {
    expect(expectOk('€10.00', 'EUR')).toBe(1000);
    expect(expectOk('£0.01', 'GBP')).toBe(1);
    expect(expectOk('¥500', 'JPY')).toBe(500);
    expect(expectOk('₹1,234.50', 'INR')).toBe(123450);
  });

  it('does not strip a bare letter prefix, which is junk rather than a symbol', () => {
    expect(expectErr('abc19.99', 'USD')).toBeTruthy();
    expect(expectErr('EUR19.99', 'USD')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Rejection paths
// ---------------------------------------------------------------------------

describe('parseAmountToMinorUnits — rejections', () => {
  it('rejects empty and whitespace-only input', () => {
    expect(expectErr('', 'USD')).toMatch(/Enter an amount/);
    expect(expectErr('   ', 'USD')).toMatch(/Enter an amount/);
    expect(expectErr('$', 'USD')).toMatch(/Enter an amount/);
    expect(expectErr('USD', 'USD')).toMatch(/Enter an amount/);
  });

  it('rejects negatives in every notation', () => {
    for (const input of ['-5.00', '-$5.00', '$-5.00', '−5.00', '(5.00)', '- 5']) {
      expect(expectErr(input, 'USD')).toMatch(/cannot be negative/);
    }
  });

  it('rejects NaN, Infinity and scientific notation', () => {
    for (const input of ['NaN', 'Infinity', '-Infinity', '1e5', '1E5', '0x10']) {
      expect(expectErr(input, 'USD')).toBeTruthy();
    }
  });

  it('rejects malformed numbers', () => {
    for (const input of ['abc', '19.99.99', '1..2', '1.', '.', '19,', ',19', '+5', '5%', '1 2']) {
      expect(expectErr(input, 'USD')).toBeTruthy();
    }
  });

  it('rejects a trailing currency code — only a leading one is stripped', () => {
    // Pinned deliberately: silently accepting '19.99 USD' for a EUR field would
    // record the wrong currency without telling anyone.
    expect(expectErr('19.99 USD', 'USD')).toBeTruthy();
  });

  it('rejects ambiguous separator layouts instead of guessing a locale', () => {
    for (const input of ['1,23.45', '1,50', '1.234,56', '12,34,567.00', '1,2345']) {
      expect(expectErr(input, 'USD')).toBeTruthy();
    }
  });

  it('rejects over-precision rather than silently rounding', () => {
    const err = expectErr('1.999', 'USD');
    expect(err).toMatch(/USD has 2 decimal places/);
    expect(err).toMatch(/has 3/);
    expect(expectErr('0.001', 'USD')).toBeTruthy();
    expect(expectErr('19.995', 'USD')).toBeTruthy();
  });

  it('rejects an unsupported currency without throwing', () => {
    const r = parseAmountToMinorUnits('19.99', 'XYZ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported currency 'XYZ'/);
    expect(expectErr('19.99', 'usd')).toMatch(/Unsupported currency/);
  });

  it('rejects absurdly long input before parsing it', () => {
    expect(expectErr(`${'1'.repeat(200)}.00`, 'USD')).toMatch(/too long/);
  });
});

// ---------------------------------------------------------------------------
// Safe-integer boundary
// ---------------------------------------------------------------------------

describe('parseAmountToMinorUnits — MAX_SAFE_INTEGER boundary', () => {
  // MAX_SAFE_INTEGER === 9007199254740991 -> 90071992547409.91 USD.
  it('accepts exactly MAX_SAFE_INTEGER minor units', () => {
    expect(expectOk('90071992547409.91', 'USD')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects one minor unit above MAX_SAFE_INTEGER', () => {
    expect(expectErr('90071992547409.92', 'USD')).toMatch(/too large/);
  });

  it('rejects values far above the limit', () => {
    expect(expectErr('999,999,999,999,999.99', 'USD')).toMatch(/too large/);
    expect(expectErr('9007199254740992', 'JPY')).toMatch(/too large/);
  });

  it('accepts the boundary for a zero-decimal currency', () => {
    expect(expectOk('9007199254740991', 'JPY')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is not fooled by leading zeros when checking the limit', () => {
    expect(expectOk('00000000000000000019.99', 'USD')).toBe(1999);
  });
});

// ---------------------------------------------------------------------------
// formatMinorUnits
// ---------------------------------------------------------------------------

describe('formatMinorUnits', () => {
  const formatCases: [number, string, string][] = [
    [1999, 'USD', '19.99'],
    [7, 'USD', '0.07'],
    [70, 'USD', '0.70'],
    [0, 'USD', '0.00'],
    [1, 'USD', '0.01'],
    [100000000, 'USD', '1000000.00'],
    [500, 'JPY', '500'],
    [0, 'JPY', '0'],
    [1234, 'BHD', '1.234'],
    [5, 'BHD', '0.005'],
    [1000, 'KWD', '1.000'],
  ];
  it.each(formatCases)('formats %p %s as %p', (minorUnits, currency, expected) => {
    expect(formatMinorUnits(minorUnits, currency)).toBe(expected);
  });

  it('keeps the sign on negative stored values (refunds, deltas)', () => {
    expect(formatMinorUnits(-1999, 'USD')).toBe('-19.99');
    expect(formatMinorUnits(-7, 'USD')).toBe('-0.07');
    expect(formatMinorUnits(-500, 'JPY')).toBe('-500');
    expect(formatMinorUnits(-5, 'BHD')).toBe('-0.005');
  });

  it('throws if a float leaked into minorUnits', () => {
    expect(() => formatMinorUnits(19.99, 'USD')).toThrow(RangeError);
    expect(() => formatMinorUnits(1998.9999999999998, 'USD')).toThrow(RangeError);
    expect(() => formatMinorUnits(Number.NaN, 'USD')).toThrow(RangeError);
    expect(() => formatMinorUnits(Number.POSITIVE_INFINITY, 'USD')).toThrow(RangeError);
  });

  it('throws on an unknown currency', () => {
    expect(() => formatMinorUnits(1999, 'XYZ')).toThrow(RangeError);
  });

  it('formats MAX_SAFE_INTEGER without losing a digit', () => {
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, 'USD')).toBe('90071992547409.91');
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, 'JPY')).toBe('9007199254740991');
  });
});

// ---------------------------------------------------------------------------
// formatMoney / moneyEquals
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('prefixes the code, because a bare number has no meaning', () => {
    expect(formatMoney({ minorUnits: 1999, currency: 'USD' })).toBe('USD 19.99');
    expect(formatMoney({ minorUnits: 500, currency: 'JPY' })).toBe('JPY 500');
    expect(formatMoney({ minorUnits: 1234, currency: 'BHD' })).toBe('BHD 1.234');
  });

  it('makes the JPY/USD difference visible at a glance', () => {
    expect(formatMoney({ minorUnits: 500, currency: 'JPY' })).not.toBe(
      formatMoney({ minorUnits: 500, currency: 'USD' }),
    );
  });
});

describe('moneyEquals', () => {
  const usd1999: Money = { minorUnits: 1999, currency: 'USD' };

  it('requires both amount and currency to match', () => {
    expect(moneyEquals(usd1999, { minorUnits: 1999, currency: 'USD' })).toBe(true);
    expect(moneyEquals(usd1999, { minorUnits: 2000, currency: 'USD' })).toBe(false);
    expect(moneyEquals(usd1999, { minorUnits: 1999, currency: 'EUR' })).toBe(false);
  });

  it('never treats equal minor units in different currencies as equal', () => {
    // The trap: 1000 JPY and 1000 USD share a number and nothing else.
    expect(
      moneyEquals({ minorUnits: 1000, currency: 'JPY' }, { minorUnits: 1000, currency: 'USD' }),
    ).toBe(false);
  });

  it('is reflexive and symmetric over a sample', () => {
    const samples: Money[] = [
      { minorUnits: 0, currency: 'USD' },
      { minorUnits: 1999, currency: 'USD' },
      { minorUnits: 1999, currency: 'EUR' },
      { minorUnits: 500, currency: 'JPY' },
      { minorUnits: 1234, currency: 'BHD' },
    ];
    for (const a of samples) {
      expect(moneyEquals(a, a)).toBe(true);
      for (const b of samples) {
        expect(moneyEquals(a, b)).toBe(moneyEquals(b, a));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-function invariants
// ---------------------------------------------------------------------------

describe('parse/format round trip', () => {
  const roundTripCases: [string, string[]][] = [
    ['USD', ['0.00', '0.01', '19.99', '1234.56', '90071992547409.91']],
    ['JPY', ['0', '1', '500', '1250', '9007199254740991']],
    ['BHD', ['0.000', '0.005', '1.234', '999.999']],
  ];
  it.each(roundTripCases)('is stable for %s', (currency, texts) => {
    for (const text of texts) {
      const minorUnits = expectOk(text, currency);
      expect(formatMinorUnits(minorUnits, currency)).toBe(text);
    }
  });

  it('is purely a function of its arguments (no clock, no randomness)', () => {
    const first = parseAmountToMinorUnits('1,234.56', 'USD');
    const second = parseAmountToMinorUnits('1,234.56', 'USD');
    expect(second).toEqual(first);
    expect(formatMoney({ minorUnits: 123456, currency: 'USD' })).toBe(
      formatMoney({ minorUnits: 123456, currency: 'USD' }),
    );
  });
});
