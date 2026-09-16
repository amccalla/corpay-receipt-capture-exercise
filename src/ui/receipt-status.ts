/**
 * How a receipt's status is presented.
 *
 * The brief's first non-negotiable is "Local and remote state are visibly
 * different", and its sharpest warning is that work "must never tell the user
 * 'confirmed' merely because a local queue accepted it."
 *
 * So the UI never renders a single status. It always renders TWO independent
 * facts side by side:
 *
 *   ON THIS DEVICE — what we have done locally. Always known.
 *   ON THE SERVER  — what the backend has actually acknowledged. Frequently
 *                    "nothing yet", and we say so plainly.
 *
 * The server column is derived from `serverReceiptId`, not from `state`. A
 * draft cannot display as server-confirmed without the server having handed us
 * an id, because the id is the only evidence that exists.
 */

import { isServerConfirmed, type ReceiptDraft, type ReceiptState } from '../domain/types';

export type Tone = 'neutral' | 'pending' | 'success' | 'warning' | 'danger';

export interface StatusDisplay {
  readonly deviceLabel: string;
  readonly deviceTone: Tone;
  readonly serverLabel: string;
  readonly serverTone: Tone;
  /** One plain sentence explaining what the two columns mean together. */
  readonly explanation: string;
  /** The single most useful next action, if there is one. */
  readonly action: 'submit' | 'retry' | 'review' | 'switchCompany' | 'fixFile' | null;
  readonly actionLabel: string | null;
}

const DEVICE_LABEL: Record<ReceiptState, string> = {
  draft: 'Draft',
  queued: 'Queued',
  uploading: 'Uploading',
  processing: 'Sent',
  failed: 'Failed',
  needsReview: 'Sent',
  confirmed: 'Sent',
};

const DEVICE_TONE: Record<ReceiptState, Tone> = {
  draft: 'neutral',
  queued: 'pending',
  uploading: 'pending',
  processing: 'pending',
  failed: 'danger',
  needsReview: 'pending',
  confirmed: 'success',
};

export function describeStatus(d: ReceiptDraft): StatusDisplay {
  const deviceLabel = DEVICE_LABEL[d.state];
  const deviceTone = DEVICE_TONE[d.state];

  // ---- the server column -------------------------------------------------
  // Note what this does NOT do: it does not read d.state to decide whether the
  // server knows anything. Only serverReceiptId can establish that.
  if (d.serverReceiptId === null) {
    const explanation =
      d.state === 'queued'
        ? 'Saved on this device. The backend has no record of it yet.'
        : d.state === 'uploading'
          ? 'Submitting. The backend has not acknowledged it yet.'
          : d.state === 'failed'
            ? `The backend has no record of it. ${d.lastError ?? ''}`.trim()
            : 'Not submitted. This exists only on this device.';

    return {
      deviceLabel,
      deviceTone,
      serverLabel: 'Not received',
      serverTone: d.state === 'failed' ? 'danger' : 'neutral',
      explanation,
      action:
        d.state === 'failed'
          ? d.lastErrorRetryable ? 'retry' : 'fixFile'
          : d.state === 'draft'
            ? 'submit'
            : null,
      actionLabel:
        d.state === 'failed'
          ? d.lastErrorRetryable ? 'Try again' : 'Fix and resubmit'
          : d.state === 'draft'
            ? 'Submit'
            : null,
    };
  }

  // ---- the server has spoken ---------------------------------------------
  if (isServerConfirmed(d)) {
    return {
      deviceLabel,
      deviceTone: 'success',
      serverLabel: 'Confirmed',
      serverTone: 'success',
      explanation: d.matchedTransactionId
        ? 'The backend created the expense record and saved the match.'
        : 'The backend created the expense record. It is not matched to a transaction.',
      action: null,
      actionLabel: null,
    };
  }

  if (d.state === 'needsReview') {
    return {
      deviceLabel,
      deviceTone: 'warning',
      serverLabel: 'Needs review',
      serverTone: 'warning',
      explanation:
        'The backend could not confidently read this receipt. Check the details and confirm.',
      action: 'review',
      actionLabel: 'Review details',
    };
  }

  if (d.state === 'processing') {
    return {
      deviceLabel,
      deviceTone,
      serverLabel: 'Processing',
      serverTone: 'pending',
      explanation:
        'The backend has it and is working on it. Not confirmed until the expense record exists.',
      action: null,
      actionLabel: null,
    };
  }

  // The server gave us an id but we are back in a local state — this happens
  // after a successful upload followed by a later failure. Worth saying out
  // loud rather than hiding, because it means a record may already exist.
  return {
    deviceLabel,
    deviceTone,
    serverLabel: 'Partially received',
    serverTone: 'warning',
    explanation:
      'The backend previously accepted this receipt, but the last attempt did not complete. ' +
      'Retrying is safe — it will not create a duplicate.',
    action: 'retry',
    actionLabel: 'Try again',
  };
}

/**
 * Explains why a draft cannot be submitted right now under the active company.
 * Returns null when it can. Used to render an honest, specific blocker instead
 * of a disabled button with no reason.
 */
export function describeCompanyBlock(
  d: ReceiptDraft,
  activeCompanyId: string | null,
  companyName: (id: string) => string,
): string | null {
  if (activeCompanyId === null) return 'You are signed out. Sign in to submit this receipt.';
  if (d.companyId !== activeCompanyId) {
    return `This receipt was captured under ${companyName(d.companyId)}. Switch to that company to submit it.`;
  }
  return null;
}
