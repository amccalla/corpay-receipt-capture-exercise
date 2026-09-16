/**
 * The picker offers exactly what the parser accepts.
 *
 * A picker listing a code that `exponentFor` would throw on is a crash waiting
 * for a user to find it — and the reverse, a supported currency missing from
 * the list, is a currency nobody can reach.
 */

import { exponentFor, isSupportedCurrency, SUPPORTED_CURRENCIES } from '../../domain/money';
import { COMMON_CURRENCIES, CURRENCY_OPTIONS, filterCurrencies } from '../currencies';

describe('currency options', () => {
  it('offers every currency the parser supports, and only those', () => {
    expect(CURRENCY_OPTIONS.map((c) => c.code).sort()).toEqual([...SUPPORTED_CURRENCIES].sort());
    for (const c of CURRENCY_OPTIONS) expect(isSupportedCurrency(c.code)).toBe(true);
  });

  it('never offers a code that would throw when its exponent is read', () => {
    // This is the assertion that would have caught a hand-maintained list
    // drifting from the parser's.
    for (const c of CURRENCY_OPTIONS) expect(() => exponentFor(c.code)).not.toThrow();
  });

  it('covers all three decimal classes, so the JPY and BHD paths are reachable', () => {
    const exps = new Set(CURRENCY_OPTIONS.map((c) => exponentFor(c.code)));
    expect(exps.has(0)).toBe(true); // JPY and friends
    expect(exps.has(2)).toBe(true);
    expect(exps.has(3)).toBe(true); // BHD and friends
  });

  it('gives every option a display name and a searchable string', () => {
    for (const c of CURRENCY_OPTIONS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.search).toContain(c.code.toLowerCase());
    }
  });

  it('surfaces only supported codes as common', () => {
    for (const code of COMMON_CURRENCIES) expect(isSupportedCurrency(code)).toBe(true);
  });
});

describe('filterCurrencies', () => {
  it('returns everything for an empty query', () => {
    expect(filterCurrencies('')).toHaveLength(CURRENCY_OPTIONS.length);
    expect(filterCurrencies('   ')).toHaveLength(CURRENCY_OPTIONS.length);
  });

  it('matches on code, case-insensitively', () => {
    expect(filterCurrencies('jpy').map((c) => c.code)).toContain('JPY');
    expect(filterCurrencies('JPY').map((c) => c.code)).toContain('JPY');
  });

  it('matches on name, so a user who does not know the code can still find it', () => {
    expect(filterCurrencies('yen').map((c) => c.code)).toContain('JPY');
    expect(filterCurrencies('pound').map((c) => c.code)).toContain('GBP');
    // OMR is deliberately absent: it is the Omani *Rial*, not a dinar. Getting
    // this wrong the first time is the point of asserting on real names.
    const dinars = filterCurrencies('dinar').map((c) => c.code);
    expect(dinars).toEqual(expect.arrayContaining(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'TND']));
    expect(dinars).not.toContain('OMR');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterCurrencies('zzzzz')).toHaveLength(0);
  });
});
