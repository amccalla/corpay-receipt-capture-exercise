/**
 * The receipt state machine.
 *
 * This file exists to defend one sentence from the brief:
 *
 *     Never tell the user "confirmed" merely because a local queue accepted it.
 *
 * Everything below is in service of that. The diagram's arrows are asserted one
 * by one, and then the same ground is covered EXHAUSTIVELY by iterating the
 * full (state x event) cross-product, so that a transition added in the future
 * cannot quietly escape the rules: the cross-products are built from the
 * implementation's own exported state lists plus a compile-time-checked event
 * list, never from a hand-picked set of "interesting" cases.
 *
 * Determinism: every timestamp here is a literal. `applyLocalEvent` and
 * `applyServerEvent` take `now` as an argument precisely so no test ever has to
 * reach for a real clock, and there is no randomness in this module at all.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  IllegalTransitionError,
  UnprovenServerStateError,
  applyLocalEvent,
  applyServerEvent,
  canApplyLocal,
  canApplyServer,
  isPending,
  isTerminal,
  nextLocalState,
  nextServerState,
  type LocalEvent,
  type ServerEvent,
} from '../state-machine';
import {
  EMPTY_PROVENANCE,
  LOCAL_STATES,
  SERVER_STATES,
  isServerConfirmed,
  isServerState,
  type ReceiptDraft,
  type ReceiptState,
} from '../types';

// ---------------------------------------------------------------------------
// Fixed clocks and ids
// ---------------------------------------------------------------------------

const T_CREATED = '2026-08-16T09:00:00.000Z';
const T_NOW = '2026-08-16T09:07:31.000Z';
const T_SERVER = '2026-08-16T09:09:04.000Z';

/** Shaped like the fake server's real ids ('rec_1', 'rec_2', ...). */
const SERVER_RECEIPT_ID = 'rec_41';

function makeDraft(state: ReceiptState, overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    localId: 'rcp_QZ3kPl9aWv2mTx8bCd4eFg',
    companyId: 'co_northwind',
    fileUri: 'file:///sandbox/receipts/rcp_QZ3kPl9aWv2mTx8bCd4eFg.jpg',
    fileName: 'receipt.jpg',
    fileMimeType: 'image/jpeg',
    fileSizeBytes: 148_221,
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: 1999,
    currency: 'USD',
    transactionDate: '2026-08-11',
    notes: null,
    state,
    idempotencyKey: `idem_${'A'.repeat(32)}`,
    serverReceiptId: null,
    matchedTransactionId: null,
    pendingMatchTransactionId: null,
    provenance: EMPTY_PROVENANCE,
    lastError: null,
    lastErrorRetryable: false,
    // Deliberately non-zero. An implementation that ASSIGNS 1 when entering
    // 'uploading' instead of incrementing would sail past a fixture that
    // started at 0, and the attempt counter is how the UI and the retry policy
    // tell a first try from a fifth.
    attemptCount: 3,
    createdAt: T_CREATED,
    updatedAt: T_CREATED,
    lastServerSyncAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The universes we iterate over
// ---------------------------------------------------------------------------

/**
 * States come from the implementation's own exports, so adding an eighth state
 * to `types.ts` automatically enlarges every cross-product below.
 */
const ALL_STATES: readonly ReceiptState[] = [...LOCAL_STATES, ...SERVER_STATES];

const ALL_LOCAL_EVENTS = [
  'submitOffline',
  'submitOnline',
  'beginUpload',
  'transferFailed',
  'retryQueued',
  'retryNow',
] as const;

const ALL_SERVER_EVENTS = ['fileAccepted', 'recordCreated', 'dataUncertain', 'correctionAccepted'] as const;

/**
 * Events are string-union types with no runtime enumeration, so the lists above
 * are hand-written — and then pinned in both directions at compile time.
 * `AssertNever<T>` accepts only `never`, so adding a seventh `LocalEvent`
 * without listing it here, or listing a name that no longer exists, fails
 * `npm run typecheck`. Babel strips types when jest runs, so this guard is
 * enforced by tsc; the runtime guard is that every assertion below iterates
 * these arrays rather than naming cases individually.
 */
type AssertNever<T extends never> = T;

export type _AllStatesAreExhaustive = AssertNever<
  Exclude<ReceiptState, (typeof LOCAL_STATES)[number] | (typeof SERVER_STATES)[number]>
>;
export type _AllLocalEventsAreExhaustive = AssertNever<Exclude<LocalEvent, (typeof ALL_LOCAL_EVENTS)[number]>>;
export type _AllLocalEventsAreReal = AssertNever<Exclude<(typeof ALL_LOCAL_EVENTS)[number], LocalEvent>>;
export type _AllServerEventsAreExhaustive = AssertNever<Exclude<ServerEvent, (typeof ALL_SERVER_EVENTS)[number]>>;
export type _AllServerEventsAreReal = AssertNever<Exclude<(typeof ALL_SERVER_EVENTS)[number], ServerEvent>>;

// ---------------------------------------------------------------------------
// The transition table, restated independently of the implementation
// ---------------------------------------------------------------------------

interface LocalRow {
  readonly from: ReceiptState;
  readonly event: LocalEvent;
  readonly to: ReceiptState;
}

interface ServerRow {
  readonly from: ReceiptState;
  readonly event: ServerEvent;
  readonly to: ReceiptState;
}

/** The arrows drawn in the brief's diagram. */
const DIAGRAM_LOCAL: LocalRow[] = [
  { from: 'draft', event: 'submitOffline', to: 'queued' },
  { from: 'draft', event: 'submitOnline', to: 'uploading' },
  { from: 'queued', event: 'beginUpload', to: 'uploading' },
  { from: 'uploading', event: 'transferFailed', to: 'failed' },
  { from: 'failed', event: 'retryQueued', to: 'queued' },
  { from: 'failed', event: 'retryNow', to: 'uploading' },
];

const DIAGRAM_SERVER: ServerRow[] = [
  { from: 'uploading', event: 'fileAccepted', to: 'processing' },
  { from: 'processing', event: 'recordCreated', to: 'confirmed' },
  { from: 'processing', event: 'dataUncertain', to: 'needsReview' },
  { from: 'needsReview', event: 'correctionAccepted', to: 'confirmed' },
];

/**
 * Arrows the app needs that the diagram does not draw. Each one is deliberate,
 * and listing them here rather than in a catch-all is the point: any arrow NOT
 * in this file is asserted to throw.
 */
const EXTRA_LOCAL: LocalRow[] = [
  // A failed receipt is still the user's to resubmit, online or off.
  { from: 'failed', event: 'submitOffline', to: 'queued' },
  { from: 'failed', event: 'submitOnline', to: 'uploading' },
  // The sync engine treats 'failed' as drainable work and picks it back up on
  // the next pass without the user pressing anything.
  { from: 'failed', event: 'beginUpload', to: 'uploading' },
];

const EXTRA_SERVER: ServerRow[] = [
  // One round-trip can skip 'processing' entirely. This is the lost-response
  // case: we retry blind from 'uploading', the server recognises the
  // idempotency key, and replies with the record's CURRENT state — which may
  // already be confirmed or awaiting review.
  { from: 'uploading', event: 'recordCreated', to: 'confirmed' },
  { from: 'uploading', event: 'dataUncertain', to: 'needsReview' },
];

const ALL_LOCAL_ROWS: LocalRow[] = [...DIAGRAM_LOCAL, ...EXTRA_LOCAL];
const ALL_SERVER_ROWS: ServerRow[] = [...DIAGRAM_SERVER, ...EXTRA_SERVER];

function transitionKey(from: ReceiptState, event: string): string {
  return `${from} --${event}-->`;
}

const LEGAL_LOCAL = new Map<string, ReceiptState>(ALL_LOCAL_ROWS.map((r) => [transitionKey(r.from, r.event), r.to]));
const LEGAL_SERVER = new Map<string, ReceiptState>(ALL_SERVER_ROWS.map((r) => [transitionKey(r.from, r.event), r.to]));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Attempt = { kind: 'ok'; draft: ReceiptDraft } | { kind: 'threw'; error: unknown };

function tryLocal(from: ReceiptState, event: LocalEvent, patch: Partial<ReceiptDraft> = {}): Attempt {
  try {
    return { kind: 'ok', draft: applyLocalEvent(makeDraft(from), event, T_NOW, patch) };
  } catch (error: unknown) {
    return { kind: 'threw', error };
  }
}

function tryServer(from: ReceiptState, event: ServerEvent, serverReceiptId: string): Attempt {
  try {
    return { kind: 'ok', draft: applyServerEvent(makeDraft(from), event, serverReceiptId, T_SERVER) };
  } catch (error: unknown) {
    return { kind: 'threw', error };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}` : `non-Error ${String(error)}`;
}

/** Snapshot for mutation checks. Every field on a draft is JSON-representable. */
function snapshot(d: ReceiptDraft): string {
  return JSON.stringify(d);
}

// ---------------------------------------------------------------------------
// Meta-guard: keep the hand-written event lists honest at RUNTIME too
// ---------------------------------------------------------------------------

/**
 * `LocalEvent` and `ServerEvent` are string-union types with no runtime
 * enumeration to import, so the arrays above had to be written out by hand. The
 * `AssertNever` aliases pin them at compile time, but babel strips types, so
 * `npx jest` on its own would never notice a newly added event. This reads the
 * union members straight out of the source text instead, so an event added to
 * the implementation and not to this file fails the SUITE, not just `tsc`.
 */
function unionMembersOf(fileName: string, typeName: string): string[] {
  const source = readFileSync(join(__dirname, '..', fileName), 'utf8')
    // Strip comments first: the doc comments on these unions contain both
    // semicolons and apostrophes, which would otherwise confuse the scan.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const start = source.indexOf(`export type ${typeName} =`);
  if (start === -1) throw new Error(`no 'export type ${typeName}' found in ${fileName}`);
  const end = source.indexOf(';', start);
  if (end === -1) throw new Error(`'export type ${typeName}' in ${fileName} is unterminated`);

  const members = [...source.slice(start, end).matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  if (members.length === 0) throw new Error(`parsed no members out of ${typeName} in ${fileName}`);
  return [...members].sort();
}

describe('the universes this file iterates over', () => {
  it('lists every LocalEvent the implementation declares, and no others', () => {
    expect([...ALL_LOCAL_EVENTS].sort()).toEqual(unionMembersOf('state-machine.ts', 'LocalEvent'));
  });

  it('lists every ServerEvent the implementation declares, and no others', () => {
    expect([...ALL_SERVER_EVENTS].sort()).toEqual(unionMembersOf('state-machine.ts', 'ServerEvent'));
  });

  it('covers every ReceiptState, and classifies each one as either local or server', () => {
    // Also catches a state added to the union but to neither list, which would
    // make both `isLocalState` and `isServerState` quietly return false for it.
    expect([...ALL_STATES].sort()).toEqual(unionMembersOf('types.ts', 'ReceiptState'));
    for (const state of ALL_STATES) {
      expect(isServerState(state) || LOCAL_STATES.includes(state)).toBe(true);
    }
  });
});

// ===========================================================================
// 1. The table this file tests against is itself non-trivial
// ===========================================================================

describe('the transition table under test', () => {
  it('exercises every local event and every local target state', () => {
    expect([...new Set(ALL_LOCAL_ROWS.map((r) => r.event))].sort()).toEqual([...ALL_LOCAL_EVENTS].sort());
    // 'draft' is a start state only: nothing transitions back into it.
    expect([...new Set(ALL_LOCAL_ROWS.map((r) => r.to))].sort()).toEqual(['failed', 'queued', 'uploading']);
  });

  it('exercises every server event and every server target state', () => {
    expect([...new Set(ALL_SERVER_ROWS.map((r) => r.event))].sort()).toEqual([...ALL_SERVER_EVENTS].sort());
    expect([...new Set(ALL_SERVER_ROWS.map((r) => r.to))].sort()).toEqual([
      'confirmed',
      'needsReview',
      'processing',
    ]);
  });

  it('names no transition twice', () => {
    expect(LEGAL_LOCAL.size).toBe(ALL_LOCAL_ROWS.length);
    expect(LEGAL_SERVER.size).toBe(ALL_SERVER_ROWS.length);
  });
});

// ===========================================================================
// 2. Every arrow in the brief's diagram exists and works
// ===========================================================================

describe("the brief's diagram", () => {
  it.each(DIAGRAM_LOCAL)('$from --$event--> $to', ({ from, event, to }) => {
    const result = applyLocalEvent(makeDraft(from), event, T_NOW);
    expect(result.state).toBe(to);
    expect(canApplyLocal(from, event)).toBe(true);
    expect(nextLocalState(from, event)).toBe(to);
  });

  it.each(DIAGRAM_SERVER)('$from --$event--> $to', ({ from, event, to }) => {
    const before = makeDraft(from, {
      // A draft already past the wire normally carries the server's id.
      serverReceiptId: from === 'uploading' ? null : SERVER_RECEIPT_ID,
    });
    const result = applyServerEvent(before, event, SERVER_RECEIPT_ID, T_SERVER);
    expect(result.state).toBe(to);
    expect(result.serverReceiptId).toBe(SERVER_RECEIPT_ID);
    expect(canApplyServer(from, event)).toBe(true);
    expect(nextServerState(from, event)).toBe(to);
  });

  it('walks the happy path end to end: draft -> queued -> uploading -> processing -> confirmed', () => {
    const draft = makeDraft('draft', { attemptCount: 0 });

    const queued = applyLocalEvent(draft, 'submitOffline', T_NOW);
    expect(queued.state).toBe('queued');
    expect(isServerConfirmed(queued)).toBe(false);

    const uploading = applyLocalEvent(queued, 'beginUpload', T_NOW);
    expect(uploading.state).toBe('uploading');
    expect(uploading.attemptCount).toBe(1);

    const processing = applyServerEvent(uploading, 'fileAccepted', SERVER_RECEIPT_ID, T_SERVER);
    expect(processing.state).toBe('processing');
    // Accepting the FILE is not creating the RECORD.
    expect(isServerConfirmed(processing)).toBe(false);

    const confirmed = applyServerEvent(processing, 'recordCreated', SERVER_RECEIPT_ID, T_SERVER);
    expect(confirmed.state).toBe('confirmed');
    expect(isServerConfirmed(confirmed)).toBe(true);
  });

  it('walks the review path: uploading -> processing -> needsReview -> confirmed', () => {
    const uploading = makeDraft('uploading');
    const processing = applyServerEvent(uploading, 'fileAccepted', SERVER_RECEIPT_ID, T_SERVER);
    const needsReview = applyServerEvent(processing, 'dataUncertain', SERVER_RECEIPT_ID, T_SERVER);

    expect(needsReview.state).toBe('needsReview');
    // A receipt the server is unsure about has a server id but is NOT confirmed.
    expect(needsReview.serverReceiptId).toBe(SERVER_RECEIPT_ID);
    expect(isServerConfirmed(needsReview)).toBe(false);

    const confirmed = applyServerEvent(needsReview, 'correctionAccepted', SERVER_RECEIPT_ID, T_SERVER);
    expect(confirmed.state).toBe('confirmed');
    expect(isServerConfirmed(confirmed)).toBe(true);
  });

  it('walks the failure path: uploading -> failed -> queued and uploading -> failed -> uploading', () => {
    const uploading = makeDraft('uploading', { attemptCount: 1 });
    const failed = applyLocalEvent(uploading, 'transferFailed', T_NOW, {
      lastError: 'Network unreachable',
      lastErrorRetryable: true,
    });
    expect(failed.state).toBe('failed');
    expect(failed.lastError).toBe('Network unreachable');

    expect(applyLocalEvent(failed, 'retryQueued', T_NOW).state).toBe('queued');
    expect(applyLocalEvent(failed, 'retryNow', T_NOW).state).toBe('uploading');
  });
});

// ===========================================================================
// 3. THE INVARIANT: a local event can never produce a server state
// ===========================================================================

describe('applyLocalEvent can never produce a server state', () => {
  it('holds for every (state x local event) pair', () => {
    const violations: string[] = [];
    let succeeded = 0;

    for (const from of ALL_STATES) {
      for (const event of ALL_LOCAL_EVENTS) {
        const outcome = tryLocal(from, event);
        if (outcome.kind === 'threw') continue;
        succeeded += 1;
        if (isServerState(outcome.draft.state)) {
          violations.push(`${transitionKey(from, event)} produced server state '${outcome.draft.state}'`);
        }
      }
    }

    expect(violations).toEqual([]);
    // Anti-vacuity: if every pair threw, the loop above would prove nothing.
    expect(succeeded).toBe(ALL_LOCAL_ROWS.length);
  });

  it('holds even when the caller passes a patch that tries to forge one', () => {
    // A careless (or compromised) call site handing the machine a server state
    // and an id must not be able to mint a confirmation. The machine owns
    // `state`; the patch does not.
    const forged: Partial<ReceiptDraft> = {
      state: 'confirmed',
      serverReceiptId: 'rec_forged',
      matchedTransactionId: 'txn_forged',
    };

    const violations: string[] = [];
    for (const row of ALL_LOCAL_ROWS) {
      const result = applyLocalEvent(makeDraft(row.from), row.event, T_NOW, forged);
      if (result.state !== row.to) {
        violations.push(`${transitionKey(row.from, row.event)} patch overrode state -> '${result.state}'`);
      }
      if (isServerConfirmed(result)) {
        violations.push(`${transitionKey(row.from, row.event)} reported server-confirmed from a local event`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never returns a server state from nextLocalState, for any pair', () => {
    for (const from of ALL_STATES) {
      for (const event of ALL_LOCAL_EVENTS) {
        const to = nextLocalState(from, event);
        if (to !== null) expect(isServerState(to)).toBe(false);
      }
    }
  });

  it('never invents a server receipt id', () => {
    for (const row of ALL_LOCAL_ROWS) {
      const result = applyLocalEvent(makeDraft(row.from), row.event, T_NOW);
      expect(result.serverReceiptId).toBeNull();
      expect(result.matchedTransactionId).toBeNull();
    }
  });

  it('refuses to drag a server state back into the local queue', () => {
    // A confirmed or in-flight-on-the-server receipt is not this device's to
    // re-queue; only the server can move it on from here.
    for (const from of SERVER_STATES) {
      for (const event of ALL_LOCAL_EVENTS) {
        expect(() => applyLocalEvent(makeDraft(from), event, T_NOW)).toThrow(IllegalTransitionError);
      }
    }
  });
});

// ===========================================================================
// 4. THE EVIDENCE RULE: no server state without a server receipt id
// ===========================================================================

describe('applyServerEvent demands evidence', () => {
  const LEGAL_SOURCE: Record<ServerEvent, ReceiptState> = {
    fileAccepted: 'uploading',
    recordCreated: 'processing',
    dataUncertain: 'processing',
    correctionAccepted: 'needsReview',
  };

  it.each([...ALL_SERVER_EVENTS])(
    "throws UnprovenServerStateError for '%s' when the server receipt id is empty",
    (event) => {
      const from = LEGAL_SOURCE[event];
      // The transition itself is legal — only the evidence is missing.
      expect(canApplyServer(from, event)).toBe(true);
      expect(() => applyServerEvent(makeDraft(from), event, '', T_SERVER)).toThrow(UnprovenServerStateError);
    },
  );

  it('never returns a draft for an empty id, for any (state x server event) pair', () => {
    const leaks: string[] = [];
    for (const from of ALL_STATES) {
      for (const event of ALL_SERVER_EVENTS) {
        const outcome = tryServer(from, event, '');
        if (outcome.kind === 'ok') {
          leaks.push(`${transitionKey(from, event)} returned state '${outcome.draft.state}' with no evidence`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('leaves the draft untouched when it refuses', () => {
    const before = makeDraft('processing', { serverReceiptId: null });
    const before_json = snapshot(before);

    expect(() => applyServerEvent(before, 'recordCreated', '', T_SERVER)).toThrow(UnprovenServerStateError);

    expect(snapshot(before)).toBe(before_json);
    expect(before.state).toBe('processing');
    expect(isServerConfirmed(before)).toBe(false);
  });

  it('names the event it refused, so the failure is diagnosable', () => {
    try {
      applyServerEvent(makeDraft('needsReview'), 'correctionAccepted', '', T_SERVER);
      throw new Error('expected applyServerEvent to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UnprovenServerStateError);
      expect(error instanceof Error ? error.message : '').toContain('correctionAccepted');
    }
  });

  it('accepts the transition once real evidence is supplied', () => {
    // The mirror image of the tests above: proves the refusals come from the
    // missing id, not from the transitions being broken.
    for (const event of ALL_SERVER_EVENTS) {
      const from = LEGAL_SOURCE[event];
      const result = applyServerEvent(makeDraft(from), event, SERVER_RECEIPT_ID, T_SERVER);
      expect(result.serverReceiptId).toBe(SERVER_RECEIPT_ID);
      expect(isServerState(result.state)).toBe(true);
    }
  });
});

// ===========================================================================
// 5. Illegal transitions throw — exhaustively
// ===========================================================================

describe('illegal transitions', () => {
  it('permits exactly the documented local transitions and throws on every other pair', () => {
    const violations: string[] = [];

    for (const from of ALL_STATES) {
      for (const event of ALL_LOCAL_EVENTS) {
        const key = transitionKey(from, event);
        const expected = LEGAL_LOCAL.get(key);
        const outcome = tryLocal(from, event);

        if (expected === undefined) {
          if (outcome.kind === 'ok') {
            violations.push(`${key} should be illegal but produced '${outcome.draft.state}'`);
          } else if (!(outcome.error instanceof IllegalTransitionError)) {
            violations.push(`${key} threw ${describeError(outcome.error)}, expected IllegalTransitionError`);
          }
        } else if (outcome.kind === 'threw') {
          violations.push(`${key} should be legal but threw ${describeError(outcome.error)}`);
        } else if (outcome.draft.state !== expected) {
          violations.push(`${key} produced '${outcome.draft.state}', expected '${expected}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('permits exactly the documented server transitions and throws on every other pair', () => {
    const violations: string[] = [];

    for (const from of ALL_STATES) {
      for (const event of ALL_SERVER_EVENTS) {
        const key = transitionKey(from, event);
        const expected = LEGAL_SERVER.get(key);
        const outcome = tryServer(from, event, SERVER_RECEIPT_ID);

        if (expected === undefined) {
          if (outcome.kind === 'ok') {
            violations.push(`${key} should be illegal but produced '${outcome.draft.state}'`);
          } else if (!(outcome.error instanceof IllegalTransitionError)) {
            violations.push(`${key} threw ${describeError(outcome.error)}, expected IllegalTransitionError`);
          }
        } else if (outcome.kind === 'threw') {
          violations.push(`${key} should be legal but threw ${describeError(outcome.error)}`);
        } else if (outcome.draft.state !== expected) {
          violations.push(`${key} produced '${outcome.draft.state}', expected '${expected}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('carries the offending state and event on the error', () => {
    try {
      applyLocalEvent(makeDraft('draft'), 'transferFailed', T_NOW);
      throw new Error('expected applyLocalEvent to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      if (!(error instanceof IllegalTransitionError)) return;
      expect(error.from).toBe('draft');
      expect(error.event).toBe('transferFailed');
      expect(error.message).toContain('transferFailed');
      expect(error.message).toContain('draft');
    }
  });

  it('cannot move a confirmed receipt anywhere at all', () => {
    // Confirmation is the end of the line. Nothing re-opens it.
    for (const event of ALL_LOCAL_EVENTS) {
      expect(() => applyLocalEvent(makeDraft('confirmed'), event, T_NOW)).toThrow(IllegalTransitionError);
    }
    for (const event of ALL_SERVER_EVENTS) {
      expect(() => applyServerEvent(makeDraft('confirmed'), event, SERVER_RECEIPT_ID, T_SERVER)).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

// ===========================================================================
// 6. The queries agree with the transitions
// ===========================================================================

describe('canApply / nextState agree with apply', () => {
  it('agrees for every (state x local event) pair', () => {
    const disagreements: string[] = [];
    for (const from of ALL_STATES) {
      for (const event of ALL_LOCAL_EVENTS) {
        const outcome = tryLocal(from, event);
        const predicted = canApplyLocal(from, event);
        const actual = outcome.kind === 'ok';
        if (predicted !== actual) {
          disagreements.push(`${transitionKey(from, event)} canApplyLocal=${predicted} but apply ${actual ? 'succeeded' : 'threw'}`);
        }
        const nextState = nextLocalState(from, event);
        const appliedState = outcome.kind === 'ok' ? outcome.draft.state : null;
        if (nextState !== appliedState) {
          disagreements.push(`${transitionKey(from, event)} nextLocalState=${String(nextState)} but apply gave ${String(appliedState)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('agrees for every (state x server event) pair', () => {
    const disagreements: string[] = [];
    for (const from of ALL_STATES) {
      for (const event of ALL_SERVER_EVENTS) {
        const outcome = tryServer(from, event, SERVER_RECEIPT_ID);
        const predicted = canApplyServer(from, event);
        const actual = outcome.kind === 'ok';
        if (predicted !== actual) {
          disagreements.push(`${transitionKey(from, event)} canApplyServer=${predicted} but apply ${actual ? 'succeeded' : 'threw'}`);
        }
        const nextState = nextServerState(from, event);
        const appliedState = outcome.kind === 'ok' ? outcome.draft.state : null;
        if (nextState !== appliedState) {
          disagreements.push(`${transitionKey(from, event)} nextServerState=${String(nextState)} but apply gave ${String(appliedState)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

// ===========================================================================
// 7. attemptCount
// ===========================================================================

describe('attemptCount', () => {
  it('increments exactly when, and only when, a local event enters uploading', () => {
    const violations: string[] = [];
    for (const row of ALL_LOCAL_ROWS) {
      const before = makeDraft(row.from);
      const after = applyLocalEvent(before, row.event, T_NOW);
      const expectedDelta = row.to === 'uploading' ? 1 : 0;
      const actualDelta = after.attemptCount - before.attemptCount;
      if (actualDelta !== expectedDelta) {
        violations.push(`${transitionKey(row.from, row.event)} delta ${actualDelta}, expected ${expectedDelta}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('counts each retry separately: three attempts leave attemptCount at three', () => {
    let d = makeDraft('draft', { attemptCount: 0 });
    d = applyLocalEvent(d, 'submitOnline', T_NOW);
    expect(d.attemptCount).toBe(1);
    d = applyLocalEvent(d, 'transferFailed', T_NOW, { lastError: 'timeout' });
    expect(d.attemptCount).toBe(1);
    d = applyLocalEvent(d, 'retryNow', T_NOW);
    expect(d.attemptCount).toBe(2);
    d = applyLocalEvent(d, 'transferFailed', T_NOW, { lastError: 'timeout' });
    d = applyLocalEvent(d, 'retryQueued', T_NOW);
    expect(d.attemptCount).toBe(2); // queueing is not an attempt
    d = applyLocalEvent(d, 'beginUpload', T_NOW);
    expect(d.attemptCount).toBe(3);
  });

  it('is never touched by a server event', () => {
    for (const row of ALL_SERVER_ROWS) {
      const before = makeDraft(row.from);
      const after = applyServerEvent(before, row.event, SERVER_RECEIPT_ID, T_SERVER);
      expect(after.attemptCount).toBe(before.attemptCount);
    }
  });

  it('is owned by the machine, not by the caller-supplied patch', () => {
    const before = makeDraft('queued', { attemptCount: 3 });
    const after = applyLocalEvent(before, 'beginUpload', T_NOW, { attemptCount: 99 });
    expect(after.attemptCount).toBe(4);
  });
});

// ===========================================================================
// 8. Error fields
// ===========================================================================

describe('lastError / lastErrorRetryable', () => {
  it('clears the error on entering any non-failed state, and preserves it on entering failed', () => {
    const violations: string[] = [];
    for (const row of ALL_LOCAL_ROWS) {
      const before = makeDraft(row.from, { lastError: 'Upload interrupted', lastErrorRetryable: true });
      const after = applyLocalEvent(before, row.event, T_NOW);

      if (row.to === 'failed') {
        if (after.lastError !== 'Upload interrupted') {
          violations.push(`${transitionKey(row.from, row.event)} dropped the error: ${String(after.lastError)}`);
        }
      } else if (after.lastError !== null || after.lastErrorRetryable !== false) {
        violations.push(
          `${transitionKey(row.from, row.event)} kept a stale error: ${String(after.lastError)} / ${after.lastErrorRetryable}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('preserves a supplied permanent failure as non-retryable', () => {
    // Edge case from the brief: a HEIC too large for the server. Retrying will
    // never help, and the UI must not offer a retry button that cannot work.
    const failed = applyLocalEvent(makeDraft('uploading'), 'transferFailed', T_NOW, {
      lastError: 'File is 12.4 MB; the limit is 10 MB.',
      lastErrorRetryable: false,
    });
    expect(failed.state).toBe('failed');
    expect(failed.lastError).toBe('File is 12.4 MB; the limit is 10 MB.');
    expect(failed.lastErrorRetryable).toBe(false);
  });

  it('assumes a failure is retryable when the caller does not say', () => {
    const failed = applyLocalEvent(makeDraft('uploading'), 'transferFailed', T_NOW, {
      lastError: 'Connection reset',
    });
    expect(failed.lastErrorRetryable).toBe(true);
  });

  it('clears the error on every server event', () => {
    for (const row of ALL_SERVER_ROWS) {
      const before = makeDraft(row.from, { lastError: 'Connection reset', lastErrorRetryable: true });
      const after = applyServerEvent(before, row.event, SERVER_RECEIPT_ID, T_SERVER);
      expect(after.lastError).toBeNull();
      expect(after.lastErrorRetryable).toBe(false);
    }
  });
});

// ===========================================================================
// 9. Timestamps: local motion is not server contact
// ===========================================================================

describe('timestamps', () => {
  it('stamps updatedAt from the injected clock and leaves lastServerSyncAt alone on a local event', () => {
    for (const row of ALL_LOCAL_ROWS) {
      const before = makeDraft(row.from, { lastServerSyncAt: null });
      const after = applyLocalEvent(before, row.event, T_NOW);
      expect(after.updatedAt).toBe(T_NOW);
      // Moving a receipt around this device is not hearing from the server.
      expect(after.lastServerSyncAt).toBeNull();
      expect(after.createdAt).toBe(before.createdAt);
    }
  });

  it('stamps both updatedAt and lastServerSyncAt on a server event', () => {
    for (const row of ALL_SERVER_ROWS) {
      const after = applyServerEvent(makeDraft(row.from), row.event, SERVER_RECEIPT_ID, T_SERVER);
      expect(after.updatedAt).toBe(T_SERVER);
      expect(after.lastServerSyncAt).toBe(T_SERVER);
    }
  });

  it('preserves an earlier lastServerSyncAt across later local motion', () => {
    const synced = makeDraft('uploading', { lastServerSyncAt: T_CREATED });
    const failed = applyLocalEvent(synced, 'transferFailed', T_NOW, { lastError: 'timeout' });
    expect(failed.lastServerSyncAt).toBe(T_CREATED);
    expect(failed.updatedAt).toBe(T_NOW);
  });
});

// ===========================================================================
// 10. Purity
// ===========================================================================

describe('purity', () => {
  it('never mutates the draft it was given', () => {
    for (const row of ALL_LOCAL_ROWS) {
      const before = makeDraft(row.from);
      const json = snapshot(before);
      const after = applyLocalEvent(before, row.event, T_NOW, { lastError: 'x' });
      expect(snapshot(before)).toBe(json);
      expect(after).not.toBe(before);
    }
    for (const row of ALL_SERVER_ROWS) {
      const before = makeDraft(row.from);
      const json = snapshot(before);
      const after = applyServerEvent(before, row.event, SERVER_RECEIPT_ID, T_SERVER);
      expect(snapshot(before)).toBe(json);
      expect(after).not.toBe(before);
    }
  });

  it('carries the identity and idempotency key through unchanged', () => {
    // The key is what stops a retry becoming a duplicate; the machine must not
    // rotate or drop it on any transition.
    const before = makeDraft('failed');
    for (const event of ['submitOffline', 'submitOnline', 'beginUpload', 'retryQueued', 'retryNow'] as const) {
      const after = applyLocalEvent(before, event, T_NOW);
      expect(after.localId).toBe(before.localId);
      expect(after.companyId).toBe(before.companyId);
      expect(after.idempotencyKey).toBe(before.idempotencyKey);
    }
    const advanced = applyServerEvent(makeDraft('uploading'), 'fileAccepted', SERVER_RECEIPT_ID, T_SERVER);
    expect(advanced.localId).toBe(before.localId);
    expect(advanced.companyId).toBe(before.companyId);
    expect(advanced.idempotencyKey).toBe(before.idempotencyKey);
  });

  it('lets a server event apply metadata via the patch without letting it forge the state', () => {
    const after = applyServerEvent(makeDraft('uploading'), 'fileAccepted', SERVER_RECEIPT_ID, T_SERVER, {
      state: 'confirmed',
      serverReceiptId: 'rec_forged',
      matchedTransactionId: 'txn_7',
    });
    expect(after.state).toBe('processing');
    expect(after.serverReceiptId).toBe(SERVER_RECEIPT_ID);
    expect(after.matchedTransactionId).toBe('txn_7');
    expect(isServerConfirmed(after)).toBe(false);
  });
});

// ===========================================================================
// 11. isServerConfirmed — the most important predicate in the app
// ===========================================================================

describe('isServerConfirmed', () => {
  it('refuses a draft that says confirmed but has no server receipt id', () => {
    // This object is impossible by design and constructed here on purpose. It
    // is what a bug — a bad migration, a hand-edited row, a future code path
    // that writes `state: 'confirmed'` directly — would look like on disk. The
    // predicate is the last line of defence, and it must not believe the state
    // field alone. Telling a user their receipt is filed when no server record
    // exists is the single worst failure this app can have.
    const impossible = makeDraft('confirmed', { serverReceiptId: null });

    expect(impossible.state).toBe('confirmed');
    expect(impossible.serverReceiptId).toBeNull();
    expect(isServerConfirmed(impossible)).toBe(false);
  });

  it('accepts only the state and the evidence together', () => {
    expect(isServerConfirmed(makeDraft('confirmed', { serverReceiptId: SERVER_RECEIPT_ID }))).toBe(true);
    expect(isServerConfirmed(makeDraft('confirmed', { serverReceiptId: null }))).toBe(false);
  });

  it('is false for every non-confirmed state, even when a server receipt id exists', () => {
    // 'processing' and 'needsReview' both carry a real server id. Neither is a
    // confirmation: the record exists but the work is not done.
    for (const state of ALL_STATES) {
      if (state === 'confirmed') continue;
      const withEvidence = makeDraft(state, { serverReceiptId: SERVER_RECEIPT_ID });
      expect(isServerConfirmed(withEvidence)).toBe(false);
    }
  });

  it('is false for every draft reachable by any sequence of local events', () => {
    // Breadth-first over the local sub-graph, starting from a fresh draft. No
    // matter how the user submits, fails and retries — with or without a
    // forged patch — the app can never end up calling a receipt confirmed.
    const patches: Partial<ReceiptDraft>[] = [{}, { state: 'confirmed', serverReceiptId: 'rec_forged' }];

    for (const patch of patches) {
      const seen = new Set<ReceiptState>(['draft']);
      const frontier: ReceiptDraft[] = [makeDraft('draft')];

      while (frontier.length > 0) {
        const current = frontier.pop();
        if (current === undefined) break;
        expect(isServerConfirmed(current)).toBe(false);
        expect(isServerState(current.state)).toBe(false);

        for (const event of ALL_LOCAL_EVENTS) {
          if (!canApplyLocal(current.state, event)) continue;
          const next = applyLocalEvent(current, event, T_NOW, patch);
          if (seen.has(next.state)) continue;
          seen.add(next.state);
          frontier.push(next);
        }
      }

      // Anti-vacuity: the walk really did reach all four local states.
      expect([...seen].sort()).toEqual([...LOCAL_STATES].sort());
    }
  });

  it('becomes true only after a server event that supplies evidence', () => {
    const uploading = makeDraft('uploading');
    expect(isServerConfirmed(uploading)).toBe(false);

    const confirmed = applyServerEvent(uploading, 'recordCreated', SERVER_RECEIPT_ID, T_SERVER);
    expect(isServerConfirmed(confirmed)).toBe(true);
    expect(confirmed.serverReceiptId).toBe(SERVER_RECEIPT_ID);
  });
});

// ===========================================================================
// 12. isPending / isTerminal
// ===========================================================================

describe('isPending / isTerminal', () => {
  const PENDING: ReceiptState[] = ['queued', 'uploading', 'processing'];
  const TERMINAL: ReceiptState[] = ['confirmed'];

  it('marks exactly the states where the app still owes the server work', () => {
    for (const state of ALL_STATES) {
      expect(isPending(state)).toBe(PENDING.includes(state));
    }
  });

  it('marks exactly the states where nothing further will happen unaided', () => {
    for (const state of ALL_STATES) {
      expect(isTerminal(state)).toBe(TERMINAL.includes(state));
    }
  });

  it('never calls a state both pending and terminal', () => {
    for (const state of ALL_STATES) {
      expect(isPending(state) && isTerminal(state)).toBe(false);
    }
  });

  it('leaves draft, failed and needsReview as neither: they are waiting on a human', () => {
    for (const state of ['draft', 'failed', 'needsReview'] as const) {
      expect(isPending(state)).toBe(false);
      expect(isTerminal(state)).toBe(false);
    }
  });

  it('does not treat a locally confirmed-looking draft as pending work', () => {
    // Guards the pairing the sync engine relies on: it drains pending states,
    // and a draft it has finished with must not be re-picked up forever.
    const confirmed = applyServerEvent(makeDraft('uploading'), 'recordCreated', SERVER_RECEIPT_ID, T_SERVER);
    expect(isPending(confirmed.state)).toBe(false);
    expect(isTerminal(confirmed.state)).toBe(true);
  });
});
