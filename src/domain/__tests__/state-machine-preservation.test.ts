/**
 * What a transition must NOT touch.
 *
 * A mutation audit of the main state-machine suite found that six deliberate
 * sabotages went undetected — every one of them a transition that BLANKED a
 * field rather than mis-setting one. Blanking `provenance` turns a human
 * correction back into something a late OCR result may overwrite (the brief's
 * edge case 5); blanking `serverReceiptId` destroys the only evidence that a
 * server record exists, which is what `isServerConfirmed()` rests on.
 *
 * The original tests could not catch any of it, because they only ever asserted
 * what a transition CHANGES. This file asserts the complement: for every legal
 * transition, the set of keys that differ must be exactly the set the state
 * machine is entitled to own. Any field added to ReceiptDraft in future is
 * covered automatically, because the assertion is over Object.keys, not a list
 * someone has to remember to update.
 */

import {
  applyLocalEvent,
  applyServerEvent,
  type LocalEvent,
  type ServerEvent,
} from '../state-machine';
import type { FieldProvenance, ReceiptDraft, ReceiptState } from '../types';

const NOW = '2026-08-16T09:00:00.000Z';

/**
 * Every field is deliberately NON-default and distinctive, so that a
 * transition which silently resets one is detectable. A fixture full of nulls
 * cannot detect destruction — that was precisely the original flaw.
 */
const USER_PROVENANCE: FieldProvenance = {
  vendor: 'user',
  amount: 'user',
  currency: 'user',
  transactionDate: 'user',
};

function draftIn(state: ReceiptState): ReceiptDraft {
  return {
    localId: 'rcp_preserve_1',
    companyId: 'northwind',
    fileUri: 'file:///sandbox/rcp_preserve_1.jpg',
    fileName: 'receipt.jpg',
    fileMimeType: 'image/jpeg',
    fileSizeBytes: 250_000,
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: 4250,
    currency: 'USD',
    transactionDate: '2026-08-11',
    notes: 'client meeting',
    state,
    idempotencyKey: 'idem_preserve_fixture_key_000000',
    // Non-null on purpose: a draft can hold server evidence and still move
    // through local states (a successful upload followed by a later failure).
    serverReceiptId: 'rec_existing_7',
    matchedTransactionId: 'txn_nw_01',
    pendingMatchTransactionId: 'txn_nw_02',
    provenance: USER_PROVENANCE,
    lastError: 'previous failure text',
    lastErrorRetryable: true,
    attemptCount: 3,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-15T08:00:00.000Z',
    lastServerSyncAt: '2026-08-14T08:00:00.000Z',
  };
}

function changedKeys(before: ReceiptDraft, after: ReceiptDraft): Set<string> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = new Set<string>();
  for (const k of keys) {
    const a = before[k as keyof ReceiptDraft];
    const b = after[k as keyof ReceiptDraft];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.add(k);
  }
  return changed;
}

const LOCAL_ROWS: { from: ReceiptState; event: LocalEvent }[] = [
  { from: 'draft', event: 'submitOffline' },
  { from: 'failed', event: 'submitOffline' },
  { from: 'draft', event: 'submitOnline' },
  { from: 'failed', event: 'submitOnline' },
  { from: 'queued', event: 'beginUpload' },
  { from: 'failed', event: 'beginUpload' },
  { from: 'uploading', event: 'transferFailed' },
  { from: 'failed', event: 'retryQueued' },
  { from: 'failed', event: 'retryNow' },
];

const SERVER_ROWS: { from: ReceiptState; event: ServerEvent }[] = [
  { from: 'uploading', event: 'fileAccepted' },
  { from: 'uploading', event: 'recordCreated' },
  { from: 'processing', event: 'recordCreated' },
  { from: 'uploading', event: 'dataUncertain' },
  { from: 'processing', event: 'dataUncertain' },
  { from: 'needsReview', event: 'correctionAccepted' },
];

/** Keys applyLocalEvent is entitled to write. Everything else must survive. */
const LOCAL_OWNED = new Set(['state', 'updatedAt', 'attemptCount', 'lastError', 'lastErrorRetryable']);

/** Keys applyServerEvent is entitled to write. */
const SERVER_OWNED = new Set([
  'state',
  'serverReceiptId',
  'updatedAt',
  'lastServerSyncAt',
  'lastError',
  'lastErrorRetryable',
]);

describe('local transitions preserve everything they do not own', () => {
  it.each(LOCAL_ROWS)('$from --$event-> changes only machine-owned keys', ({ from, event }) => {
    const before = draftIn(from);
    const after = applyLocalEvent(before, event, NOW);

    for (const k of changedKeys(before, after)) {
      expect(LOCAL_OWNED).toContain(k);
    }
  });

  it.each(LOCAL_ROWS)('$from --$event-> keeps the receipt payload intact', ({ from, event }) => {
    const before = draftIn(from);
    const after = applyLocalEvent(before, event, NOW);

    expect(after.vendor).toBe(before.vendor);
    expect(after.amountMinorUnits).toBe(before.amountMinorUnits);
    expect(after.currency).toBe(before.currency);
    expect(after.transactionDate).toBe(before.transactionDate);
    expect(after.notes).toBe(before.notes);
    expect(after.fileUri).toBe(before.fileUri);
    expect(after.localId).toBe(before.localId);
    expect(after.companyId).toBe(before.companyId);
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it.each(LOCAL_ROWS)('$from --$event-> keeps a human edit a human edit', ({ from, event }) => {
    // Edge case 5: if a transition reset provenance to 'ocr' or 'empty', a late
    // extraction would be free to overwrite what the user typed.
    const after = applyLocalEvent(draftIn(from), event, NOW);
    expect(after.provenance).toEqual(USER_PROVENANCE);
  });

  it.each(LOCAL_ROWS)('$from --$event-> does not destroy server evidence', ({ from, event }) => {
    // A local event may not INVENT a server id (covered elsewhere), and it may
    // not DESTROY one either — that would make a confirmed receipt look unsent
    // and invite a duplicate submission.
    const after = applyLocalEvent(draftIn(from), event, NOW);
    expect(after.serverReceiptId).toBe('rec_existing_7');
    expect(after.matchedTransactionId).toBe('txn_nw_01');
  });

  it.each(LOCAL_ROWS)('$from --$event-> keeps the pending match selection', ({ from, event }) => {
    // sync-engine reads this back out to send as matchTransactionId; losing it
    // silently drops the user's match choice.
    const after = applyLocalEvent(draftIn(from), event, NOW);
    expect(after.pendingMatchTransactionId).toBe('txn_nw_02');
  });
});

describe('server transitions preserve everything they do not own', () => {
  it.each(SERVER_ROWS)('$from --$event-> changes only machine-owned keys', ({ from, event }) => {
    const before = draftIn(from);
    const after = applyServerEvent(before, event, 'rec_new_41', NOW);

    for (const k of changedKeys(before, after)) {
      expect(SERVER_OWNED).toContain(k);
    }
  });

  it.each(SERVER_ROWS)('$from --$event-> keeps payload and provenance', ({ from, event }) => {
    const before = draftIn(from);
    const after = applyServerEvent(before, event, 'rec_new_41', NOW);

    expect(after.vendor).toBe(before.vendor);
    expect(after.amountMinorUnits).toBe(before.amountMinorUnits);
    expect(after.currency).toBe(before.currency);
    expect(after.transactionDate).toBe(before.transactionDate);
    expect(after.provenance).toEqual(USER_PROVENANCE);
    expect(after.attemptCount).toBe(before.attemptCount);
  });

  it.each(SERVER_ROWS)('$from --$event-> adopts the id the server just returned', ({ from, event }) => {
    // The fixture already holds 'rec_existing_7'. If the implementation kept the
    // stale id (`draft.serverReceiptId ?? incoming`), a test that passed the id
    // the fixture already had could never tell. Passing a DIFFERENT id makes the
    // assertion bite.
    const after = applyServerEvent(draftIn(from), event, 'rec_new_41', NOW);
    expect(after.serverReceiptId).toBe('rec_new_41');
  });
});
