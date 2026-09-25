/**
 * Who owns a form field.
 *
 * Two bugs live here if the distinctions collapse:
 *
 *  - Stamping every non-empty field as 'user' on save records the currency
 *    picker's DEFAULT as a human decision. Someone photographing a euro receipt
 *    who never opened the picker would have 'USD' locked in permanently, since
 *    'user' outranks every automatic source.
 *
 *  - Once OCR pre-fills the form, the same shortcut promotes every guess to a
 *    human edit, so a later and better reading could never improve on it.
 */

import { mergeExtraction, originFor, provenanceForForm, type FieldState } from '../extraction';
import { EMPTY_PROVENANCE, type ReceiptDraft } from '../types';

const NOW = '2026-08-16T09:00:00.000Z';

const field = (over: Partial<FieldState> = {}): FieldState => ({
  hasValue: false,
  editedByUser: false,
  filledByOcr: false,
  ...over,
});

describe('originFor', () => {
  it('is user only when the person edited it AND it holds a value', () => {
    expect(originFor(field({ hasValue: true, editedByUser: true }))).toBe('user');
    // Edited, then cleared: no value means nothing is owned.
    expect(originFor(field({ hasValue: false, editedByUser: true }))).toBe('empty');
  });

  it('is ocr for a pre-filled value the person left alone', () => {
    expect(originFor(field({ hasValue: true, filledByOcr: true }))).toBe('ocr');
  });

  it('lets a human edit outrank the pre-fill it replaced', () => {
    expect(originFor(field({ hasValue: true, filledByOcr: true, editedByUser: true }))).toBe('user');
  });

  it('is empty for an untouched default', () => {
    // The currency picker starts on a code nobody chose. That is not a decision.
    expect(originFor(field({ hasValue: true }))).toBe('empty');
  });
});

describe('provenanceForForm', () => {
  it('records each field independently', () => {
    expect(
      provenanceForForm({
        vendor: field({ hasValue: true, editedByUser: true }),
        amount: field({ hasValue: true, filledByOcr: true }),
        currency: field({ hasValue: true }),
        transactionDate: field(),
      }),
    ).toEqual({ vendor: 'user', amount: 'ocr', currency: 'empty', transactionDate: 'empty' });
  });
});

/**
 * The end-to-end half: a lower-ranked field stays improvable, and a typed one
 * never is.
 */
describe('what each origin allows afterwards', () => {
  function draftWith(over: Partial<ReceiptDraft>): ReceiptDraft {
    return {
      localId: 'rcp_1', companyId: 'northwind',
      fileUri: 'file:///r.jpg', fileName: 'r.jpg', fileMimeType: 'image/jpeg', fileSizeBytes: 1000,
      vendor: null, amountMinorUnits: null, currency: 'USD', transactionDate: null, notes: null,
      state: 'draft', idempotencyKey: 'idem_x',
      serverReceiptId: null, matchedTransactionId: null, pendingMatchTransactionId: null,
      provenance: EMPTY_PROVENANCE,
      lastError: null, lastErrorRetryable: false, attemptCount: 0,
      createdAt: NOW, updatedAt: NOW, lastServerSyncAt: null,
      ...over,
    };
  }

  it('lets a barcode improve a vendor that OCR guessed', () => {
    const draft = draftWith({
      vendor: 'BLUEBOTLE',
      provenance: provenanceForForm({
        vendor: field({ hasValue: true, filledByOcr: true }),
        amount: field(), currency: field(), transactionDate: field(),
      }),
    });

    const r = mergeExtraction(
      draft,
      { vendor: 'Blue Bottle Coffee', amountMinorUnits: null, currency: null, transactionDate: null },
      'barcode',
      NOW,
    );

    expect(r.changed).toBe(true);
    expect(r.draft.vendor).toBe('Blue Bottle Coffee');
  });

  it('refuses to improve a vendor the person typed', () => {
    const draft = draftWith({
      vendor: 'Blue Bottle',
      provenance: provenanceForForm({
        vendor: field({ hasValue: true, editedByUser: true }),
        amount: field(), currency: field(), transactionDate: field(),
      }),
    });

    const r = mergeExtraction(
      draft,
      { vendor: 'WRONG', amountMinorUnits: null, currency: null, transactionDate: null },
      'barcode',
      NOW,
    );

    expect(r.changed).toBe(false);
    expect(r.draft.vendor).toBe('Blue Bottle');
  });

  it('refuses to re-denominate a typed amount, even when the currency is unclaimed', () => {
    // The currency slot is free, but the number is not - so the whole reading
    // is refused rather than quietly restating 19.99 USD as 19.99 EUR.
    const draft = draftWith({
      amountMinorUnits: 1999,
      currency: 'USD',
      provenance: provenanceForForm({
        vendor: field(),
        amount: field({ hasValue: true, editedByUser: true }),
        currency: field({ hasValue: true }), // untouched default
        transactionDate: field(),
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

  it('lets an extraction fill a field the person left blank', () => {
    const draft = draftWith({
      provenance: provenanceForForm({
        vendor: field(), amount: field(), currency: field(), transactionDate: field(),
      }),
    });

    const r = mergeExtraction(
      draft,
      { vendor: null, amountMinorUnits: null, currency: null, transactionDate: '2026-08-11' },
      'ocr',
      NOW,
    );

    expect(r.draft.transactionDate).toBe('2026-08-11');
  });
});
