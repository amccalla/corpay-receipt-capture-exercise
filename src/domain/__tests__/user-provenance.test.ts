/**
 * Provenance for human entry.
 *
 * The bug this pins: the capture form used to stamp all four fields as 'user'
 * on every save. That records the currency picker's DEFAULT as a human
 * decision, so a euro receipt typed by someone who never opened the picker
 * would have 'USD' locked in permanently — unfixable by any later barcode or
 * OCR pass, because 'user' outranks both.
 */

import { mergeExtraction, provenanceForUserEntry } from '../extraction';
import { EMPTY_PROVENANCE, type ReceiptDraft } from '../types';

const NOW = '2026-08-16T09:00:00.000Z';

describe('provenanceForUserEntry', () => {
  it('marks only what the person actually supplied', () => {
    expect(
      provenanceForUserEntry({
        vendor: 'Blue Bottle',
        amountMinorUnits: 1999,
        currencyChosen: false, // never opened the picker
        transactionDate: null, // left blank
      }),
    ).toEqual({
      vendor: 'user',
      amount: 'user',
      currency: 'empty',
      transactionDate: 'empty',
    });
  });

  it('marks the currency as user only when it was actively chosen', () => {
    expect(
      provenanceForUserEntry({ vendor: null, amountMinorUnits: null, currencyChosen: true, transactionDate: null })
        .currency,
    ).toBe('user');
    expect(
      provenanceForUserEntry({ vendor: null, amountMinorUnits: null, currencyChosen: false, transactionDate: null })
        .currency,
    ).toBe('empty');
  });

  it.each(['', '   ', '\t\n'])('treats whitespace-only input (%j) as not supplied', (blank) => {
    const p = provenanceForUserEntry({
      vendor: blank,
      amountMinorUnits: null,
      currencyChosen: false,
      transactionDate: blank,
    });
    expect(p.vendor).toBe('empty');
    expect(p.transactionDate).toBe('empty');
  });

  it('marks everything when everything was supplied', () => {
    expect(
      provenanceForUserEntry({
        vendor: 'Blue Bottle',
        amountMinorUnits: 1999,
        currencyChosen: true,
        transactionDate: '2026-08-11',
      }),
    ).toEqual({ vendor: 'user', amount: 'user', currency: 'user', transactionDate: 'user' });
  });
});

/**
 * The end-to-end half: leaving a field 'empty' must let an extraction help,
 * while still never letting it restate a number the user typed.
 */
describe('untouched fields stay fillable, typed fields stay safe', () => {
  function draftWith(over: Partial<ReceiptDraft>): ReceiptDraft {
    return {
      localId: 'rcp_1',
      companyId: 'northwind',
      fileUri: 'file:///r.jpg',
      fileName: 'r.jpg',
      fileMimeType: 'image/jpeg',
      fileSizeBytes: 1000,
      vendor: null,
      amountMinorUnits: null,
      currency: 'USD',
      transactionDate: null,
      notes: null,
      state: 'draft',
      idempotencyKey: 'idem_x',
      serverReceiptId: null,
      matchedTransactionId: null,
      pendingMatchTransactionId: null,
      provenance: EMPTY_PROVENANCE,
      lastError: null,
      lastErrorRetryable: false,
      attemptCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      lastServerSyncAt: null,
      ...over,
    };
  }

  it('lets a barcode fill a date the user left blank', () => {
    const draft = draftWith({
      vendor: 'Blue Bottle',
      amountMinorUnits: 1999,
      provenance: provenanceForUserEntry({
        vendor: 'Blue Bottle',
        amountMinorUnits: 1999,
        currencyChosen: true,
        transactionDate: null,
      }),
    });

    const r = mergeExtraction(
      draft,
      { vendor: null, amountMinorUnits: null, currency: null, transactionDate: '2026-08-11' },
      'barcode',
      NOW,
    );

    expect(r.changed).toBe(true);
    expect(r.draft.transactionDate).toBe('2026-08-11');
    // And it did not touch what the person typed.
    expect(r.draft.vendor).toBe('Blue Bottle');
    expect(r.draft.amountMinorUnits).toBe(1999);
  });

  it('refuses to re-denominate an amount the user typed, even when currency is unclaimed', () => {
    // THE decisive case for marking an untouched currency 'empty'. The currency
    // slot is free, but the number is not — so the reading is refused rather
    // than quietly restating 19.99 USD as 19.99 EUR.
    const draft = draftWith({
      amountMinorUnits: 1999,
      currency: 'USD',
      provenance: provenanceForUserEntry({
        vendor: null,
        amountMinorUnits: 1999,
        currencyChosen: false, // never touched the picker
        transactionDate: null,
      }),
    });

    const r = mergeExtraction(
      draft,
      { vendor: null, amountMinorUnits: null, currency: 'EUR', transactionDate: null },
      'barcode',
      NOW,
    );

    expect(r.draft.currency).toBe('USD');
    expect(r.draft.amountMinorUnits).toBe(1999);
  });

  it('never lets an extraction overwrite a value the user typed', () => {
    const draft = draftWith({
      vendor: 'Blue Bottle',
      amountMinorUnits: 1999,
      currency: 'USD',
      transactionDate: '2026-08-11',
      provenance: provenanceForUserEntry({
        vendor: 'Blue Bottle',
        amountMinorUnits: 1999,
        currencyChosen: true,
        transactionDate: '2026-08-11',
      }),
    });

    const r = mergeExtraction(
      draft,
      { vendor: 'WRONG', amountMinorUnits: 9999, currency: 'EUR', transactionDate: '2020-01-01' },
      'ocr',
      NOW,
    );

    expect(r.changed).toBe(false);
    expect(r.draft.vendor).toBe('Blue Bottle');
    expect(r.draft.amountMinorUnits).toBe(1999);
    expect(r.draft.currency).toBe('USD');
    expect(r.draft.transactionDate).toBe('2026-08-11');
  });
});
