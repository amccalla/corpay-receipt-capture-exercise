/**
 * The sync engine — drains queued receipts to the server.
 *
 * This is where most of the brief's non-negotiables are actually enforced, so
 * the rules are stated up front:
 *
 * 1. NEVER CLAIM CONFIRMATION THE SERVER DID NOT GIVE.
 *    The engine only ever moves a draft into a server state via
 *    `applyServerEvent`, which demands a server receipt id. There is no code
 *    path here that writes `state: 'confirmed'` directly.
 *
 * 2. ONE LOGICAL SUBMISSION, ONE RECORD.
 *    A retry reuses the draft's existing idempotency key. Combined with the
 *    server's (companyId, idempotencyKey) dedupe, retrying after an ambiguous
 *    failure returns the ORIGINAL record instead of creating a second one.
 *    This is what makes the "upload succeeded but the response was lost" case
 *    safe: we retry blind, and the server tells us what really happened.
 *
 * 3. A DRAFT IS UPLOADED UNDER ITS OWN COMPANY OR NOT AT ALL.
 *    The company is re-checked immediately before the request goes out, not
 *    just when the pass started, because the user can switch tenants mid-flight.
 *    The server enforces the same rule independently and we do not trust
 *    ourselves to be the only guard.
 */

import { applyLocalEvent, applyServerEvent, type ServerEvent } from '../domain/state-machine';
import type { Instant, ReceiptDraft, ReceiptMetadata } from '../domain/types';
import { safeStorageKey } from '../domain/validation';
import type { ReceiptStore } from '../data/store';
import type { SessionManager } from '../data/session';
import type { FakeServer, ServerErrorCode, SubmitReceiptResponse } from '../server/fake-server';

export interface SyncDeps {
  readonly store: ReceiptStore;
  readonly session: SessionManager;
  readonly server: FakeServer;
  /** Injected clock — keeps the engine deterministic under test. */
  readonly now: () => Instant;
}

export type SyncSkipReason =
  | 'NOT_SUBMITTABLE'
  | 'NO_SESSION'
  | 'COMPANY_CHANGED'
  | 'AUTH_EXPIRED'
  | 'MISSING_FILE';

export type SyncOutcome =
  | { kind: 'advanced'; draft: ReceiptDraft; deduped: boolean }
  | { kind: 'failed'; draft: ReceiptDraft; code: ServerErrorCode; retryable: boolean }
  | { kind: 'skipped'; localId: string; reason: SyncSkipReason };

export interface SyncReport {
  readonly companyId: string;
  readonly attempted: number;
  readonly advanced: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outcomes: SyncOutcome[];
}

/** Server states map one-to-one onto the diagram's server-originated events. */
const SERVER_STATE_TO_EVENT: Record<string, ServerEvent> = {
  processing: 'fileAccepted',
  confirmed: 'recordCreated',
  needsReview: 'dataUncertain',
};

/** States the engine is willing to pick up and push. */
const SUBMITTABLE = new Set(['queued', 'failed', 'uploading']);

export class SyncEngine {
  constructor(private readonly deps: SyncDeps) {}

  private metadataOf(d: ReceiptDraft): ReceiptMetadata {
    return {
      vendor: d.vendor,
      amountMinorUnits: d.amountMinorUnits,
      currency: d.currency,
      transactionDate: d.transactionDate,
      notes: d.notes,
    };
  }

  /**
   * Push a single draft as far as the server will take it.
   *
   * `companyId` is the company the CALLER believes is active. Everything is
   * scoped to it, and it is re-validated against the live session immediately
   * before the request.
   */
  async syncOne(companyId: string, localId: string): Promise<SyncOutcome> {
    const { store, session, server, now } = this.deps;

    // Company-scoped read: a draft belonging to another tenant is simply not
    // visible here, so there is no way to proceed with one by accident.
    const draft = await store.get(companyId, localId);
    if (!draft) return { kind: 'skipped', localId, reason: 'COMPANY_CHANGED' };

    if (!SUBMITTABLE.has(draft.state)) {
      return { kind: 'skipped', localId, reason: 'NOT_SUBMITTABLE' };
    }
    if (!draft.fileUri) {
      return { kind: 'skipped', localId, reason: 'MISSING_FILE' };
    }

    // THE GUARD. Re-read the session now, not at the start of the pass. If the
    // user switched company or the token lapsed while earlier drafts were
    // uploading, we get null and stop here.
    const at = now();
    const token = session.getTokenForCompany(draft.companyId, at);
    if (!token) {
      const active = session.getCompanyId();
      const reason: SyncSkipReason =
        active === null ? 'NO_SESSION' : active !== draft.companyId ? 'COMPANY_CHANGED' : 'AUTH_EXPIRED';

      // Park it back in the queue rather than marking it failed: nothing is
      // wrong with the receipt, the session is just not currently entitled to
      // send it. It will go out when the right company signs back in.
      if (draft.state === 'uploading') {
        const parked = applyLocalEvent(draft, 'transferFailed', at, {
          lastError:
            reason === 'COMPANY_CHANGED'
              ? 'Paused: this receipt belongs to a different company. Switch back to submit it.'
              : 'Paused: your session expired. Sign in again to submit.',
          lastErrorRetryable: true,
        });
        await store.update(companyId, parked);
      }
      return { kind: 'skipped', localId, reason };
    }

    // Move to 'uploading' so the UI shows motion and the attempt is counted.
    let working = draft.state === 'uploading' ? draft : applyLocalEvent(draft, 'beginUpload', at);
    await store.update(companyId, working);

    const response: SubmitReceiptResponse = await server.submitReceipt({
      // Reused, never regenerated, on every retry of this draft. This single
      // line is what prevents duplicate records.
      idempotencyKey: working.idempotencyKey,
      companyId: working.companyId,
      authToken: token,
      file: {
        storageKey: safeStorageKey(working.companyId, working.localId, working.fileMimeType ?? 'application/octet-stream'),
        mime: working.fileMimeType ?? 'application/octet-stream',
        sizeBytes: working.fileSizeBytes ?? 0,
      },
      metadata: this.metadataOf(working),
      matchTransactionId: working.pendingMatchTransactionId,
    });

    const after = now();

    if (!response.ok) {
      const failed = applyLocalEvent(working, 'transferFailed', after, {
        lastError: response.message,
        lastErrorRetryable: response.retryable,
      });
      await store.update(companyId, failed);
      return { kind: 'failed', draft: failed, code: response.code, retryable: response.retryable };
    }

    // The server spoke. Its state is the truth; ours was only ever a guess.
    const event = SERVER_STATE_TO_EVENT[response.receipt.state];
    if (!event) {
      const failed = applyLocalEvent(working, 'transferFailed', after, {
        lastError: `Server returned an unrecognised state '${response.receipt.state}'`,
        lastErrorRetryable: false,
      });
      await store.update(companyId, failed);
      return { kind: 'failed', draft: failed, code: 'SERVER_ERROR', retryable: false };
    }

    working = applyServerEvent(working, event, response.receipt.id, after, {
      matchedTransactionId: response.receipt.matchedTransactionId,
      // The local "I want to match this" intent is satisfied once the server
      // has recorded it; clearing it stops us re-sending a match that stuck.
      pendingMatchTransactionId:
        response.receipt.matchedTransactionId === working.pendingMatchTransactionId
          ? null
          : working.pendingMatchTransactionId,
    });
    await store.update(companyId, working);

    return { kind: 'advanced', draft: working, deduped: response.deduped };
  }

  /**
   * Drain everything this company still owes the server.
   *
   * Sequential on purpose. Parallel uploads would make ordering and error
   * attribution much harder to reason about, and the company guard would have
   * to be re-argued for every in-flight request. A mobile client queueing a
   * handful of receipts does not need the throughput.
   */
  async syncAll(companyId: string): Promise<SyncReport> {
    const pending = await this.deps.store.listByState(companyId, ['queued', 'failed', 'uploading']);

    const outcomes: SyncOutcome[] = [];
    for (const d of pending) {
      // A permanently-rejected draft (too large, wrong type) is not retried
      // automatically — retrying cannot change the outcome and would just burn
      // battery. The user gets an explicit action in the UI instead.
      if (d.state === 'failed' && !d.lastErrorRetryable) {
        outcomes.push({ kind: 'skipped', localId: d.localId, reason: 'NOT_SUBMITTABLE' });
        continue;
      }

      const outcome = await this.syncOne(companyId, d.localId);
      outcomes.push(outcome);

      // Session problems affect every remaining draft identically, so stop
      // rather than generating N identical failures.
      if (outcome.kind === 'skipped' && (outcome.reason === 'NO_SESSION' || outcome.reason === 'COMPANY_CHANGED')) {
        break;
      }
      if (outcome.kind === 'failed' && outcome.code === 'AUTH_EXPIRED') {
        break;
      }
    }

    return {
      companyId,
      attempted: outcomes.length,
      advanced: outcomes.filter((o) => o.kind === 'advanced').length,
      failed: outcomes.filter((o) => o.kind === 'failed').length,
      skipped: outcomes.filter((o) => o.kind === 'skipped').length,
      outcomes,
    };
  }
}
