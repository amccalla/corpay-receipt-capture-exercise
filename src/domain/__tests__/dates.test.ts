/**
 * Tests for calendar-date / instant semantics.
 *
 * Two things these tests are careful about:
 *
 * 1. They use `Date.UTC` as an independent ORACLE for day arithmetic (it is
 *    timezone-free and deterministic), but the module under test never touches
 *    Date at all. Agreement between two independent implementations over
 *    ~23,000 consecutive dates is much stronger evidence than a handful of
 *    hand-picked cases.
 * 2. They assert the failure paths, because this module's whole value is
 *    refusing bad input instead of silently rolling it over.
 */

import fs from 'fs';
import path from 'path';

import {
  compareDateOnly,
  dateOnlyIsWithinDays,
  daysBetweenDateOnly,
  formatDateOnlyHuman,
  instantToDateOnlyUTC,
  isFutureDateOnly,
  isValidDateOnly,
  isValidInstant,
  makeDateOnly,
  parseDateOnly,
} from '../dates';

const MS_PER_DAY = 86_400_000;

describe('isValidDateOnly', () => {
  it('accepts well-formed real dates, including the boundaries of the format', () => {
    for (const s of ['2026-08-11', '2024-02-29', '2026-01-01', '2026-12-31', '0000-01-01', '9999-12-31']) {
      expect(isValidDateOnly(s)).toBe(true);
    }
  });

  describe('leap years', () => {
    // The point of the 1900/2000 pair: a naive `year % 4` rule gets 1900 wrong,
    // and a "% 4 except % 100" rule gets 2000 wrong. Both centuries are tested.
    it.each([
      ['2024-02-29', true, 'divisible by 4'],
      ['2025-02-29', false, 'not divisible by 4'],
      ['1900-02-29', false, 'century, not divisible by 400'],
      ['2000-02-29', true, 'divisible by 400'],
      ['2100-02-29', false, 'century, not divisible by 400'],
      ['2400-02-29', true, 'divisible by 400'],
      ['2023-02-29', false, 'not divisible by 4'],
    ])('%s -> %s (%s)', (s, expected) => {
      expect(isValidDateOnly(s)).toBe(expected);
    });
  });

  describe('month-end rollover is rejected, not absorbed', () => {
    // new Date('2026-02-30') yields March 2 rather than failing. Every one of
    // these would survive a Date-constructor "validator".
    it.each([
      '2026-02-30',
      '2026-02-31',
      '2025-02-29',
      '2026-04-31',
      '2026-06-31',
      '2026-09-31',
      '2026-11-31',
      '2026-01-32',
    ])('rejects %s', (s) => {
      expect(isValidDateOnly(s)).toBe(false);
    });

    it('accepts the genuine last day of every month in a common and a leap year', () => {
      const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      lengths.forEach((len, idx) => {
        const mm = String(idx + 1).padStart(2, '0');
        const commonLen = idx === 1 ? 28 : len;
        const leapLen = idx === 1 ? 29 : len;
        expect(isValidDateOnly(`2025-${mm}-${String(commonLen).padStart(2, '0')}`)).toBe(true);
        expect(isValidDateOnly(`2024-${mm}-${String(leapLen).padStart(2, '0')}`)).toBe(true);
        expect(isValidDateOnly(`2025-${mm}-${String(commonLen + 1).padStart(2, '0')}`)).toBe(false);
      });
    });
  });

  describe('out-of-range fields', () => {
    it.each(['2026-13-01', '2026-00-10', '2026-99-01', '2026-01-00'])('rejects %s', (s) => {
      expect(isValidDateOnly(s)).toBe(false);
    });
  });

  describe('shape violations — no trimming, no coercion, no partial credit', () => {
    // OCR and hand-typed input arrive shaped like these. Accepting any of them
    // would mean guessing at the user's intent.
    it.each([
      ['', 'empty'],
      ['2026-1-01', 'unpadded month'],
      ['2026-01-1', 'unpadded day'],
      ['26-01-01', 'two-digit year'],
      ['2026/01/01', 'wrong separator'],
      ['2026-01-01 ', 'trailing space'],
      [' 2026-01-01', 'leading space'],
      ['2026-01-01T00:00:00Z', 'an Instant, not a DateOnly'],
      ['2026-01-01x', 'trailing junk'],
      ['+2026-01-01', 'signed year'],
      ['2026-01-0a', 'non-digit'],
      ['20260101', 'no separators'],
    ])('rejects %s (%s)', (s) => {
      expect(isValidDateOnly(s)).toBe(false);
    });
  });
});

describe('isValidInstant', () => {
  it('accepts canonical UTC instants at several precisions', () => {
    for (const s of [
      '2026-08-11T14:03:22.000Z',
      '2026-08-11T14:03:22Z',
      '2026-08-11T14:03:22.123456Z',
      '2026-08-11T00:00:00.000Z',
      '2026-08-11T23:59:59.999Z',
    ]) {
      expect(isValidInstant(s)).toBe(true);
    }
  });

  it('rejects an instant whose date component is not a real day', () => {
    // The date half gets the same calendar check as a DateOnly.
    expect(isValidInstant('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(isValidInstant('2025-02-29T00:00:00.000Z')).toBe(false);
  });

  it('rejects out-of-range time fields', () => {
    expect(isValidInstant('2026-08-11T24:00:00.000Z')).toBe(false);
    expect(isValidInstant('2026-08-11T14:60:00.000Z')).toBe(false);
    // Second 60 is a valid ISO leap second but nothing in this stack can
    // represent it, so we refuse rather than round-trip it wrongly.
    expect(isValidInstant('2026-08-11T23:59:60.000Z')).toBe(false);
  });

  it('requires an explicit UTC designator', () => {
    // A naive-local or offset timestamp is not an Instant as this codebase
    // defines it; normalizing belongs at the network boundary.
    expect(isValidInstant('2026-08-11T14:03:22.000')).toBe(false);
    expect(isValidInstant('2026-08-11T14:03:22.000+02:00')).toBe(false);
    expect(isValidInstant('2026-08-11T14:03:22.000+00:00')).toBe(false);
    expect(isValidInstant('2026-08-11T14:03:22.000z')).toBe(false);
  });

  it('rejects a DateOnly and other malformed shapes', () => {
    for (const s of ['2026-08-11', '', '2026-08-11 14:03:22Z', '2026-08-11T14:03Z', '2026-08-11T14:03:22.Z']) {
      expect(isValidInstant(s)).toBe(false);
    }
  });

  it('agrees with a real toISOString() round-trip', () => {
    // Date is allowed in the TEST as an oracle; the module itself never uses it.
    const iso = new Date(Date.UTC(2026, 7, 11, 14, 3, 22, 5)).toISOString();
    expect(iso).toBe('2026-08-11T14:03:22.005Z');
    expect(isValidInstant(iso)).toBe(true);
  });
});

describe('parseDateOnly', () => {
  it('returns civil components as numbers', () => {
    expect(parseDateOnly('2026-08-09')).toEqual({ year: 2026, month: 8, day: 9 });
  });

  it('does not treat zero-padded fields as octal', () => {
    // '08' and '09' are the classic parseInt-without-radix trap.
    expect(parseDateOnly('2024-08-08')).toEqual({ year: 2024, month: 8, day: 8 });
    expect(parseDateOnly('2024-09-09')).toEqual({ year: 2024, month: 9, day: 9 });
  });

  it('is total: returns null instead of throwing on any invalid input', () => {
    // This is the function OCR output and server payloads go through, so it
    // must never throw.
    for (const s of ['2026-02-30', 'not a date', '', '2026-13-01', '2026-01-01T00:00:00Z']) {
      expect(parseDateOnly(s)).toBeNull();
    }
  });

  it('round-trips through makeDateOnly', () => {
    const s = '2024-02-29';
    const p = parseDateOnly(s);
    expect(p).not.toBeNull();
    if (p === null) throw new Error('unreachable');
    expect(makeDateOnly(p.year, p.month, p.day)).toBe(s);
  });
});

describe('makeDateOnly', () => {
  it('zero-pads every field', () => {
    expect(makeDateOnly(2026, 1, 1)).toBe('2026-01-01');
    expect(makeDateOnly(999, 12, 31)).toBe('0999-12-31');
    expect(makeDateOnly(2024, 2, 29)).toBe('2024-02-29');
  });

  it('throws rather than rolling a non-existent date over', () => {
    // The Date constructor would hand back March 2 here and no one would notice.
    expect(() => makeDateOnly(2026, 2, 30)).toThrow(RangeError);
    expect(() => makeDateOnly(2025, 2, 29)).toThrow(RangeError);
    expect(() => makeDateOnly(2026, 13, 1)).toThrow(RangeError);
    expect(() => makeDateOnly(2026, 0, 1)).toThrow(RangeError);
    expect(() => makeDateOnly(2026, 1, 0)).toThrow(RangeError);
  });

  it('throws on values the YYYY-MM-DD format cannot represent', () => {
    expect(() => makeDateOnly(10000, 1, 1)).toThrow(RangeError);
    expect(() => makeDateOnly(-1, 1, 1)).toThrow(RangeError);
  });

  it('throws on non-integers, including NaN', () => {
    expect(() => makeDateOnly(2026.5, 1, 1)).toThrow(RangeError);
    expect(() => makeDateOnly(2026, 1.5, 1)).toThrow(RangeError);
    expect(() => makeDateOnly(2026, 1, Number.NaN)).toThrow(RangeError);
  });
});

describe('compareDateOnly', () => {
  it('orders chronologically by every field', () => {
    expect(compareDateOnly('2026-01-01', '2026-01-02')).toBeLessThan(0);
    expect(compareDateOnly('2026-02-01', '2026-01-31')).toBeGreaterThan(0);
    expect(compareDateOnly('2025-12-31', '2026-01-01')).toBeLessThan(0);
    expect(compareDateOnly('2026-08-11', '2026-08-11')).toBe(0);
  });

  it('sorts a list correctly across month and year boundaries', () => {
    const input = ['2026-01-02', '2025-12-31', '2026-01-10', '2026-01-01', '2024-02-29'];
    expect([...input].sort(compareDateOnly)).toEqual([
      '2024-02-29',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-10',
    ]);
  });

  it('agrees with numeric comparison over a scan of dates (lexicographic really is chronological)', () => {
    const dates = ['1999-12-31', '2000-01-01', '2000-02-29', '2000-03-01', '2024-12-31', '2025-01-01'];
    for (const a of dates) {
      for (const b of dates) {
        const expected = Math.sign(daysBetweenDateOnly(b, a));
        expect(Math.sign(compareDateOnly(a, b))).toBe(expected);
      }
    }
  });

  it('refuses to compare unvalidated strings', () => {
    // Without this, garbage would silently get byte order and look like a date.
    expect(() => compareDateOnly('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => compareDateOnly('2026-01-01', 'yesterday')).toThrow(RangeError);
  });
});

describe('daysBetweenDateOnly', () => {
  it('is zero for the same day and signed by direction', () => {
    expect(daysBetweenDateOnly('2026-08-11', '2026-08-11')).toBe(0);
    expect(daysBetweenDateOnly('2026-08-11', '2026-08-12')).toBe(1);
    expect(daysBetweenDateOnly('2026-08-12', '2026-08-11')).toBe(-1);
  });

  it('crosses month boundaries', () => {
    expect(daysBetweenDateOnly('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetweenDateOnly('2026-04-30', '2026-05-01')).toBe(1);
    expect(daysBetweenDateOnly('2026-01-01', '2026-02-01')).toBe(31);
  });

  it('crosses year boundaries', () => {
    expect(daysBetweenDateOnly('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysBetweenDateOnly('2025-01-01', '2026-01-01')).toBe(365);
    expect(daysBetweenDateOnly('2024-01-01', '2025-01-01')).toBe(366); // 2024 is a leap year
    expect(daysBetweenDateOnly('1999-12-31', '2000-01-01')).toBe(1);
  });

  it('counts the leap day when, and only when, it exists', () => {
    expect(daysBetweenDateOnly('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetweenDateOnly('2025-02-28', '2025-03-01')).toBe(1);
    expect(daysBetweenDateOnly('1900-02-28', '1900-03-01')).toBe(1); // 1900 is not a leap year
    expect(daysBetweenDateOnly('2000-02-28', '2000-03-01')).toBe(2); // 2000 is
  });

  it('is unaffected by daylight saving transitions', () => {
    // US spring-forward is 2026-03-08 and autumn fall-back 2026-11-01. Naive
    // (t2 - t1) / 86400000 on LOCAL dates gives 1.958 and 2.042 days here, so a
    // truncating caller would report 1 and 2 respectively. Civil arithmetic
    // says 2 and 2, which is what a calendar says.
    expect(daysBetweenDateOnly('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetweenDateOnly('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('is antisymmetric and additive over a chain of dates', () => {
    const a = '2024-02-27';
    const b = '2024-03-05';
    const c = '2025-01-02';
    expect(daysBetweenDateOnly(a, b)).toBe(-daysBetweenDateOnly(b, a));
    expect(daysBetweenDateOnly(a, b) + daysBetweenDateOnly(b, c)).toBe(daysBetweenDateOnly(a, c));
  });

  it('matches Date.UTC day arithmetic for every date from 1969 through 2031', () => {
    // Independent-oracle check. Date.UTC is timezone- and DST-free, so it is a
    // fair referee for civil day counting; the module computes this without any
    // Date at all.
    const mismatches: string[] = [];
    for (let year = 1969; year <= 2031; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        for (let day = 1; day <= lastDay; day += 1) {
          const s = makeDateOnly(year, month, day);
          const expected = Date.UTC(year, month - 1, day) / MS_PER_DAY;
          const actual = daysBetweenDateOnly('1970-01-01', s);
          if (actual !== expected) mismatches.push(`${s}: got ${actual}, want ${expected}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('handles the far edges of the representable range', () => {
    // Derived independently, not read off the implementation: the Gregorian
    // cycle is 146,097 days per 400 years, years 0000-9999 are exactly 25
    // cycles (25 * 146,097 = 3,652,425 days from 0000-01-01 to 10000-01-01),
    // and 9999-12-31 is one day before that.
    expect(daysBetweenDateOnly('0000-01-01', '9999-12-31')).toBe(3_652_425 - 1);
    expect(Number.isInteger(daysBetweenDateOnly('9999-12-31', '0000-01-01'))).toBe(true);
  });

  it('throws on invalid input rather than returning NaN or 0', () => {
    // A silent 0 would make an impossible receipt date look like a perfect
    // same-day match against a card transaction.
    expect(() => daysBetweenDateOnly('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => daysBetweenDateOnly('2026-03-01', '')).toThrow(RangeError);
    expect(() => daysBetweenDateOnly('2026-03-01T00:00:00Z', '2026-03-01')).toThrow(RangeError);
  });
});

describe('dateOnlyIsWithinDays', () => {
  it('is inclusive and symmetric', () => {
    expect(dateOnlyIsWithinDays('2026-08-11', '2026-08-11', 0)).toBe(true);
    expect(dateOnlyIsWithinDays('2026-08-11', '2026-08-12', 1)).toBe(true);
    expect(dateOnlyIsWithinDays('2026-08-12', '2026-08-11', 1)).toBe(true);
    expect(dateOnlyIsWithinDays('2026-08-11', '2026-08-13', 1)).toBe(false);
    expect(dateOnlyIsWithinDays('2026-08-13', '2026-08-11', 1)).toBe(false);
  });

  it('is exact at the window boundary', () => {
    // Off-by-one here would widen a matching window and pull an extra candidate
    // transaction into an ambiguous match.
    expect(dateOnlyIsWithinDays('2026-08-11', '2026-08-14', 3)).toBe(true);
    expect(dateOnlyIsWithinDays('2026-08-11', '2026-08-15', 3)).toBe(false);
  });

  it('works across month and year boundaries', () => {
    expect(dateOnlyIsWithinDays('2025-12-31', '2026-01-02', 2)).toBe(true);
    expect(dateOnlyIsWithinDays('2024-02-28', '2024-03-01', 2)).toBe(true);
    expect(dateOnlyIsWithinDays('2025-02-28', '2025-03-01', 1)).toBe(true);
  });

  it('rejects a meaningless window', () => {
    expect(() => dateOnlyIsWithinDays('2026-08-11', '2026-08-11', -1)).toThrow(RangeError);
    expect(() => dateOnlyIsWithinDays('2026-08-11', '2026-08-11', 1.5)).toThrow(RangeError);
    expect(() => dateOnlyIsWithinDays('2026-08-11', '2026-08-11', Number.NaN)).toThrow(RangeError);
  });

  it('still validates its dates', () => {
    expect(() => dateOnlyIsWithinDays('2025-02-29', '2025-03-01', 3)).toThrow(RangeError);
  });
});

describe('instantToDateOnlyUTC', () => {
  it('extracts the UTC calendar day', () => {
    expect(instantToDateOnlyUTC('2026-08-11T14:03:22.000Z')).toBe('2026-08-11');
    expect(instantToDateOnlyUTC('2026-08-11T00:00:00.000Z')).toBe('2026-08-11');
    expect(instantToDateOnlyUTC('2026-08-11T23:59:59.999Z')).toBe('2026-08-11');
    expect(instantToDateOnlyUTC('2026-08-12T00:00:00.000Z')).toBe('2026-08-12');
  });

  it('is demonstrably lossy: the same moment is a different calendar day elsewhere', () => {
    // 2026-08-12T01:30Z is still 2026-08-11 at UTC-5 and already 2026-08-12 at
    // UTC+9. This function commits to the UTC observer and throws the rest
    // away, which is exactly why it must never produce a transactionDate.
    const nearMidnight = '2026-08-12T01:30:00.000Z';
    expect(instantToDateOnlyUTC(nearMidnight)).toBe('2026-08-12');
    const localNewYorkCalendarDay = '2026-08-11';
    expect(instantToDateOnlyUTC(nearMidnight)).not.toBe(localNewYorkCalendarDay);
    // And the time of day is gone: two distinct instants collapse to one value.
    expect(instantToDateOnlyUTC('2026-08-12T01:30:00.000Z')).toBe(
      instantToDateOnlyUTC('2026-08-12T22:45:10.123Z'),
    );
  });

  it('is documented as lossy, loudly, at its definition', () => {
    // The brief asks for explicit semantics. A caller reaching for this
    // function must be warned in the source they hover, not only in a README,
    // so the warning itself is part of the contract and is asserted here.
    const source = fs.readFileSync(path.join(__dirname, '..', 'dates.ts'), 'utf8');
    const docStart = source.indexOf('export function instantToDateOnlyUTC');
    expect(docStart).toBeGreaterThan(-1);
    const doc = source.slice(0, docStart);
    expect(doc).toContain('LOSSY');
    expect(doc).toContain('NEVER USE IT FOR');
    expect(doc).toContain('transactionDate');
  });

  it('throws on anything that is not a canonical UTC instant', () => {
    expect(() => instantToDateOnlyUTC('2026-08-11')).toThrow(RangeError);
    expect(() => instantToDateOnlyUTC('2026-08-11T14:03:22.000+02:00')).toThrow(RangeError);
    expect(() => instantToDateOnlyUTC('2026-02-30T00:00:00.000Z')).toThrow(RangeError);
    expect(() => instantToDateOnlyUTC('')).toThrow(RangeError);
  });

  it('always produces a valid DateOnly', () => {
    expect(isValidDateOnly(instantToDateOnlyUTC('2024-02-29T12:00:00.000Z'))).toBe(true);
  });
});

describe('formatDateOnlyHuman', () => {
  it('renders day-first with a named month', () => {
    expect(formatDateOnlyHuman('2026-08-11')).toBe('11 Aug 2026');
    expect(formatDateOnlyHuman('2024-02-29')).toBe('29 Feb 2024');
  });

  it('does not zero-pad the day', () => {
    expect(formatDateOnlyHuman('2026-01-01')).toBe('1 Jan 2026');
    expect(formatDateOnlyHuman('2026-12-09')).toBe('9 Dec 2026');
  });

  it('names all twelve months', () => {
    const expected = [
      '1 Jan 2026',
      '1 Feb 2026',
      '1 Mar 2026',
      '1 Apr 2026',
      '1 May 2026',
      '1 Jun 2026',
      '1 Jul 2026',
      '1 Aug 2026',
      '1 Sep 2026',
      '1 Oct 2026',
      '1 Nov 2026',
      '1 Dec 2026',
    ];
    const actual = expected.map((_, i) => formatDateOnlyHuman(makeDateOnly(2026, i + 1, 1)));
    expect(actual).toEqual(expected);
  });

  it('is locale- and timezone-independent by construction', () => {
    // No Intl and no Date means process.env.TZ cannot change the output; the
    // same string appears in the UI, in an export and in CI.
    const before = formatDateOnlyHuman('2026-08-11');
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      expect(formatDateOnlyHuman('2026-08-11')).toBe(before);
      process.env.TZ = 'Pacific/Niue'; // UTC-11
      expect(formatDateOnlyHuman('2026-08-11')).toBe(before);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('throws on an invalid date rather than rendering "NaN undefined"', () => {
    expect(() => formatDateOnlyHuman('2026-02-30')).toThrow(RangeError);
    expect(() => formatDateOnlyHuman('')).toThrow(RangeError);
  });
});

describe('isFutureDateOnly', () => {
  const today = '2026-08-11';

  it('is strict: today is not the future', () => {
    expect(isFutureDateOnly(today, today)).toBe(false);
  });

  it('detects tomorrow and later', () => {
    expect(isFutureDateOnly('2026-08-12', today)).toBe(true);
    expect(isFutureDateOnly('2027-01-01', today)).toBe(true);
  });

  it('treats the past as not future, across boundaries', () => {
    expect(isFutureDateOnly('2026-08-10', today)).toBe(false);
    expect(isFutureDateOnly('2025-12-31', '2026-01-01')).toBe(false);
    expect(isFutureDateOnly('2024-02-29', today)).toBe(false);
  });

  it('takes "today" as a parameter, so it is deterministic and clock-free', () => {
    // A receipt captured in UTC+13 can legitimately look future-dated against a
    // UTC today; the caller owns that policy, which is only possible because
    // this predicate never reads a clock.
    const receiptDate = '2026-08-12';
    expect(isFutureDateOnly(receiptDate, '2026-08-11')).toBe(true);
    expect(isFutureDateOnly(receiptDate, '2026-08-12')).toBe(false);
    // One day of slack, the usual validation policy, is expressible on top.
    expect(dateOnlyIsWithinDays(receiptDate, '2026-08-11', 1)).toBe(true);
  });

  it('validates both arguments', () => {
    expect(() => isFutureDateOnly('2026-02-30', today)).toThrow(RangeError);
    expect(() => isFutureDateOnly(today, 'today')).toThrow(RangeError);
  });
});
