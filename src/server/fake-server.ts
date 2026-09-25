/**
 * In-process fake of the receipt backend.
 *
 * The point of this module is not to pretend to be a server. It is to make
 * every failure the app claims to survive reproducible on demand: a failure
 * path you cannot trigger is a failure path you have not tested. Hence
 * `setFailureInjection` — one switch that turns each edge case from the brief
 * into a deterministic, repeatable request.
 *
 * Purity: no I/O, no timers, no Date.now(), no Math.random(). Time enters
 * through the injected `now()` clock; identity comes from an internal counter,
 * so receipt ids are 'rec_1', 'rec_2', ... in creation order. Methods are
 * async only because the real thing would be.
 *
 * THE FOUR SEMANTICS THAT MATTER HERE
 *
 * 1. IDEMPOTENCY is keyed by (companyId, idempotencyKey), never by the body.
 *    A replay returns the ORIGINAL record with deduped:true and creates
 *    nothing. This holds even when the response was lost in flight — under
 *    'lostSuccessResponse' the record really is created and the caller really
 *    does get an error, which is the only honest model of edge case 1.
 *
 * 2. THE COMPANY BOUNDARY IS ENFORCED SERVER-SIDE. A token carries exactly one
 *    companyId. The client's own guard is good manners; this is the actual
 *    invariant. A queued receipt replayed under another company's token is
 *    rejected, not silently re-homed.
 *
 * 3. A TRANSACTION HOLDS AT MOST ONE RECEIPT. Claiming one that another
 *    receipt already holds is permanent, not transient — retrying cannot help,
 *    so retryable is false and the user must pick a different transaction.
 *
 * 4. OCR NEVER OVERWRITES A HUMAN. Extraction fills holes in the submitted
 *    metadata and nothing else, so a late reading cannot clobber the vendor
 *    and amount the user just corrected.
 */

import type { Instant, Receipt, ReceiptMetadata, ServerState, Transaction } from '../domain/types';
import { extractFromReceipt, isLowConfidence, type OcrResult } from './ocr';
import { MEMBERSHIPS, seedTransactions } from './seed';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type NetworkMode = 'online' | 'offline';

export type FailureInjection =
  | 'none'
  /** Record IS created; the caller gets TRANSFER_INTERRUPTED. Edge case 1. */
  | 'lostSuccessResponse'
  /** Token dies mid-flight even though it was valid at send time. Edge case 2. */
  | 'authExpired'
  /** Bytes never fully arrived; nothing was created. */
  | 'transferInterrupted'
  /** Server-side size rejection regardless of the declared size. Edge case 4. */
  | 'fileTooLarge'
  /** Server-side type rejection, e.g. a deployment that will not take HEIC. */
  | 'unsupportedType'
  /**
   * The file is accepted and the record created, but the reading is too
   * uncertain to confirm — so the receipt lands in needsReview. Injectable
   * because the path must be demonstrable on demand rather than waiting for an
   * unlucky storage key.
   */
  | 'uncertainReading'
  | 'serverError';

export type ServerErrorCode =
  | 'NETWORK_OFFLINE'
  | 'AUTH_EXPIRED'
  | 'TRANSFER_INTERRUPTED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'COMPANY_MISMATCH'
  /** The user is not a member of the company they asked to act for. */
  | 'NOT_A_MEMBER'
  | 'TRANSACTION_ALREADY_MATCHED'
  | 'SERVER_ERROR';

export interface SubmitReceiptRequest {
  readonly idempotencyKey: string;
  readonly companyId: string;
  readonly authToken: string;
  readonly file: { readonly storageKey: string; readonly mime: string; readonly sizeBytes: number };
  readonly metadata: ReceiptMetadata;
  readonly matchTransactionId: string | null;
}

export type SubmitReceiptResponse =
  | { ok: true; receipt: Receipt; deduped: boolean }
  | { ok: false; code: ServerErrorCode; message: string; retryable: boolean };

/**
 * Thrown by the read endpoints, whose return types have no error channel.
 * `submitReceipt` and `confirmCorrections` report failure in-band instead,
 * because for a write the caller must handle the error to stay correct and an
 * exception is too easy to let escape a background task.
 */
export class FakeServerError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FakeServerError';
  }
}

/** 10 MiB. Exported so the client can reject a huge HEIC before spending the upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * What this deployment will accept. HEIC is on the list — phones produce it —
 * but the 'unsupportedType' injection exists because some deployments are not
 * so generous, and the app has to cope with that answer too.
 */
export const ACCEPTED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
];

/** Default clock. A fixed instant, so nothing in this module drifts between runs. */
export const DEFAULT_NOW_ISO: Instant = '2026-08-16T09:00:00.000Z';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface TokenRecord {
  readonly userId: string;
  readonly companyId: string;
  /** Epoch ms. A token is dead once the injected clock reaches this. */
  readonly expiresAtMs: number;
}

type AuthOutcome =
  | { ok: true; token: TokenRecord }
  | { ok: false; code: 'AUTH_EXPIRED' | 'COMPANY_MISMATCH'; message: string; retryable: boolean };

/**
 * Parse an ISO instant to epoch ms. Date.parse is a pure function of its
 * argument — no ambient clock is read — so this does not break the module's
 * determinism.
 */
function instantToMs(iso: Instant): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Injected clock returned a non-ISO instant: ${iso}`);
  return ms;
}

/** Unambiguous composite key; JSON.stringify makes delimiter collisions impossible. */
function idemKey(companyId: string, key: string): string {
  return JSON.stringify([companyId, key]);
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Reject metadata whose money or date semantics are wrong at the boundary.
 *
 * A server that accepts 19.99 as "minor units", or '2026-2-30' as a calendar
 * date, has already lost the argument about explicit semantics. Returns a
 * message, or null when the metadata is well-formed.
 */
function validateMetadata(md: ReceiptMetadata): string | null {
  if (md.amountMinorUnits !== null) {
    if (!Number.isSafeInteger(md.amountMinorUnits)) {
      return 'amountMinorUnits must be an integer count of minor units, not a decimal amount';
    }
    if (md.amountMinorUnits < 0) return 'amountMinorUnits must not be negative';
  }
  if (md.currency !== null && !CURRENCY_RE.test(md.currency)) {
    return `currency must be an uppercase ISO 4217 alphabetic code, got '${md.currency}'`;
  }
  if (md.transactionDate !== null) {
    const m = DATE_ONLY_RE.exec(md.transactionDate);
    if (m === null) return `transactionDate must be 'YYYY-MM-DD', got '${md.transactionDate}'`;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      return `transactionDate is not a real calendar date: '${md.transactionDate}'`;
    }
  }
  return null;
}

/**
 * The untrusted-input boundary for file references.
 *
 * The client's URI is a hint about a blob, never a path the server will honour.
 * Traversal segments are dropped, the character set is narrowed, and the result
 * is length-capped. IN PRODUCTION this is where the rest of the boundary lives:
 * the bytes land in a quarantine bucket under a server-minted key, get a real
 * content-type sniff (a declared 'image/jpeg' proves nothing), a decode-bomb
 * and dimension check, an AV/CDR pass, and EXIF stripping; only then are they
 * promoted to the durable bucket and made readable by the OCR worker. Nothing
 * downstream ever sees the client's filename.
 */
function sanitizeStorageKey(raw: string): string {
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  return segments
    .join('/')
    .replace(/[^A-Za-z0-9._/-]/g, '_')
    .slice(0, 128);
}

/**
 * Fill holes only. A non-null value in `md` came from a human and wins
 * permanently; OCR is allowed to supply what the human left blank and nothing
 * more. This is the server half of edge case 5 — the client tracks provenance,
 * but the server must not be the thing that clobbers the correction.
 */
function mergeOcrIntoMetadata(md: ReceiptMetadata, ocr: OcrResult): ReceiptMetadata {
  return {
    vendor: md.vendor ?? ocr.vendor,
    amountMinorUnits: md.amountMinorUnits ?? ocr.amountMinorUnits,
    currency: md.currency ?? ocr.currency,
    transactionDate: md.transactionDate ?? ocr.transactionDate,
    notes: md.notes,
  };
}

/**
 * Apply a correction. A null field means "not supplied", so it leaves the
 * stored value alone; it does NOT mean "erase". The uniform rule matters more
 * than the convenience of clearing: under the other reading, confirming a
 * receipt would silently wipe every field the user never touched.
 */
function applyCorrections(existing: ReceiptMetadata, md: ReceiptMetadata): ReceiptMetadata {
  return {
    vendor: md.vendor ?? existing.vendor,
    amountMinorUnits: md.amountMinorUnits ?? existing.amountMinorUnits,
    currency: md.currency ?? existing.currency,
    transactionDate: md.transactionDate ?? existing.transactionDate,
    notes: md.notes ?? existing.notes,
  };
}

function metadataEquals(a: ReceiptMetadata, b: ReceiptMetadata): boolean {
  return (
    a.vendor === b.vendor &&
    a.amountMinorUnits === b.amountMinorUnits &&
    a.currency === b.currency &&
    a.transactionDate === b.transactionDate &&
    a.notes === b.notes
  );
}

function fail(
  code: ServerErrorCode,
  message: string,
  retryable: boolean,
): { ok: false; code: ServerErrorCode; message: string; retryable: boolean } {
  return { ok: false, code, message, retryable };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export class FakeServer {
  private readonly now: () => Instant;

  private receipts = new Map<string, Receipt>();
  private transactions = new Map<string, Transaction>();
  private tokens = new Map<string, TokenRecord>();
  /** (companyId, idempotencyKey) -> receipt id. The whole of edge case 1. */
  private idempotency = new Map<string, string>();

  private receiptCounter = 0;
  private tokenCounter = 0;

  private networkMode: NetworkMode = 'online';
  private failure: FailureInjection = 'none';

  private readonly ocrSeed: number | undefined;

  constructor(opts?: { now?: () => Instant; ocrSeed?: number }) {
    this.now = opts?.now ?? (() => DEFAULT_NOW_ISO);
    this.ocrSeed = opts?.ocrSeed;
    this.loadSeeds();
  }

  // --- control surface ----------------------------------------------------

  setNetworkMode(m: NetworkMode): void {
    this.networkMode = m;
  }

  setFailureInjection(f: FailureInjection): void {
    this.failure = f;
  }

  /**
   * Mint a token. Deterministic ids ('tok_1', ...) — the value is opaque and
   * the client must never parse it; the company binding lives here, server
   * side, which is the point.
   */
  /**
   * Whether this user may act for this company at all.
   *
   * Membership lives HERE, server-side, and is the authority. The client may
   * use `isMember` to avoid offering an action that will fail, but a client
   * that asks anyway is refused — possession of a button, a deep link or a
   * cached record is not authorization.
   */
  isMember(userId: string, companyId: string): boolean {
    return MEMBERSHIPS.some((m) => m.userId === userId && m.companyId === companyId);
  }

  /**
   * Mint a token, but only for a company this user actually belongs to.
   *
   * Without this check the tenancy story had a hole big enough to walk through:
   * every downstream guard compares a request's company against the TOKEN's
   * company, so a token minted for a company the user was never a member of
   * would have passed every one of them. The seeded memberships are
   * deliberately asymmetric — Dana belongs to both companies, Kim only to
   * Northwind, Sam only to Acme — so the refusal is demonstrable, not theoretical.
   */
  issueToken(userId: string, companyId: string, ttlMs: number): string {
    if (!this.isMember(userId, companyId)) {
      throw new FakeServerError(
        'NOT_A_MEMBER',
        `${userId} is not a member of ${companyId}.`,
        false,
      );
    }
    this.tokenCounter += 1;
    const token = `tok_${this.tokenCounter}`;
    this.tokens.set(token, {
      userId,
      companyId,
      expiresAtMs: instantToMs(this.now()) + ttlMs,
    });
    return token;
  }

  /**
   * Kill a token without moving the clock — a logout, a revocation, or just a
   * test that wants AUTH_EXPIRED right now. Unknown tokens are ignored: the
   * caller's intent (this token must not work) is already satisfied.
   */
  expireToken(token: string): void {
    const existing = this.tokens.get(token);
    if (existing === undefined) return;
    this.tokens.set(token, { ...existing, expiresAtMs: instantToMs(this.now()) });
  }

  reset(): void {
    this.receipts = new Map();
    this.tokens = new Map();
    this.idempotency = new Map();
    this.receiptCounter = 0;
    // NOTE: tokenCounter is deliberately NOT reset. Receipt ids restart at
    // rec_1 because tests assert on them, but recycling token ids would let a
    // token captured before a reset silently authenticate after it — the exact
    // class of bug this fake exists to catch.
    this.networkMode = 'online';
    this.failure = 'none';
    this.loadSeeds();
  }

  // --- writes -------------------------------------------------------------

  async submitReceipt(req: SubmitReceiptRequest): Promise<SubmitReceiptResponse> {
    // 1. The request never leaves the device.
    if (this.networkMode === 'offline') {
      return fail('NETWORK_OFFLINE', 'No connectivity; request was not sent.', true);
    }

    // 2. The body never finished arriving, so nothing was created. Checked
    //    before auth and before the idempotency lookup because a truncated
    //    request is not a request.
    if (this.failure === 'transferInterrupted') {
      return fail('TRANSFER_INTERRUPTED', 'Connection closed before the upload completed.', true);
    }

    // 3. Auth, and the company boundary, before anything is read or returned.
    //    A replay under the wrong company must not be able to read back
    //    another tenant's receipt.
    const auth = this.authorize(req.authToken, req.companyId);
    if (!auth.ok) return fail(auth.code, auth.message, auth.retryable);

    // 4. Idempotency. The key identifies the INTENT; the body is not consulted.
    //    If the user meaningfully changes what they are submitting, the client
    //    rotates the key (see ReceiptDraft.idempotencyKey) — a replay carrying
    //    a different match is still a replay, and still creates nothing.
    const stored = this.idempotency.get(idemKey(req.companyId, req.idempotencyKey));
    if (stored !== undefined) {
      const original = this.receipts.get(stored);
      if (original === undefined) {
        return fail('SERVER_ERROR', `Dangling idempotency record for ${stored}.`, true);
      }
      // The response is lost again. The record is untouched — which is exactly
      // why the retry after this one is still safe.
      if (this.failure === 'lostSuccessResponse') {
        return fail(
          'TRANSFER_INTERRUPTED',
          'Connection closed after the server committed; the receipt already exists.',
          true,
        );
      }
      // Note what did NOT happen here: no TRANSACTION_ALREADY_MATCHED, even
      // though this receipt now holds the transaction it is asking for. A
      // receipt re-asserting its own match is not a conflict.
      return { ok: true, receipt: original, deduped: true };
    }

    // 5. File validation. Permanent rejections are marked non-retryable so the
    //    sync engine stops burning battery on them.
    const fileError = this.validateFile(req.file);
    if (fileError !== null) return fileError;

    const metadataError = validateMetadata(req.metadata);
    if (metadataError !== null) {
      // The enum has no VALIDATION code; a malformed body is not retryable
      // whatever we call it, and the message says what is actually wrong.
      return fail('SERVER_ERROR', metadataError, false);
    }

    if (this.failure === 'serverError') {
      return fail('SERVER_ERROR', 'Upstream failure; nothing was committed.', true);
    }

    // 6. Matching, before the record exists — so a rejected match leaves no
    //    orphan receipt behind.
    if (req.matchTransactionId !== null) {
      const matchError = this.validateMatch(req.matchTransactionId, req.companyId, null);
      if (matchError !== null) return matchError;
    }

    // 7. Commit.
    this.receiptCounter += 1;
    const id = `rec_${this.receiptCounter}`;
    const safeKey = sanitizeStorageKey(req.file.storageKey);
    const ocr = extractFromReceipt(
      safeKey,
      this.ocrSeed === undefined ? undefined : { seed: this.ocrSeed },
    );
    const metadata = mergeOcrIntoMetadata(req.metadata, ocr);

    // The fake collapses the upload/extract window: a real deployment would
    // return 'processing' here and push the terminal state later. The state
    // machine still models 'processing', and the client must not assume the
    // response is always terminal.
    const state: ServerState =
      this.failure === 'uncertainReading' || isLowConfidence(ocr) ? 'needsReview' : 'confirmed';

    const receipt: Receipt = {
      id,
      companyId: req.companyId,
      // Server-minted. The client's URI never becomes a server path.
      storageKey: `receipts/${req.companyId}/${id}/${safeKey}`,
      metadata,
      state,
      createdBy: auth.token.userId,
      createdAt: this.now(),
      matchedTransactionId: req.matchTransactionId,
    };

    this.receipts.set(id, receipt);
    this.idempotency.set(idemKey(req.companyId, req.idempotencyKey), id);
    if (req.matchTransactionId !== null) this.claimTransaction(req.matchTransactionId, id);

    // 8. The record is committed and the caller is about to be told nothing of
    //    the sort. This is the honest shape of edge case 1: the retry that
    //    follows lands on the replay branch above and gets this same receipt.
    if (this.failure === 'lostSuccessResponse') {
      return fail(
        'TRANSFER_INTERRUPTED',
        'Connection closed after the server committed; retry is safe.',
        true,
      );
    }

    return { ok: true, receipt, deduped: false };
  }

  /**
   * Accept a human's corrections on a receipt that needed review.
   *
   * File-shaped injections ('fileTooLarge', 'unsupportedType') are ignored
   * here — there is no file in this request and pretending otherwise would be
   * a fake that lies.
   */
  async confirmCorrections(
    receiptId: string,
    companyId: string,
    authToken: string,
    md: ReceiptMetadata,
  ): Promise<SubmitReceiptResponse> {
    if (this.networkMode === 'offline') {
      return fail('NETWORK_OFFLINE', 'No connectivity; corrections were not sent.', true);
    }
    if (this.failure === 'transferInterrupted') {
      return fail('TRANSFER_INTERRUPTED', 'Connection closed before the request completed.', true);
    }

    const auth = this.authorize(authToken, companyId);
    if (!auth.ok) return fail(auth.code, auth.message, auth.retryable);

    if (this.failure === 'serverError') {
      return fail('SERVER_ERROR', 'Upstream failure; nothing was committed.', true);
    }

    const existing = this.receipts.get(receiptId);
    // Unknown and foreign are answered identically on purpose: confirming that
    // some other tenant owns this id is itself a leak.
    if (existing === undefined || existing.companyId !== companyId) {
      return fail(
        'COMPANY_MISMATCH',
        `Receipt '${receiptId}' is not available to company '${companyId}'.`,
        false,
      );
    }

    const metadataError = validateMetadata(md);
    if (metadataError !== null) return fail('SERVER_ERROR', metadataError, false);

    const next = applyCorrections(existing.metadata, md);
    const unchanged = existing.state === 'confirmed' && metadataEquals(existing.metadata, next);

    const updated: Receipt = { ...existing, metadata: next, state: 'confirmed' };
    this.receipts.set(receiptId, updated);

    // A repeated confirmation is a no-op, not a second state change: same
    // contract as a replayed submit.
    return { ok: true, receipt: updated, deduped: unchanged };
  }

  // --- reads --------------------------------------------------------------

  /**
   * Returns null when the receipt does not exist OR belongs to another
   * company — the caller cannot tell which, which is the intended amount of
   * information. Auth problems throw, because "please re-authenticate" is not
   * the same answer as "no such receipt" and the signature has nowhere else to
   * put it.
   */
  async getReceipt(id: string, companyId: string, authToken: string): Promise<Receipt | null> {
    this.requireOnline();
    const auth = this.authorize(authToken, companyId);
    if (!auth.ok) throw new FakeServerError(auth.code, auth.message, auth.retryable);

    const receipt = this.receipts.get(id);
    if (receipt === undefined || receipt.companyId !== companyId) return null;
    return receipt;
  }

  /** Newest first, ties broken by id so the order is total and stable. */
  async listTransactions(companyId: string, authToken: string): Promise<Transaction[]> {
    this.requireOnline();
    const auth = this.authorize(authToken, companyId);
    if (!auth.ok) throw new FakeServerError(auth.code, auth.message, auth.retryable);

    return Array.from(this.transactions.values())
      .filter((t) => t.companyId === companyId)
      .sort((a, b) => {
        const delta = instantToMs(b.occurredAt) - instantToMs(a.occurredAt);
        return delta !== 0 ? delta : a.id.localeCompare(b.id);
      });
  }

  // --- private ------------------------------------------------------------

  private loadSeeds(): void {
    this.transactions = new Map(seedTransactions().map((t) => [t.id, t]));
  }

  private requireOnline(): void {
    if (this.networkMode === 'offline') {
      throw new FakeServerError('NETWORK_OFFLINE', 'No connectivity; request was not sent.', true);
    }
  }

  private authorize(token: string, companyId: string): AuthOutcome {
    // Injected expiry beats a structurally valid token: this is the token
    // dying between "background upload started" and "server read the header".
    if (this.failure === 'authExpired') {
      return {
        ok: false,
        code: 'AUTH_EXPIRED',
        message: 'Session expired during the request. Re-authenticate and retry.',
        retryable: true,
      };
    }

    const record = this.tokens.get(token);
    // An unknown token is indistinguishable from an evicted one, and both are
    // fixed the same way, so they get the same answer.
    if (record === undefined) {
      return {
        ok: false,
        code: 'AUTH_EXPIRED',
        message: 'Unknown or expired session token.',
        retryable: true,
      };
    }
    if (instantToMs(this.now()) >= record.expiresAtMs) {
      return {
        ok: false,
        code: 'AUTH_EXPIRED',
        message: 'Session expired. Re-authenticate and retry.',
        retryable: true,
      };
    }
    if (record.companyId !== companyId) {
      // Not retryable: retrying with the same token will fail forever. The app
      // must switch company or re-authenticate — and, critically, must NOT
      // "fix" this by rewriting the receipt's companyId.
      return {
        ok: false,
        code: 'COMPANY_MISMATCH',
        message:
          `Token is scoped to company '${record.companyId}' but the request claimed ` +
          `'${companyId}'. Refusing to file a receipt under the wrong company.`,
        retryable: false,
      };
    }
    return { ok: true, token: record };
  }

  private validateFile(file: SubmitReceiptRequest['file']): SubmitReceiptResponse | null {
    if (this.failure === 'fileTooLarge') {
      return fail('FILE_TOO_LARGE', `File exceeds the ${MAX_UPLOAD_BYTES} byte limit.`, false);
    }
    if (this.failure === 'unsupportedType') {
      return fail('UNSUPPORTED_TYPE', `This deployment rejects '${file.mime}'.`, false);
    }
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
      return fail('UNSUPPORTED_TYPE', 'File is empty or its size is unreadable.', false);
    }
    if (file.sizeBytes > MAX_UPLOAD_BYTES) {
      return fail(
        'FILE_TOO_LARGE',
        `File is ${file.sizeBytes} bytes; the limit is ${MAX_UPLOAD_BYTES}. ` +
          `Downscale or re-encode before retrying.`,
        false,
      );
    }
    if (!ACCEPTED_MIME_TYPES.includes(file.mime)) {
      return fail('UNSUPPORTED_TYPE', `Unsupported media type '${file.mime}'.`, false);
    }
    if (sanitizeStorageKey(file.storageKey) === '') {
      return fail('UNSUPPORTED_TYPE', 'File reference is empty or unusable.', false);
    }
    return null;
  }

  /**
   * `forReceiptId` is the receipt that is allowed to already hold this
   * transaction. Creation passes null (there is no receipt yet), so any
   * existing holder is a conflict; the replay branch in submitReceipt is the
   * route by which a receipt re-asserts a match it already owns.
   */
  private validateMatch(
    transactionId: string,
    companyId: string,
    forReceiptId: string | null,
  ): SubmitReceiptResponse | null {
    const txn = this.transactions.get(transactionId);
    // Unknown and cross-company get the same answer — see confirmCorrections.
    if (txn === undefined || txn.companyId !== companyId) {
      return fail(
        'COMPANY_MISMATCH',
        `Transaction '${transactionId}' is not available to company '${companyId}'.`,
        false,
      );
    }
    if (txn.matchedReceiptId !== null && txn.matchedReceiptId !== forReceiptId) {
      return fail(
        'TRANSACTION_ALREADY_MATCHED',
        `Transaction '${transactionId}' is already matched to receipt ` +
          `'${txn.matchedReceiptId}'. Pick a different transaction.`,
        false,
      );
    }
    return null;
  }

  private claimTransaction(transactionId: string, receiptId: string): void {
    const txn = this.transactions.get(transactionId);
    // Unreachable: validateMatch ran first. Guarded rather than asserted.
    if (txn === undefined) return;
    this.transactions.set(transactionId, { ...txn, matchedReceiptId: receiptId });
  }
}
