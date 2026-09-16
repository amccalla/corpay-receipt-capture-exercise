/**
 * Tests for the extraction merge.
 *
 * The headline case is the brief's edge case 5 - a late OCR result arriving
 * after the user corrected the receipt - so the suite is built around proving a
 * NEGATIVE: that certain merges change nothing at all. A test that only checks
 * the happy path would pass against an implementation that ignores provenance
 * entirely, so the precedence grid below is asserted against ORIGIN_PRECEDENCE
 * itself rather than against 16 hand-written expectations that could drift away
 * from the table they are supposed to mirror.
 */

import {
  mergeExtraction,
  type ExtractionInput,
  type MergeFieldOutcome,
} from '../extraction';
import {
  EMPTY_PROVENANCE,
  ORIGIN_PRECEDENCE,
  originMayOverwrite,
  type FieldOrigin,
  type FieldProvenance,
  type ReceiptDraft,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-08-12T09:15:00.000Z';
const CREATED = '2026-08-11T18:00:00.000Z';

const ALL_ORIGINS: readonly FieldOrigin[] = ['empty', 'ocr', 'barcode', 'user'];

const BASE_DRAFT: ReceiptDraft = {
  localId: 'r-local-1',
  companyId: 'co-acme',
  fileUri: 'file:///sandbox/receipts/r1.jpg',
  fileName: 'r1.jpg',
  fileMimeType: 'image/jpeg',
  fileSizeBytes: 204_800,
  vendor: null,
  amountMinorUnits: null,
  currency: null,
  transactionDate: null,
  notes: null,
  state: 'draft',
  idempotencyKey: 'idem-aaaa-1111',
  serverReceiptId: null,
  matchedTransactionId: null,
  pendingMatchTransactionId: null,
  provenance: EMPTY_PROVENANCE,
  lastError: null,
  lastErrorRetryable: false,
  attemptCount: 0,
  createdAt: CREATED,
  updatedAt: CREATED,
  lastServerSyncAt: null,
};

/** Provenance with the same origin in every slot. */
function uniformProvenance(origin: FieldOrigin): FieldProvenance {
  return { vendor: origin, amount: origin, currency: origin, transactionDate: origin };
}

function draftWith(overrides: Partial<ReceiptDraft>): ReceiptDraft {
  return { ...BASE_DRAFT, ...overrides };
}

const NOTHING_OFFERED: ExtractionInput = {
  vendor: null,
  amountMinorUnits: null,
  currency: null,
  transactionDate: null,
};

function offering(overrides: Partial<ExtractionInput>): ExtractionInput {
  return { ...NOTHING_OFFERED, ...overrides };
}

/** A complete, valid reading. Every value differs from FILLED_DRAFT's. */
const FULL_READING: ExtractionInput = {
  vendor: 'Rivera Hardware',
  amountMinorUnits: 2400,
  currency: 'EUR',
  transactionDate: '2026-08-13',
};

/** A draft holding a complete, valid, DIFFERENT set of values. */
const FILLED_DRAFT: ReceiptDraft = draftWith({
  vendor: 'Blue Bottle Coffee',
  amountMinorUnits: 1899,
  currency: 'USD',
  transactionDate: '2026-08-11',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outcomeFor(outcomes: readonly MergeFieldOutcome[], field: string): MergeFieldOutcome {
  const found = outcomes.find((o) => o.field === field);
  if (found === undefined) throw new Error(`no outcome emitted for '${field}'`);
  return found;
}

function applied(outcomes: readonly MergeFieldOutcome[], field: string): boolean {
  return outcomeFor(outcomes, field).applied;
}

/**
 * Names of the top-level draft keys whose value changed.
 *
 * Deliberately computed from Object.keys rather than compared field by field:
 * the point of the "must not touch" assertions is that a future field added to
 * ReceiptDraft is protected automatically, which a hand-maintained list cannot
 * promise. `provenance` is the only object-valued field, and both sides build
 * it with the same key order, so JSON comparison is exact here.
 */
function keyDiff(before: ReceiptDraft, after: ReceiptDraft): readonly string[] {
  const a: Record<string, unknown> = { ...before };
  const b: Record<string, unknown> = { ...after };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** Fields an extraction merge is ever allowed to alter. */
const WRITABLE_KEYS: readonly string[] = [
  'amountMinorUnits',
  'currency',
  'provenance',
  'transactionDate',
  'updatedAt',
  'vendor',
];

function deepFreeze(draft: ReceiptDraft): ReceiptDraft {
  Object.freeze(draft.provenance);
  return Object.freeze(draft);
}

// ---------------------------------------------------------------------------
// The precedence grid - 4x4, asserted against ORIGIN_PRECEDENCE
// ---------------------------------------------------------------------------

describe('precedence grid (current origin x incoming origin)', () => {
  const grid = ALL_ORIGINS.flatMap((current) =>
    ALL_ORIGINS.map((incoming) => ({ current, incoming })),
  );

  it('covers all sixteen pairs', () => {
    expect(grid).toHaveLength(16);
    expect(Object.keys(ORIGIN_PRECEDENCE).sort()).toEqual([...ALL_ORIGINS].sort());
  });

  it.each(grid)(
    'current=$current incoming=$incoming writes every field iff originMayOverwrite says so',
    ({ current, incoming }) => {
      const draft = draftWith({ ...FILLED_DRAFT, provenance: uniformProvenance(current) });
      const mayWrite = originMayOverwrite(current, incoming);

      const result = mergeExtraction(draft, FULL_READING, incoming, NOW);

      expect(result.changed).toBe(mayWrite);
      for (const field of ['vendor', 'amount', 'currency', 'transactionDate']) {
        expect(applied(result.outcomes, field)).toBe(mayWrite);
      }

      // And the values follow the outcomes, in both directions.
      expect(result.draft.vendor).toBe(mayWrite ? 'Rivera Hardware' : 'Blue Bottle Coffee');
      expect(result.draft.amountMinorUnits).toBe(mayWrite ? 2400 : 1899);
      expect(result.draft.currency).toBe(mayWrite ? 'EUR' : 'USD');
      expect(result.draft.transactionDate).toBe(mayWrite ? '2026-08-13' : '2026-08-11');
      expect(result.draft.provenance).toEqual(uniformProvenance(mayWrite ? incoming : current));
    },
  );

  it.each(grid)(
    'current=$current incoming=$incoming agrees with the numeric ranking in ORIGIN_PRECEDENCE',
    ({ current, incoming }) => {
      const draft = draftWith({ ...FILLED_DRAFT, provenance: uniformProvenance(current) });
      const strictlyHigher = ORIGIN_PRECEDENCE[incoming] > ORIGIN_PRECEDENCE[current];

      expect(mergeExtraction(draft, FULL_READING, incoming, NOW).changed).toBe(strictlyHigher);
    },
  );

  it('reports from/to on an applied field and heldBy on a refused one', () => {
    const draft = draftWith({ ...FILLED_DRAFT, provenance: uniformProvenance('ocr') });

    const upgrade = outcomeFor(mergeExtraction(draft, FULL_READING, 'barcode', NOW).outcomes, 'vendor');
    expect(upgrade).toEqual({
      field: 'vendor',
      applied: true,
      from: 'ocr',
      to: 'barcode',
      value: 'Rivera Hardware',
    });

    const blocked = outcomeFor(
      mergeExtraction(
        draftWith({ ...FILLED_DRAFT, provenance: uniformProvenance('user') }),
        FULL_READING,
        'ocr',
        NOW,
      ).outcomes,
      'vendor',
    );
    expect(blocked).toEqual({
      field: 'vendor',
      applied: false,
      reason: 'HELD_BY_HIGHER_PRECEDENCE',
      heldBy: 'user',
    });
  });
});

// ---------------------------------------------------------------------------
// Edge case 5: the late OCR result
// ---------------------------------------------------------------------------

describe("brief edge case 5: OCR returns after the user corrected the receipt", () => {
  /** The user opened the draft and fixed the vendor and the amount by hand. */
  const CORRECTED: ReceiptDraft = draftWith({
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: 1899,
    currency: 'USD',
    transactionDate: '2026-08-11',
    provenance: uniformProvenance('user'),
    updatedAt: '2026-08-11T19:30:00.000Z',
  });

  /** ...and then the OCR job finishes, with a complete and plausible reading. */
  const LATE_OCR: ExtractionInput = {
    vendor: 'BLUEBOTTLE COFFEE #221',
    amountMinorUnits: 189_900,
    currency: 'JPY',
    transactionDate: '2026-08-09',
  };

  it('changes NOTHING - not a value, not a provenance slot, not updatedAt', () => {
    const result = mergeExtraction(CORRECTED, LATE_OCR, 'ocr', NOW);

    expect(result.changed).toBe(false);
    // Same object identity: a refused merge cannot have produced a new draft,
    // so the caller can skip the persist on a reference check alone.
    expect(result.draft).toBe(CORRECTED);
    expect(keyDiff(CORRECTED, result.draft)).toEqual([]);
    expect(result.draft.updatedAt).toBe('2026-08-11T19:30:00.000Z');
  });

  it('explains itself: every field refused, held by the user', () => {
    const result = mergeExtraction(CORRECTED, LATE_OCR, 'ocr', NOW);

    expect(result.outcomes).toHaveLength(4);
    for (const outcome of result.outcomes) {
      expect(outcome).toEqual({
        field: outcome.field,
        applied: false,
        reason: 'HELD_BY_HIGHER_PRECEDENCE',
        heldBy: 'user',
      });
    }
  });

  it('holds even when only SOME fields were corrected', () => {
    // The user fixed the vendor and the money; the date is still OCR's.
    const partly = draftWith({
      ...CORRECTED,
      transactionDate: '2026-08-11',
      provenance: {
        vendor: 'user',
        amount: 'user',
        currency: 'user',
        transactionDate: 'ocr',
      },
    });

    const result = mergeExtraction(partly, LATE_OCR, 'ocr', NOW);

    // A same-origin re-read cannot overwrite even its own earlier work, so the
    // date is untouched too, and the correction is certainly untouched.
    expect(result.changed).toBe(false);
    expect(result.draft.vendor).toBe('Blue Bottle Coffee');
    expect(result.draft.amountMinorUnits).toBe(1899);
  });

  it('lets a barcode upgrade an OCR field while still refusing the user fields', () => {
    const mixed = draftWith({
      vendor: 'Blue Bottle Coffee',
      amountMinorUnits: 1899,
      currency: 'USD',
      transactionDate: '2026-08-09',
      provenance: {
        vendor: 'user',
        amount: 'user',
        currency: 'user',
        transactionDate: 'ocr',
      },
    });

    const result = mergeExtraction(
      mixed,
      offering({ vendor: 'Rivera Hardware', transactionDate: '2026-08-10' }),
      'barcode',
      NOW,
    );

    expect(result.changed).toBe(true);
    expect(result.draft.transactionDate).toBe('2026-08-10');
    expect(result.draft.provenance.transactionDate).toBe('barcode');
    // The human's vendor survives a barcode too - 'user' outranks everything.
    expect(result.draft.vendor).toBe('Blue Bottle Coffee');
    expect(result.draft.provenance.vendor).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// barcode over ocr
// ---------------------------------------------------------------------------

describe('barcode outranks ocr', () => {
  const OCR_FILLED: ReceiptDraft = draftWith({
    ...FILLED_DRAFT,
    provenance: uniformProvenance('ocr'),
  });

  it('upgrades every field an OCR pass had written', () => {
    const result = mergeExtraction(OCR_FILLED, FULL_READING, 'barcode', NOW);

    expect(result.changed).toBe(true);
    expect(result.draft.vendor).toBe('Rivera Hardware');
    expect(result.draft.amountMinorUnits).toBe(2400);
    expect(result.draft.currency).toBe('EUR');
    expect(result.draft.transactionDate).toBe('2026-08-13');
    expect(result.draft.provenance).toEqual(uniformProvenance('barcode'));
    expect(result.draft.updatedAt).toBe(NOW);
  });

  it('is not reversible: the later ocr pass cannot take the fields back', () => {
    const upgraded = mergeExtraction(OCR_FILLED, FULL_READING, 'barcode', NOW).draft;

    const second = mergeExtraction(
      upgraded,
      offering({
        vendor: 'Corner Newsstand',
        amountMinorUnits: 500,
        currency: 'USD',
        transactionDate: '2026-08-01',
      }),
      'ocr',
      '2026-08-12T10:00:00.000Z',
    );

    expect(second.changed).toBe(false);
    expect(second.draft).toBe(upgraded);
  });

  it('upgrades provenance even when the value it confirms is identical', () => {
    // A barcode that agrees with OCR still MEANS something: it locks the field
    // against any later OCR pass, so this is a real change and must be written.
    const draft = draftWith({
      currency: 'USD',
      provenance: { ...EMPTY_PROVENANCE, currency: 'ocr' },
    });

    const result = mergeExtraction(draft, offering({ currency: 'USD' }), 'barcode', NOW);

    expect(result.changed).toBe(true);
    expect(result.draft.currency).toBe('USD');
    expect(result.draft.provenance.currency).toBe('barcode');
    expect(outcomeFor(result.outcomes, 'currency')).toEqual({
      field: 'currency',
      applied: true,
      from: 'ocr',
      to: 'barcode',
      value: 'USD',
    });
  });
});

// ---------------------------------------------------------------------------
// Validation - an extractor's output shape is a promise, not a fact
// ---------------------------------------------------------------------------

describe('validation', () => {
  const EMPTY_DRAFT = BASE_DRAFT; // every slot 'empty', so precedence never blocks

  it.each([
    ['blank', ''],
    ['whitespace only', '   \t\n '],
    ['control characters', 'ACME\x00CORP'],
    ['a bidi override that spoofs the rendered name', 'ACME‮CORP'],
    ['a page of OCR noise', 'A'.repeat(201)],
  ])('refuses a vendor that is %s', (_label, vendor) => {
    const result = mergeExtraction(EMPTY_DRAFT, offering({ vendor }), 'ocr', NOW);

    expect(outcomeFor(result.outcomes, 'vendor')).toEqual({
      field: 'vendor',
      applied: false,
      reason: 'INVALID_VALUE',
      heldBy: 'empty',
    });
    expect(result.changed).toBe(false);
    expect(result.draft.vendor).toBeNull();
    expect(result.draft.provenance.vendor).toBe('empty');
  });

  it('trims a vendor before storing it, but does not otherwise rewrite it', () => {
    const result = mergeExtraction(
      EMPTY_DRAFT,
      offering({ vendor: '  Blue  Bottle Coffee #221  ' }),
      'ocr',
      NOW,
    );

    expect(result.draft.vendor).toBe('Blue  Bottle Coffee #221');
  });

  it.each([
    ['a non-existent calendar day', '2026-02-30'],
    ['a non-leap 29 February', '2025-02-29'],
    ['a US-style date', '08/11/2026'],
    ['an instant', '2026-08-11T18:00:00.000Z'],
    ['a value needing a trim', ' 2026-08-11 '],
    ['a loose shape', '2026-8-1'],
    ['free text', 'yesterday'],
  ])('refuses a transactionDate that is %s', (_label, transactionDate) => {
    const result = mergeExtraction(EMPTY_DRAFT, offering({ transactionDate }), 'ocr', NOW);

    expect(outcomeFor(result.outcomes, 'transactionDate')).toEqual({
      field: 'transactionDate',
      applied: false,
      reason: 'INVALID_VALUE',
      heldBy: 'empty',
    });
    expect(result.draft.transactionDate).toBeNull();
  });

  it.each([
    ['a lowercase code', 'usd'],
    ['a padded code', ' USD'],
    ['a made-up code', 'XYZ'],
    ['a currency name', 'EURO'],
    ['an empty string', ''],
    ['a symbol', '$'],
  ])('refuses a currency that is %s', (_label, currency) => {
    const result = mergeExtraction(
      EMPTY_DRAFT,
      offering({ currency, amountMinorUnits: 1899 }),
      'ocr',
      NOW,
    );

    expect(outcomeFor(result.outcomes, 'currency')).toEqual({
      field: 'currency',
      applied: false,
      reason: 'INVALID_VALUE',
      heldBy: 'empty',
    });
    // ...and the amount goes down with it: minor units without a code are not
    // money, so there is nothing safe to store.
    expect(outcomeFor(result.outcomes, 'amount')).toEqual({
      field: 'amount',
      applied: false,
      reason: 'INVALID_VALUE',
      heldBy: 'empty',
    });
    expect(result.changed).toBe(false);
    expect(result.draft.amountMinorUnits).toBeNull();
    expect(result.draft.currency).toBeNull();
  });

  it.each([
    ['negative', -1],
    ['a float that leaked in', 19.99],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('refuses an amount that is %s', (_label, amountMinorUnits) => {
    const result = mergeExtraction(
      EMPTY_DRAFT,
      offering({ amountMinorUnits, currency: 'USD' }),
      'ocr',
      NOW,
    );

    expect(outcomeFor(result.outcomes, 'amount')).toEqual({
      field: 'amount',
      applied: false,
      reason: 'INVALID_VALUE',
      heldBy: 'empty',
    });
    expect(result.draft.amountMinorUnits).toBeNull();
    expect(result.draft.provenance.amount).toBe('empty');
  });

  it('accepts a zero amount - a fully discounted line is a real receipt', () => {
    const result = mergeExtraction(
      EMPTY_DRAFT,
      offering({ amountMinorUnits: 0, currency: 'USD' }),
      'ocr',
      NOW,
    );

    expect(result.draft.amountMinorUnits).toBe(0);
    expect(result.draft.currency).toBe('USD');
  });

  it('refuses one field without disturbing the fields that are fine', () => {
    const result = mergeExtraction(
      EMPTY_DRAFT,
      offering({
        vendor: 'Rivera Hardware',
        amountMinorUnits: -5,
        currency: 'USD',
        transactionDate: 'nonsense',
      }),
      'ocr',
      NOW,
    );

    expect(result.changed).toBe(true);
    expect(result.draft.vendor).toBe('Rivera Hardware');
    expect(result.draft.provenance.vendor).toBe('ocr');
    // The junk amount is refused and the junk date is refused, while the two
    // legible fields land. The currency lands even though its amount did not:
    // the draft holds no amount, so there is no number for a code to
    // re-denominate, and rule B is about re-denomination rather than about
    // punishing a half-legible reading.
    expect(result.draft.amountMinorUnits).toBeNull();
    expect(result.draft.currency).toBe('USD');
    expect(result.draft.transactionDate).toBeNull();
    expect(result.draft.provenance).toEqual({
      ...EMPTY_PROVENANCE,
      vendor: 'ocr',
      currency: 'ocr',
    });
  });

  it('leaves a refused field claimable by the next pass at the same rank', () => {
    // The consequence that makes the partial write above safe: a refusal never
    // burns the slot. Only the fields that actually landed had their origin
    // raised, so the amount is still 'empty' and a second OCR pass - which can
    // no longer touch the currency it already wrote - can still supply it.
    const first = mergeExtraction(
      EMPTY_DRAFT,
      offering({ amountMinorUnits: -5, currency: 'USD' }),
      'ocr',
      NOW,
    );
    expect(first.draft.provenance.amount).toBe('empty');

    const second = mergeExtraction(
      first.draft,
      offering({ amountMinorUnits: 1899, currency: 'USD' }),
      'ocr',
      '2026-08-12T11:00:00.000Z',
    );

    expect(second.changed).toBe(true);
    expect(second.draft.amountMinorUnits).toBe(1899);
    expect(second.draft.currency).toBe('USD');
    expect(second.draft.provenance.amount).toBe('ocr');
  });

  it('never applies a field it did not offer', () => {
    const result = mergeExtraction(FILLED_DRAFT, NOTHING_OFFERED, 'barcode', NOW);

    expect(result.changed).toBe(false);
    expect(result.draft).toBe(FILLED_DRAFT);
    for (const outcome of result.outcomes) {
      expect(outcome).toEqual({
        field: outcome.field,
        applied: false,
        reason: 'NO_VALUE_OFFERED',
        heldBy: 'empty',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// MONEY IS ATOMIC - the 100x bug class
// ---------------------------------------------------------------------------

describe('amount and currency move together', () => {
  it('refuses a bare amount with no currency, even when the draft holds one', () => {
    // extractFromReceipt drops the currency independently of the amount, and
    // reading the total under the code that happens to already be on the draft
    // is exactly the assumption that turns 2400 yen into 24 dollars.
    const draft = draftWith({
      currency: 'USD',
      provenance: { ...EMPTY_PROVENANCE, currency: 'ocr' },
    });

    const result = mergeExtraction(draft, offering({ amountMinorUnits: 2400 }), 'barcode', NOW);

    expect(result.changed).toBe(false);
    expect(outcomeFor(result.outcomes, 'amount')).toEqual({
      field: 'amount',
      applied: false,
      reason: 'INVALID_VALUE',
      heldBy: 'empty',
    });
    expect(result.draft.amountMinorUnits).toBeNull();
  });

  it('refuses an amount read in a currency a higher-precedence source will not give up', () => {
    // OCR read 'EUR 24.00'. The user has already declared this receipt USD.
    // Storing 2400 would make it 24.00 USD - a different amount of money.
    const draft = draftWith({
      currency: 'USD',
      provenance: { ...EMPTY_PROVENANCE, currency: 'user' },
    });

    const result = mergeExtraction(
      draft,
      offering({ amountMinorUnits: 2400, currency: 'EUR' }),
      'ocr',
      NOW,
    );

    expect(result.changed).toBe(false);
    expect(outcomeFor(result.outcomes, 'amount')).toEqual({
      field: 'amount',
      applied: false,
      reason: 'HELD_BY_HIGHER_PRECEDENCE',
      heldBy: 'user',
    });
    expect(outcomeFor(result.outcomes, 'currency')).toEqual({
      field: 'currency',
      applied: false,
      reason: 'HELD_BY_HIGHER_PRECEDENCE',
      heldBy: 'user',
    });
    expect(result.draft.amountMinorUnits).toBeNull();
  });

  it('accepts an amount alone when it was read in the currency already held', () => {
    // The relaxation: the code is not changing, so nothing is re-denominated.
    const draft = draftWith({
      currency: 'USD',
      provenance: { ...EMPTY_PROVENANCE, currency: 'user' },
    });

    const result = mergeExtraction(
      draft,
      offering({ amountMinorUnits: 1899, currency: 'USD' }),
      'ocr',
      NOW,
    );

    expect(result.changed).toBe(true);
    expect(result.draft.amountMinorUnits).toBe(1899);
    expect(result.draft.currency).toBe('USD');
    expect(result.draft.provenance.amount).toBe('ocr');
    // The currency slot stays with the user: OCR never got to write it.
    expect(result.draft.provenance.currency).toBe('user');
    expect(outcomeFor(result.outcomes, 'currency')).toEqual({
      field: 'currency',
      applied: false,
      reason: 'HELD_BY_HIGHER_PRECEDENCE',
      heldBy: 'user',
    });
  });

  it('refuses a currency that would re-denominate an amount it did not read', () => {
    // The sharp case, and the one a naive per-field precedence check gets
    // wrong: barcode OUTRANKS ocr, so it may write the currency slot - but it
    // did not read the total, and flipping USD to JPY under an OCR'd 2400
    // silently turns 24.00 USD into 2400 JPY.
    const draft = draftWith({
      amountMinorUnits: 2400,
      currency: 'USD',
      provenance: { ...EMPTY_PROVENANCE, amount: 'ocr', currency: 'ocr' },
    });

    const result = mergeExtraction(draft, offering({ currency: 'JPY' }), 'barcode', NOW);

    expect(result.changed).toBe(false);
    expect(outcomeFor(result.outcomes, 'currency')).toEqual({
      field: 'currency',
      applied: false,
      reason: 'HELD_BY_HIGHER_PRECEDENCE',
      heldBy: 'ocr',
    });
    expect(result.draft.currency).toBe('USD');
    expect(result.draft.amountMinorUnits).toBe(2400);
  });

  it('refuses a currency that would put a code under a number the user typed', () => {
    // The user entered a total but never picked a currency. OCR deciding it is
    // yen changes what their number means; only they can answer that.
    const draft = draftWith({
      amountMinorUnits: 2400,
      provenance: { ...EMPTY_PROVENANCE, amount: 'user' },
    });

    const result = mergeExtraction(draft, offering({ currency: 'JPY' }), 'ocr', NOW);

    expect(result.changed).toBe(false);
    expect(outcomeFor(result.outcomes, 'currency')).toEqual({
      field: 'currency',
      applied: false,
      reason: 'HELD_BY_HIGHER_PRECEDENCE',
      heldBy: 'user',
    });
    expect(result.draft.currency).toBeNull();
  });

  it('accepts a currency alone when there is no amount to re-denominate', () => {
    const result = mergeExtraction(BASE_DRAFT, offering({ currency: 'JPY' }), 'ocr', NOW);

    expect(result.changed).toBe(true);
    expect(result.draft.currency).toBe('JPY');
    expect(result.draft.amountMinorUnits).toBeNull();
    expect(result.draft.provenance).toEqual({ ...EMPTY_PROVENANCE, currency: 'ocr' });
  });

  it('re-denominates happily when the same merge supplies both halves', () => {
    const draft = draftWith({
      amountMinorUnits: 2400,
      currency: 'USD',
      provenance: { ...EMPTY_PROVENANCE, amount: 'ocr', currency: 'ocr' },
    });

    // A fiscal barcode carrying BOTH the total and the code: it read the money,
    // so it may replace the money.
    const result = mergeExtraction(
      draft,
      offering({ amountMinorUnits: 2400, currency: 'JPY' }),
      'barcode',
      NOW,
    );

    expect(result.changed).toBe(true);
    expect(result.draft.amountMinorUnits).toBe(2400);
    expect(result.draft.currency).toBe('JPY');
    expect(result.draft.provenance.amount).toBe('barcode');
    expect(result.draft.provenance.currency).toBe('barcode');
  });

  it('never applies exactly one half of the money value', () => {
    // Exhaustive: every shape an extractor can produce for the pair, against a
    // draft holding money whose two slots are owned INDEPENDENTLY. The mixed
    // ownership is the point - a per-field precedence check passes a uniform
    // grid and still lets an amount land under someone else's currency code.
    const halves = [
      { amountMinorUnits: null, currency: null },
      { amountMinorUnits: 2400, currency: null },
      { amountMinorUnits: null, currency: 'JPY' },
      { amountMinorUnits: 2400, currency: 'JPY' },
      { amountMinorUnits: 2400, currency: 'USD' },
      { amountMinorUnits: 2400, currency: 'nonsense' },
      { amountMinorUnits: -1, currency: 'JPY' },
    ];

    let sawAmountLandAlone = false;
    let sawCurrencyLandAlone = false;

    for (const amountOrigin of ALL_ORIGINS) {
      for (const currencyOrigin of ALL_ORIGINS) {
        for (const incoming of ALL_ORIGINS) {
          for (const half of halves) {
            const draft = draftWith({
              amountMinorUnits: 1899,
              currency: 'USD',
              provenance: { ...EMPTY_PROVENANCE, amount: amountOrigin, currency: currencyOrigin },
            });
            const result = mergeExtraction(draft, offering(half), incoming, NOW);
            const context = `${amountOrigin}/${currencyOrigin} <- ${incoming} ${JSON.stringify(half)}`;

            const amountApplied = applied(result.outcomes, 'amount');
            const currencyApplied = applied(result.outcomes, 'currency');

            // THE invariant: a stored amount always sits under the currency it
            // was actually read in. Never the draft's old code, never a guess.
            if (amountApplied) {
              expect(`${context}: ${String(result.draft.currency)}`).toBe(
                `${context}: ${String(half.currency)}`,
              );
            }
            // A currency may only land alone when it leaves the number already
            // stored meaning exactly what it meant before.
            if (currencyApplied && !amountApplied) {
              expect(`${context}: ${String(result.draft.currency)}`).toBe(`${context}: USD`);
              expect(result.draft.amountMinorUnits).toBe(1899);
            }
            // Neither half ever leaves the draft holding an uninterpretable
            // number.
            if (result.draft.amountMinorUnits !== null) {
              expect(result.draft.currency).not.toBeNull();
            }

            sawAmountLandAlone = sawAmountLandAlone || (amountApplied && !currencyApplied);
            sawCurrencyLandAlone = sawCurrencyLandAlone || (currencyApplied && !amountApplied);
          }
        }
      }
    }

    // Guard against the invariants above passing vacuously: both single-half
    // writes really do occur in the grid, and both are the safe kind.
    expect(sawAmountLandAlone).toBe(true);
    expect(sawCurrencyLandAlone).toBe(true);
  });

  it('renders an applied amount through money.ts, with its code attached', () => {
    const usd = mergeExtraction(
      BASE_DRAFT,
      offering({ amountMinorUnits: 1899, currency: 'USD' }),
      'ocr',
      NOW,
    );
    expect(outcomeFor(usd.outcomes, 'amount')).toEqual({
      field: 'amount',
      applied: true,
      from: 'empty',
      to: 'ocr',
      value: 'USD 18.99',
    });

    // Zero-decimal currency: 2400 minor units is 2400 yen, not 24.00.
    const jpy = mergeExtraction(
      BASE_DRAFT,
      offering({ amountMinorUnits: 2400, currency: 'JPY' }),
      'ocr',
      NOW,
    );
    expect(outcomeFor(jpy.outcomes, 'amount')).toEqual({
      field: 'amount',
      applied: true,
      from: 'empty',
      to: 'ocr',
      value: 'JPY 2400',
    });
  });
});

// ---------------------------------------------------------------------------
// What the merge may and may not touch
// ---------------------------------------------------------------------------

describe('blast radius', () => {
  it('changes only the extractable fields, provenance and updatedAt', () => {
    const before = draftWith({
      state: 'needsReview',
      serverReceiptId: 'srv-9',
      matchedTransactionId: 'txn-1',
      pendingMatchTransactionId: 'txn-2',
      attemptCount: 3,
      lastError: 'Network unreachable',
      lastErrorRetryable: true,
      lastServerSyncAt: '2026-08-12T08:00:00.000Z',
      provenance: uniformProvenance('ocr'),
      vendor: 'Blue Bottle Coffee',
      amountMinorUnits: 1899,
      currency: 'USD',
      transactionDate: '2026-08-11',
    });

    const after = mergeExtraction(before, FULL_READING, 'barcode', NOW).draft;

    // A key-diff, not a list of fields to keep in sync by hand: a field added
    // to ReceiptDraft tomorrow is protected by this assertion today.
    for (const key of keyDiff(before, after)) {
      expect(WRITABLE_KEYS).toContain(key);
    }
    expect(keyDiff(before, after)).toEqual(WRITABLE_KEYS);
  });

  it('leaves state, ids and match fields alone even on a full overwrite', () => {
    const before = draftWith({
      state: 'processing',
      serverReceiptId: 'srv-9',
      idempotencyKey: 'idem-aaaa-1111',
      matchedTransactionId: 'txn-1',
      pendingMatchTransactionId: 'txn-2',
    });

    const after = mergeExtraction(before, FULL_READING, 'barcode', NOW).draft;

    expect(after.state).toBe('processing');
    expect(after.serverReceiptId).toBe('srv-9');
    expect(after.idempotencyKey).toBe('idem-aaaa-1111');
    expect(after.companyId).toBe(before.companyId);
    expect(after.localId).toBe(before.localId);
    expect(after.matchedTransactionId).toBe('txn-1');
    expect(after.pendingMatchTransactionId).toBe('txn-2');
  });

  it('does not mutate the draft it was given', () => {
    const frozen = deepFreeze(draftWith({ provenance: { ...EMPTY_PROVENANCE } }));
    const snapshot = JSON.stringify(frozen);

    expect(() => mergeExtraction(frozen, FULL_READING, 'barcode', NOW)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it('does not mutate the input it was given', () => {
    const input: ExtractionInput = { ...FULL_READING };
    Object.freeze(input);
    const snapshot = JSON.stringify(input);

    mergeExtraction(BASE_DRAFT, input, 'ocr', NOW);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// The changed flag, updatedAt and purity
// ---------------------------------------------------------------------------

describe('changed, updatedAt and determinism', () => {
  it('stamps updatedAt with `now` only when something was applied', () => {
    const appliedResult = mergeExtraction(BASE_DRAFT, FULL_READING, 'ocr', NOW);
    expect(appliedResult.changed).toBe(true);
    expect(appliedResult.draft.updatedAt).toBe(NOW);
    expect(appliedResult.draft.createdAt).toBe(CREATED);

    const refusedResult = mergeExtraction(
      draftWith({ ...FILLED_DRAFT, provenance: uniformProvenance('user') }),
      FULL_READING,
      'ocr',
      NOW,
    );
    expect(refusedResult.changed).toBe(false);
    expect(refusedResult.draft.updatedAt).toBe(CREATED);
  });

  it('is idempotent for a given origin: replaying the same reading changes nothing', () => {
    const first = mergeExtraction(BASE_DRAFT, FULL_READING, 'ocr', NOW);
    const second = mergeExtraction(first.draft, FULL_READING, 'ocr', '2026-08-12T11:00:00.000Z');

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.draft).toBe(first.draft);
    expect(second.draft.updatedAt).toBe(NOW);
  });

  it('is a pure function of its arguments', () => {
    const a = mergeExtraction(FILLED_DRAFT, FULL_READING, 'barcode', NOW);
    const b = mergeExtraction(FILLED_DRAFT, FULL_READING, 'barcode', NOW);

    expect(a.draft).toEqual(b.draft);
    expect(a.outcomes).toEqual(b.outcomes);
    expect(a.changed).toBe(b.changed);
  });

  it('emits exactly one outcome per extractable field, in a stable order', () => {
    const result = mergeExtraction(BASE_DRAFT, FULL_READING, 'ocr', NOW);

    expect(result.outcomes.map((o) => o.field)).toEqual([
      'vendor',
      'amount',
      'currency',
      'transactionDate',
    ]);
    // The same four, whether they applied or not.
    expect(
      mergeExtraction(BASE_DRAFT, NOTHING_OFFERED, 'ocr', NOW).outcomes.map((o) => o.field),
    ).toEqual(['vendor', 'amount', 'currency', 'transactionDate']);
  });

  it("refuses everything when the incoming origin is 'empty'", () => {
    // 'empty' is the absence of a writer, not a writer. It cannot even write a
    // field that is itself still empty.
    const result = mergeExtraction(BASE_DRAFT, FULL_READING, 'empty', NOW);

    expect(result.changed).toBe(false);
    expect(result.draft).toBe(BASE_DRAFT);
    for (const outcome of result.outcomes) {
      expect(outcome.applied).toBe(false);
    }
  });

  it.each([
    ['a date-only value', '2026-08-12'],
    ['a zoned offset rather than UTC', '2026-08-12T09:15:00.000+02:00'],
    ['a local timestamp with no zone', '2026-08-12T09:15:00.000'],
    ['free text', 'now'],
    ['an impossible day', '2026-02-30T09:15:00.000Z'],
  ])('throws when `now` is %s', (_label, now) => {
    expect(() => mergeExtraction(BASE_DRAFT, FULL_READING, 'ocr', now)).toThrow(RangeError);
  });

  it('validates `now` even when the merge would have changed nothing', () => {
    // Otherwise the guard would fire only on the paths that happen to write,
    // and a bad clock would go unnoticed until the day it mattered.
    expect(() => mergeExtraction(BASE_DRAFT, NOTHING_OFFERED, 'ocr', 'whenever')).toThrow(
      RangeError,
    );
  });
});
