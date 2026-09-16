/**
 * Tests for the pure notification policy.
 *
 * Where a transition is legal, these tests build it with the REAL state machine
 * rather than hand-assembling the "after" draft. That way the suite proves the
 * policy fires on transitions the app can actually produce, instead of on
 * shapes only a test could invent.
 *
 * The two exceptions are deliberate and commented at their use sites: a
 * `confirmed` draft with no `serverReceiptId` and a `needsReview` draft with no
 * `serverReceiptId` are both states `applyServerEvent()` structurally refuses to
 * create. They are hand-built precisely because a corrupted row, a bad
 * migration or a future bug could still present one, and the policy must refuse
 * to make a claim on that evidence.
 */

import { applyLocalEvent, applyServerEvent } from '../../domain/state-machine';
import { EMPTY_PROVENANCE, type ReceiptDraft } from '../../domain/types';
import { planNotification, type NotificationPlan } from '../policy';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_A = 'co_acme';
const COMPANY_A_NAME = 'Acme Logistics';
const COMPANY_B = 'co_northwind';
const COMPANY_B_NAME = 'Northwind Traders';

const LOCAL_ID = 'rcp_AAAAAAAAAAAAAAAAAAAAA1';
const SERVER_ID = 'rec_1';
const NOW = '2026-08-11T10:05:00.000Z';

/**
 * A distinctive amount. 1234567 minor units is $12,345.67 — long enough that
 * any accidental leak of it into copy, in minor units or formatted, contains
 * the substring '12345'.
 */
const DISTINCTIVE_AMOUNT = 1234567;

function makeDraft(overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  const base: ReceiptDraft = {
    localId: LOCAL_ID,
    companyId: COMPANY_A,
    fileUri: 'file:///sandbox/receipts/a1.jpg',
    fileName: 'receipt.jpg',
    fileMimeType: 'image/jpeg',
    fileSizeBytes: 120_000,
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: DISTINCTIVE_AMOUNT,
    currency: 'USD',
    transactionDate: '2026-08-11',
    notes: null,
    state: 'uploading',
    idempotencyKey: `idem_${'a'.repeat(32)}`,
    serverReceiptId: null,
    matchedTransactionId: null,
    pendingMatchTransactionId: null,
    provenance: { ...EMPTY_PROVENANCE },
    lastError: null,
    lastErrorRetryable: false,
    attemptCount: 1,
    createdAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
    lastServerSyncAt: null,
  };
  return {
    ...base,
    ...overrides,
    provenance: { ...base.provenance, ...(overrides.provenance ?? {}) },
  };
}

/** Narrows without a non-null assertion, and fails loudly with a useful message. */
function expectPlan(p: NotificationPlan | null): NotificationPlan {
  if (p === null) throw new Error('expected a notification plan, got null');
  return p;
}

// Canonical "before" and "after" drafts for each trigger.
const UPLOADING = makeDraft({ state: 'uploading' });
const CONFIRMED = applyServerEvent(UPLOADING, 'recordCreated', SERVER_ID, NOW);
const NEEDS_REVIEW = applyServerEvent(UPLOADING, 'dataUncertain', SERVER_ID, NOW);
const PERMANENTLY_FAILED = applyLocalEvent(UPLOADING, 'transferFailed', NOW, {
  lastError: 'File type not supported.',
  lastErrorRetryable: false,
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe('trigger: confirmed', () => {
  it('fires when the server creates the record', () => {
    const plan = expectPlan(planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME));

    expect(plan.trigger).toBe('confirmed');
    expect(plan.title).toBe('Receipt confirmed');
    expect(plan.body).toBe('Your Blue Bottle Coffee receipt was confirmed for Acme Logistics.');
    expect(plan.route).toBe(`/receipt/${LOCAL_ID}`);
    expect(plan.companyId).toBe(COMPANY_A);
  });

  it('fires when a reviewed receipt is finally accepted', () => {
    const accepted = applyServerEvent(NEEDS_REVIEW, 'correctionAccepted', SERVER_ID, NOW);
    const plan = expectPlan(planNotification(NEEDS_REVIEW, accepted, COMPANY_A_NAME));

    expect(plan.trigger).toBe('confirmed');
  });

  it('fires when the missing server id finally arrives — the evidence is the news', () => {
    // Hand-built: applyServerEvent() cannot produce a confirmed draft with a
    // null id, but a corrupt row could, and recovering from one is a real
    // transition the user should hear about.
    const unproven = makeDraft({ state: 'confirmed', serverReceiptId: null });
    const proven = makeDraft({ state: 'confirmed', serverReceiptId: SERVER_ID });

    expect(expectPlan(planNotification(unproven, proven, COMPANY_A_NAME)).trigger).toBe('confirmed');
  });

  it('NEVER claims confirmation without a server receipt id', () => {
    // The invariant that governs the whole app, on its loudest surface.
    const unproven = makeDraft({ state: 'confirmed', serverReceiptId: null });

    expect(planNotification(UPLOADING, unproven, COMPANY_A_NAME)).toBeNull();
  });
});

describe('trigger: needsReview', () => {
  it('fires when the server cannot confidently read the receipt', () => {
    const processing = applyServerEvent(UPLOADING, 'fileAccepted', SERVER_ID, NOW);
    const plan = expectPlan(planNotification(processing, NEEDS_REVIEW, COMPANY_A_NAME));

    expect(plan.trigger).toBe('needsReview');
    expect(plan.title).toBe('Receipt needs review');
    expect(plan.body).toContain('needs a quick review');
    expect(plan.body).toContain(COMPANY_A_NAME);
  });

  it('refuses to report a review request with no server id behind it', () => {
    // Same class of claim as 'confirmed': needsReview asserts the server has
    // the file. Hand-built for the same reason as above.
    const unproven = makeDraft({ state: 'needsReview', serverReceiptId: null });

    expect(planNotification(UPLOADING, unproven, COMPANY_A_NAME)).toBeNull();
  });
});

describe('trigger: permanentlyFailed', () => {
  it('fires when a failure cannot be retried', () => {
    const plan = expectPlan(planNotification(UPLOADING, PERMANENTLY_FAILED, COMPANY_A_NAME));

    expect(plan.trigger).toBe('permanentlyFailed');
    expect(plan.title).toBe('Receipt could not be sent');
    expect(plan.body).toContain('Open it to fix and resubmit.');
  });

  it('stays silent for a retryable failure — the sync engine will handle it', () => {
    const transient = applyLocalEvent(UPLOADING, 'transferFailed', NOW, {
      lastError: 'Network unavailable.',
      lastErrorRetryable: true,
    });

    expect(planNotification(UPLOADING, transient, COMPANY_A_NAME)).toBeNull();
  });

  it('fires when a retryable failure is downgraded to a permanent one', () => {
    const transient = applyLocalEvent(UPLOADING, 'transferFailed', NOW, {
      lastError: 'Network unavailable.',
      lastErrorRetryable: true,
    });
    const permanent = makeDraft({
      state: 'failed',
      lastError: 'Rejected: file type not supported.',
      lastErrorRetryable: false,
    });

    expect(expectPlan(planNotification(transient, permanent, COMPANY_A_NAME)).trigger).toBe(
      'permanentlyFailed',
    );
  });
});

// ---------------------------------------------------------------------------
// Non-events
// ---------------------------------------------------------------------------

describe('no-op transitions', () => {
  it('returns null when nothing relevant changed', () => {
    expect(planNotification(CONFIRMED, CONFIRMED, COMPANY_A_NAME)).toBeNull();
    expect(planNotification(NEEDS_REVIEW, NEEDS_REVIEW, COMPANY_A_NAME)).toBeNull();
    expect(planNotification(PERMANENTLY_FAILED, PERMANENTLY_FAILED, COMPANY_A_NAME)).toBeNull();
  });

  it('does not re-announce a condition the receipt was already in', () => {
    // A background sync that re-reads the same row, with only irrelevant
    // metadata moving, must not buzz the phone again.
    const touched = makeDraft({
      state: 'confirmed',
      serverReceiptId: SERVER_ID,
      updatedAt: '2026-08-11T11:00:00.000Z',
      lastServerSyncAt: '2026-08-11T11:00:00.000Z',
      notes: 'client dinner',
    });
    const confirmedBefore = makeDraft({ state: 'confirmed', serverReceiptId: SERVER_ID });

    expect(planNotification(confirmedBefore, touched, COMPANY_A_NAME)).toBeNull();
  });

  it('does not re-announce a permanent failure whose message was reworded', () => {
    const reworded = makeDraft({
      state: 'failed',
      lastError: 'Rejected: that file type is not supported.',
      lastErrorRetryable: false,
    });

    expect(planNotification(PERMANENTLY_FAILED, reworded, COMPANY_A_NAME)).toBeNull();
  });
});

describe('local transitions the user caused themselves', () => {
  const draft = makeDraft({ state: 'draft', attemptCount: 0 });
  const failed = makeDraft({ state: 'failed', lastError: 'Offline.', lastErrorRetryable: true });

  it.each([
    ['draft -> queued', draft, applyLocalEvent(draft, 'submitOffline', NOW)],
    ['draft -> uploading', draft, applyLocalEvent(draft, 'submitOnline', NOW)],
    ['queued -> uploading', makeDraft({ state: 'queued' }), UPLOADING],
    ['failed -> queued (retry)', failed, applyLocalEvent(failed, 'retryQueued', NOW)],
    ['failed -> uploading (retry)', failed, applyLocalEvent(failed, 'retryNow', NOW)],
  ])('%s produces no notification', (_label, previous, next) => {
    expect(planNotification(previous, next, COMPANY_A_NAME)).toBeNull();
  });

  it('stays silent while the server is merely processing', () => {
    // A server state, but not one the user can act on. Telling them "we are
    // still working" is the noise that gets notifications switched off.
    const processing = applyServerEvent(UPLOADING, 'fileAccepted', SERVER_ID, NOW);

    expect(planNotification(UPLOADING, processing, COMPANY_A_NAME)).toBeNull();
  });
});

describe('guards against mismatched inputs', () => {
  it('returns null when the two drafts are not the same receipt', () => {
    const other = applyServerEvent(
      makeDraft({ localId: 'rcp_BBBBBBBBBBBBBBBBBBBBB2' }),
      'recordCreated',
      SERVER_ID,
      NOW,
    );

    expect(planNotification(UPLOADING, other, COMPANY_A_NAME)).toBeNull();
  });

  it('returns null when the company differs between the two drafts', () => {
    const crossCompany = applyServerEvent(
      makeDraft({ companyId: COMPANY_B }),
      'recordCreated',
      SERVER_ID,
      NOW,
    );

    expect(planNotification(UPLOADING, crossCompany, COMPANY_A_NAME)).toBeNull();
  });

  it('returns null when there is no company to scope to or no route to open', () => {
    const noCompany = makeDraft({ companyId: '', state: 'confirmed', serverReceiptId: SERVER_ID });
    const noLocalId = makeDraft({ localId: '', state: 'confirmed', serverReceiptId: SERVER_ID });

    expect(planNotification(makeDraft({ companyId: '' }), noCompany, COMPANY_A_NAME)).toBeNull();
    expect(planNotification(makeDraft({ localId: '' }), noLocalId, COMPANY_A_NAME)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('privacy: the amount never reaches a lock screen', () => {
  const firing: readonly [string, ReceiptDraft, ReceiptDraft][] = [
    ['confirmed', UPLOADING, CONFIRMED],
    ['needsReview', UPLOADING, NEEDS_REVIEW],
    ['permanentlyFailed', UPLOADING, PERMANENTLY_FAILED],
  ];

  it.each(firing)('%s copy contains no digits from the amount', (_label, previous, next) => {
    const plan = expectPlan(planNotification(previous, next, COMPANY_A_NAME));
    const rendered = `${plan.title} ${plan.body}`;

    // 1234567 minor units, in every plausible rendering.
    expect(rendered).not.toContain('12345');
    expect(rendered).not.toContain('1234567');
    expect(rendered).not.toContain('12,345.67');
    expect(rendered).not.toContain('12345.67');
    // Belt and braces: no numeric run at all. The fixture vendor and company
    // names contain no digits, so anything numeric here came from the record.
    expect(rendered).not.toMatch(/\d/);
  });

  it('keeps the vendor and the company, which are what make it actionable', () => {
    const plan = expectPlan(planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME));

    expect(plan.body).toContain('Blue Bottle Coffee');
    expect(plan.body).toContain(COMPANY_A_NAME);
  });

  it('leaks nothing when the amount is the only field set', () => {
    const sparse = makeDraft({ state: 'uploading', vendor: null, currency: 'USD' });
    const confirmed = applyServerEvent(sparse, 'recordCreated', SERVER_ID, NOW);
    const plan = expectPlan(planNotification(sparse, confirmed, COMPANY_A_NAME));

    expect(plan.body).toBe('Your receipt was confirmed for Acme Logistics.');
  });
});

// ---------------------------------------------------------------------------
// Thread keys and routes
// ---------------------------------------------------------------------------

describe('threadKey', () => {
  it('is company-scoped, so two companies cannot collapse into one thread', () => {
    // Same local id under each company: only the company scope separates them.
    const aBefore = makeDraft({ companyId: COMPANY_A });
    const bBefore = makeDraft({ companyId: COMPANY_B });
    const a = expectPlan(
      planNotification(aBefore, applyServerEvent(aBefore, 'recordCreated', SERVER_ID, NOW), COMPANY_A_NAME),
    );
    const b = expectPlan(
      planNotification(bBefore, applyServerEvent(bBefore, 'recordCreated', SERVER_ID, NOW), COMPANY_B_NAME),
    );

    expect(a.threadKey).not.toBe(b.threadKey);
    expect(a.threadKey).toContain(COMPANY_A);
    expect(b.threadKey).toContain(COMPANY_B);
    expect(a.companyId).toBe(COMPANY_A);
    expect(b.companyId).toBe(COMPANY_B);
  });

  it('is stable across triggers for one receipt, so updates replace each other', () => {
    const review = expectPlan(planNotification(UPLOADING, NEEDS_REVIEW, COMPANY_A_NAME));
    const accepted = applyServerEvent(NEEDS_REVIEW, 'correctionAccepted', SERVER_ID, NOW);
    const confirmed = expectPlan(planNotification(NEEDS_REVIEW, accepted, COMPANY_A_NAME));

    expect(confirmed.threadKey).toBe(review.threadKey);
    expect(confirmed.trigger).not.toBe(review.trigger);
  });

  it('separates two receipts in the same company', () => {
    const otherBefore = makeDraft({ localId: 'rcp_CCCCCCCCCCCCCCCCCCCCC3' });
    const other = expectPlan(
      planNotification(
        otherBefore,
        applyServerEvent(otherBefore, 'recordCreated', SERVER_ID, NOW),
        COMPANY_A_NAME,
      ),
    );
    const mine = expectPlan(planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME));

    expect(other.threadKey).not.toBe(mine.threadKey);
  });
});

describe('route', () => {
  it('deep links to the receipt detail screen', () => {
    expect(expectPlan(planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME)).route).toBe(
      `/receipt/${LOCAL_ID}`,
    );
  });

  it('escapes an id that would otherwise reshape the path', () => {
    const before = makeDraft({ localId: 'rcp_a/../settings' });
    const plan = expectPlan(
      planNotification(before, applyServerEvent(before, 'recordCreated', SERVER_ID, NOW), COMPANY_A_NAME),
    );

    expect(plan.route).toBe('/receipt/rcp_a%2F..%2Fsettings');
  });
});

// ---------------------------------------------------------------------------
// Copy hygiene and determinism
// ---------------------------------------------------------------------------

describe('copy hygiene', () => {
  it('flattens control characters and newlines out of an OCR-derived vendor', () => {
    const before = makeDraft({ vendor: 'BLUE\tBOTTLE\r\n  COFFEE\x07' });
    const plan = expectPlan(
      planNotification(before, applyServerEvent(before, 'recordCreated', SERVER_ID, NOW), COMPANY_A_NAME),
    );

    expect(plan.body).toBe('Your BLUE BOTTLE COFFEE receipt was confirmed for Acme Logistics.');
    expect(plan.body).not.toMatch(/[\r\n\t]/);
  });

  it('truncates a runaway vendor rather than letting the OS cut mid-sentence', () => {
    const before = makeDraft({ vendor: 'A'.repeat(500) });
    const plan = expectPlan(
      planNotification(before, applyServerEvent(before, 'recordCreated', SERVER_ID, NOW), COMPANY_A_NAME),
    );

    expect(plan.body).toContain('…');
    expect(plan.body).toContain('was confirmed for Acme Logistics.');
    expect(plan.body.length).toBeLessThan(120);
  });

  it('falls back to the company id when given no usable company name', () => {
    // Ugly, but never ambiguous — and ambiguity is the failure that matters
    // when the user has two companies.
    const plan = expectPlan(planNotification(UPLOADING, CONFIRMED, '   '));

    expect(plan.body).toContain(COMPANY_A);
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    const first = planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME);
    const second = planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME);

    expect(second).toEqual(first);
  });

  it('never returns a plan carrying the "none" trigger', () => {
    // 'none' is signalled by null. A plan that reached a presenter with nothing
    // to say would be a contradiction.
    const plans = [
      planNotification(UPLOADING, CONFIRMED, COMPANY_A_NAME),
      planNotification(UPLOADING, NEEDS_REVIEW, COMPANY_A_NAME),
      planNotification(UPLOADING, PERMANENTLY_FAILED, COMPANY_A_NAME),
    ];

    for (const plan of plans) {
      expect(expectPlan(plan).trigger).not.toBe('none');
    }
  });
});
