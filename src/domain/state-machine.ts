/**
 * The receipt state machine from the brief's conceptual flow.
 *
 * The single most important rule in this file:
 *
 *     A LOCAL EVENT CAN NEVER PRODUCE A SERVER STATE.
 *
 * `processing`, `needsReview` and `confirmed` are claims about what a server
 * did. They are reachable only through `applyServerEvent()`, which requires a
 * server receipt id as evidence. `applyLocalEvent()` structurally cannot
 * return them. That is what stops the app from telling a user "confirmed"
 * because a local queue accepted a file.
 */

import type { ReceiptDraft, ReceiptState } from './types';
import { isServerState } from './types';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Things this device can decide on its own. */
export type LocalEvent =
  /** User submitted with no connectivity — park it durably. */
  | 'submitOffline'
  /** User submitted while online — go straight to the wire. */
  | 'submitOnline'
  /** Sync engine picked a queued draft up: network and auth are available. */
  | 'beginUpload'
  /** Transfer rejected or interrupted. */
  | 'transferFailed'
  /** "Retry same intent" — same idempotency key, no new record. */
  | 'retryQueued'
  | 'retryNow';

/** Things only a server response may assert. */
export type ServerEvent =
  /** File accepted; the server is now working on it. */
  | 'fileAccepted'
  /** Record created and match saved. */
  | 'recordCreated'
  /** Extracted/match data uncertain — a human needs to look. */
  | 'dataUncertain'
  /** The user's corrections were accepted by the server. */
  | 'correctionAccepted';

// ---------------------------------------------------------------------------
// Transition tables
// ---------------------------------------------------------------------------

/**
 * Local transitions. Note every target is a local state — enforced by the
 * `LocalState` return type and asserted in tests.
 */
const LOCAL_TRANSITIONS: Record<LocalEvent, { from: ReceiptState[]; to: ReceiptState }> = {
  submitOffline: { from: ['draft', 'failed'], to: 'queued' },
  submitOnline: { from: ['draft', 'failed'], to: 'uploading' },
  beginUpload: { from: ['queued', 'failed'], to: 'uploading' },
  transferFailed: { from: ['uploading'], to: 'failed' },
  retryQueued: { from: ['failed'], to: 'queued' },
  retryNow: { from: ['failed'], to: 'uploading' },
};

const SERVER_TRANSITIONS: Record<ServerEvent, { from: ReceiptState[]; to: ReceiptState }> = {
  fileAccepted: { from: ['uploading'], to: 'processing' },
  recordCreated: { from: ['uploading', 'processing'], to: 'confirmed' },
  dataUncertain: { from: ['uploading', 'processing'], to: 'needsReview' },
  correctionAccepted: { from: ['needsReview'], to: 'confirmed' },
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ReceiptState,
    readonly event: LocalEvent | ServerEvent,
  ) {
    super(`Illegal transition: cannot apply '${event}' while in '${from}'`);
    this.name = 'IllegalTransitionError';
  }
}

export class UnprovenServerStateError extends Error {
  constructor(event: ServerEvent) {
    super(
      `Refusing to enter a server state via '${event}' without a server receipt id. ` +
        `A local queue accepting a file is not a confirmation.`,
    );
    this.name = 'UnprovenServerStateError';
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function canApplyLocal(from: ReceiptState, event: LocalEvent): boolean {
  return LOCAL_TRANSITIONS[event].from.includes(from);
}

export function canApplyServer(from: ReceiptState, event: ServerEvent): boolean {
  return SERVER_TRANSITIONS[event].from.includes(from);
}

export function nextLocalState(from: ReceiptState, event: LocalEvent): ReceiptState | null {
  return canApplyLocal(from, event) ? LOCAL_TRANSITIONS[event].to : null;
}

export function nextServerState(from: ReceiptState, event: ServerEvent): ReceiptState | null {
  return canApplyServer(from, event) ? SERVER_TRANSITIONS[event].to : null;
}

/** A draft in one of these states is work the sync engine still owes the user. */
export function isPending(state: ReceiptState): boolean {
  return state === 'queued' || state === 'uploading' || state === 'processing';
}

/** Terminal from the app's point of view — nothing further will happen unaided. */
export function isTerminal(state: ReceiptState): boolean {
  return state === 'confirmed';
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Apply a device-originated event. Cannot produce a server state.
 * `now` is injected so tests are deterministic and the module stays pure.
 */
export function applyLocalEvent(
  draft: ReceiptDraft,
  event: LocalEvent,
  now: string,
  patch: Partial<ReceiptDraft> = {},
): ReceiptDraft {
  const to = nextLocalState(draft.state, event);
  if (to === null) throw new IllegalTransitionError(draft.state, event);

  // Belt and braces: the table above should make this unreachable.
  if (isServerState(to)) {
    throw new Error(`Local event '${event}' mapped to server state '${to}' — table is wrong`);
  }

  return {
    ...draft,
    ...patch,
    state: to,
    updatedAt: now,
    // Entering 'uploading' counts as an attempt.
    attemptCount: to === 'uploading' ? draft.attemptCount + 1 : draft.attemptCount,
    // Any forward motion clears a stale error message.
    lastError: to === 'failed' ? (patch.lastError ?? draft.lastError) : null,
    lastErrorRetryable: to === 'failed' ? (patch.lastErrorRetryable ?? true) : false,
  };
}

/**
 * Apply a server-originated event.
 *
 * `serverReceiptId` is mandatory: it is the evidence that a business record
 * actually exists on the other side. Without it we refuse to move.
 */
export function applyServerEvent(
  draft: ReceiptDraft,
  event: ServerEvent,
  serverReceiptId: string,
  now: string,
  patch: Partial<ReceiptDraft> = {},
): ReceiptDraft {
  if (!serverReceiptId) throw new UnprovenServerStateError(event);

  const to = nextServerState(draft.state, event);
  if (to === null) throw new IllegalTransitionError(draft.state, event);

  return {
    ...draft,
    ...patch,
    state: to,
    serverReceiptId,
    updatedAt: now,
    lastServerSyncAt: now,
    lastError: null,
    lastErrorRetryable: false,
  };
}
