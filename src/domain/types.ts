/**
 * Core domain contract.
 *
 * Every other module in this app depends on these types. Two ideas drive the
 * whole design, and both come straight from the brief's non-negotiables:
 *
 * 1. LOCAL STATE AND REMOTE STATE ARE DIFFERENT THINGS.
 *    `state` is what this device believes. `serverReceiptId` is the only proof
 *    the server ever created a business record. A receipt is only truly
 *    confirmed when BOTH agree — see `isServerConfirmed()`. A local queue
 *    accepting a file proves nothing.
 *
 * 2. MONEY AND TIME HAVE EXPLICIT SEMANTICS.
 *    Money is integer minor units + an ISO-4217 code, never a float. Time is
 *    split into date-only calendar values and absolute instants, which are not
 *    interchangeable and are never converted into each other.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** ISO 4217 alphabetic code, e.g. 'USD'. Uppercase by construction. */
export type CurrencyCode = string;

/**
 * An amount of money. `minorUnits` is an integer count of the currency's
 * smallest unit — cents for USD, yen for JPY, fils for BHD. Never a float:
 * 19.99 USD is { minorUnits: 1999, currency: 'USD' }.
 *
 * The exponent is a property of the currency, not of the amount, so it is NOT
 * stored here — see `exponentFor()` in money.ts.
 */
export interface Money {
  readonly minorUnits: number;
  readonly currency: CurrencyCode;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A calendar date with NO time and NO timezone: 'YYYY-MM-DD'.
 *
 * This is the date printed on the receipt, in the merchant's local calendar.
 * It is deliberately NOT an instant. Converting it to one requires inventing a
 * timezone, which is how a 2026-01-01 receipt becomes 2025-12-31 for a user in
 * UTC-5. We never do that conversion.
 */
export type DateOnly = string;

/**
 * An absolute moment, ISO 8601 with explicit UTC offset:
 * '2026-08-11T14:03:22.000Z'. Used for audit fields and for when a card
 * transaction actually cleared — things that happened at a point in time.
 */
export type Instant = string;

// ---------------------------------------------------------------------------
// Receipt state machine (mirrors the brief's diagram exactly)
// ---------------------------------------------------------------------------

/**
 * The seven states from the brief's conceptual flow.
 *
 * `draft`, `queued`, `uploading` and `failed` are LOCAL states — this device
 * can move between them on its own.
 *
 * `processing`, `needsReview` and `confirmed` are SERVER states — they may
 * ONLY be entered by applying a server response. `applyServerState()` is the
 * only door into them, and it demands a server receipt id.
 */
export type ReceiptState =
  | 'draft'
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'failed'
  | 'needsReview'
  | 'confirmed';

/** States this device may assign to itself without hearing from the server. */
export const LOCAL_STATES = ['draft', 'queued', 'uploading', 'failed'] as const;

/** States that require a server response to enter. */
export const SERVER_STATES = ['processing', 'needsReview', 'confirmed'] as const;

export type LocalState = (typeof LOCAL_STATES)[number];
export type ServerState = (typeof SERVER_STATES)[number];

export function isLocalState(s: ReceiptState): s is LocalState {
  return (LOCAL_STATES as readonly string[]).includes(s);
}

export function isServerState(s: ReceiptState): s is ServerState {
  return (SERVER_STATES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Field provenance — so late OCR cannot clobber a human correction
// ---------------------------------------------------------------------------

/**
 * Who last wrote a field.
 *
 * Edge case from the brief: "OCR returns after the user corrected the vendor
 * and amount." A human edit must win permanently, so every extractable field
 * carries its origin. Merge logic refuses to let 'ocr' overwrite 'user'.
 */
export type FieldOrigin = 'user' | 'ocr' | 'empty';

export interface FieldProvenance {
  readonly vendor: FieldOrigin;
  readonly amount: FieldOrigin;
  readonly currency: FieldOrigin;
  readonly transactionDate: FieldOrigin;
}

export const EMPTY_PROVENANCE: FieldProvenance = {
  vendor: 'empty',
  amount: 'empty',
  currency: 'empty',
  transactionDate: 'empty',
};

// ---------------------------------------------------------------------------
// The local draft
// ---------------------------------------------------------------------------

/**
 * A receipt as it exists ON THIS DEVICE. Survives app kill; it is the unit of
 * work the sync engine drains.
 */
export interface ReceiptDraft {
  /** Device-local primary key. Stable for the life of the draft. */
  readonly localId: string;

  /**
   * The company this receipt was captured under, stamped at capture time and
   * NEVER rewritten. The sync engine refuses to upload a draft whose companyId
   * differs from the active session — that is the company-boundary invariant.
   */
  readonly companyId: string;

  /** App-sandbox URI of the copied image. Null only before a file is attached. */
  readonly fileUri: string | null;
  readonly fileName: string | null;
  readonly fileMimeType: string | null;
  readonly fileSizeBytes: number | null;

  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: CurrencyCode | null;
  readonly transactionDate: DateOnly | null;
  readonly notes: string | null;

  readonly state: ReceiptState;

  /**
   * Stable across every retry of the same logical submission. This is what
   * makes "retry after a lost success response" safe: the server recognises
   * the key and returns the ORIGINAL record instead of creating a second one.
   * Rotated only when the user meaningfully changes what they are submitting.
   */
  readonly idempotencyKey: string;

  /**
   * Proof the server created a business record. Null until a real response
   * said so. `state === 'confirmed'` without this is a bug, not a confirmation.
   */
  readonly serverReceiptId: string | null;

  /** The transaction this receipt is matched to, as confirmed by the server. */
  readonly matchedTransactionId: string | null;

  /** Locally chosen match, not yet acknowledged by the server. */
  readonly pendingMatchTransactionId: string | null;

  readonly provenance: FieldProvenance;

  /** Human-readable reason for the most recent failure, for the UI. */
  readonly lastError: string | null;
  /** Whether retrying could plausibly help (transient vs permanent). */
  readonly lastErrorRetryable: boolean;
  readonly attemptCount: number;

  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  /** When the server last told us something about this receipt. */
  readonly lastServerSyncAt: Instant | null;
}

/**
 * THE confirmation predicate. The UI must call this rather than testing
 * `state === 'confirmed'`, so that a local-only state can never render as
 * server-confirmed.
 */
export function isServerConfirmed(d: ReceiptDraft): boolean {
  return d.state === 'confirmed' && d.serverReceiptId !== null;
}

// ---------------------------------------------------------------------------
// Server-side records
// ---------------------------------------------------------------------------

/** A seeded synthetic card transaction. */
export interface Transaction {
  readonly id: string;
  readonly companyId: string;
  readonly merchant: string;
  readonly amountMinorUnits: number;
  readonly currency: CurrencyCode;
  /** An instant: when the card transaction actually cleared. */
  readonly occurredAt: Instant;
  /** Set once a receipt is matched. Enforces one-receipt-per-transaction. */
  readonly matchedReceiptId: string | null;
}

/** The server's own record of a receipt. */
export interface Receipt {
  readonly id: string;
  readonly companyId: string;
  /** Opaque storage handle. The server never trusts a client-supplied path. */
  readonly storageKey: string;
  readonly metadata: ReceiptMetadata;
  readonly state: ServerState;
  readonly createdBy: string;
  readonly createdAt: Instant;
  readonly matchedTransactionId: string | null;
}

export interface ReceiptMetadata {
  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: CurrencyCode | null;
  readonly transactionDate: DateOnly | null;
  readonly notes: string | null;
}

export interface Company {
  readonly id: string;
  readonly name: string;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}
