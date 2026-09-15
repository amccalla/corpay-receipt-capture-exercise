/**
 * SQLite-backed ReceiptStore.
 *
 * Mirrors InMemoryReceiptStore's semantics exactly — same company scoping,
 * same errors — so the in-memory version is a faithful test double rather than
 * a convenient fiction.
 */

import type { SQLiteDatabase } from 'expo-sqlite';

import type { FieldProvenance, ReceiptDraft, ReceiptState } from '../domain/types';
import { EMPTY_PROVENANCE } from '../domain/types';
import {
  CrossCompanyWriteError,
  DraftNotFoundError,
  DuplicateDraftError,
  type ReceiptStore,
} from './store';

interface Row {
  local_id: string;
  company_id: string;
  file_uri: string | null;
  file_name: string | null;
  file_mime_type: string | null;
  file_size_bytes: number | null;
  vendor: string | null;
  amount_minor_units: number | null;
  currency: string | null;
  transaction_date: string | null;
  notes: string | null;
  state: string;
  idempotency_key: string;
  server_receipt_id: string | null;
  matched_transaction_id: string | null;
  pending_match_transaction_id: string | null;
  provenance_json: string;
  last_error: string | null;
  last_error_retryable: number;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  last_server_sync_at: string | null;
}

function parseProvenance(json: string): FieldProvenance {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object') {
      return { ...EMPTY_PROVENANCE, ...(parsed as Partial<FieldProvenance>) };
    }
  } catch {
    // A corrupt provenance blob must not brick the row. Falling back to
    // 'empty' is the conservative choice: it means a later OCR result is
    // allowed to fill the field, which is recoverable, whereas wrongly
    // claiming 'user' would permanently freeze a field the user never set.
  }
  return EMPTY_PROVENANCE;
}

function toDraft(r: Row): ReceiptDraft {
  return {
    localId: r.local_id,
    companyId: r.company_id,
    fileUri: r.file_uri,
    fileName: r.file_name,
    fileMimeType: r.file_mime_type,
    fileSizeBytes: r.file_size_bytes,
    vendor: r.vendor,
    amountMinorUnits: r.amount_minor_units,
    currency: r.currency,
    transactionDate: r.transaction_date,
    notes: r.notes,
    state: r.state as ReceiptState,
    idempotencyKey: r.idempotency_key,
    serverReceiptId: r.server_receipt_id,
    matchedTransactionId: r.matched_transaction_id,
    pendingMatchTransactionId: r.pending_match_transaction_id,
    provenance: parseProvenance(r.provenance_json),
    lastError: r.last_error,
    lastErrorRetryable: r.last_error_retryable === 1,
    attemptCount: r.attempt_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastServerSyncAt: r.last_server_sync_at,
  };
}

const COLUMNS = `
  local_id, company_id, file_uri, file_name, file_mime_type, file_size_bytes,
  vendor, amount_minor_units, currency, transaction_date, notes, state,
  idempotency_key, server_receipt_id, matched_transaction_id,
  pending_match_transaction_id, provenance_json, last_error,
  last_error_retryable, attempt_count, created_at, updated_at, last_server_sync_at
`;

function bindValues(d: ReceiptDraft): (string | number | null)[] {
  return [
    d.localId, d.companyId, d.fileUri, d.fileName, d.fileMimeType, d.fileSizeBytes,
    d.vendor, d.amountMinorUnits, d.currency, d.transactionDate, d.notes, d.state,
    d.idempotencyKey, d.serverReceiptId, d.matchedTransactionId,
    d.pendingMatchTransactionId, JSON.stringify(d.provenance), d.lastError,
    d.lastErrorRetryable ? 1 : 0, d.attemptCount, d.createdAt, d.updatedAt,
    d.lastServerSyncAt,
  ];
}

export class SQLiteReceiptStore implements ReceiptStore {
  constructor(private readonly db: SQLiteDatabase) {}

  async insert(draft: ReceiptDraft): Promise<void> {
    const existing = await this.db.getFirstAsync<Row>(
      'SELECT local_id FROM receipt_drafts WHERE local_id = ?',
      [draft.localId],
    );
    if (existing) throw new DuplicateDraftError(draft.localId);

    const placeholders = COLUMNS.split(',').map(() => '?').join(', ');
    await this.db.runAsync(
      `INSERT INTO receipt_drafts (${COLUMNS}) VALUES (${placeholders})`,
      bindValues(draft),
    );
  }

  async update(companyId: string, draft: ReceiptDraft): Promise<void> {
    const existing = await this.db.getFirstAsync<{ company_id: string }>(
      'SELECT company_id FROM receipt_drafts WHERE local_id = ?',
      [draft.localId],
    );
    if (!existing) throw new DraftNotFoundError(draft.localId);
    if (existing.company_id !== companyId) {
      throw new CrossCompanyWriteError(draft.localId, existing.company_id, companyId);
    }
    if (draft.companyId !== existing.company_id) {
      throw new CrossCompanyWriteError(draft.localId, existing.company_id, draft.companyId);
    }

    await this.db.runAsync(
      `UPDATE receipt_drafts SET
         file_uri = ?, file_name = ?, file_mime_type = ?, file_size_bytes = ?,
         vendor = ?, amount_minor_units = ?, currency = ?, transaction_date = ?, notes = ?,
         state = ?, idempotency_key = ?, server_receipt_id = ?, matched_transaction_id = ?,
         pending_match_transaction_id = ?, provenance_json = ?, last_error = ?,
         last_error_retryable = ?, attempt_count = ?, updated_at = ?, last_server_sync_at = ?
       WHERE local_id = ? AND company_id = ?`,
      [
        draft.fileUri, draft.fileName, draft.fileMimeType, draft.fileSizeBytes,
        draft.vendor, draft.amountMinorUnits, draft.currency, draft.transactionDate, draft.notes,
        draft.state, draft.idempotencyKey, draft.serverReceiptId, draft.matchedTransactionId,
        draft.pendingMatchTransactionId, JSON.stringify(draft.provenance), draft.lastError,
        draft.lastErrorRetryable ? 1 : 0, draft.attemptCount, draft.updatedAt,
        draft.lastServerSyncAt,
        draft.localId, companyId,
      ],
    );
  }

  async get(companyId: string, localId: string): Promise<ReceiptDraft | null> {
    const row = await this.db.getFirstAsync<Row>(
      `SELECT ${COLUMNS} FROM receipt_drafts WHERE local_id = ? AND company_id = ?`,
      [localId, companyId],
    );
    return row ? toDraft(row) : null;
  }

  async list(companyId: string): Promise<ReceiptDraft[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT ${COLUMNS} FROM receipt_drafts WHERE company_id = ?
       ORDER BY created_at DESC, local_id ASC`,
      [companyId],
    );
    return rows.map(toDraft);
  }

  async listByState(companyId: string, states: ReceiptState[]): Promise<ReceiptDraft[]> {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = await this.db.getAllAsync<Row>(
      `SELECT ${COLUMNS} FROM receipt_drafts
       WHERE company_id = ? AND state IN (${placeholders})
       ORDER BY created_at ASC, local_id ASC`,
      [companyId, ...states],
    );
    return rows.map(toDraft);
  }

  async delete(companyId: string, localId: string): Promise<void> {
    const res = await this.db.runAsync(
      'DELETE FROM receipt_drafts WHERE local_id = ? AND company_id = ?',
      [localId, companyId],
    );
    if (res.changes === 0) throw new DraftNotFoundError(localId);
  }

  async getAnyCompanyDraftById(localId: string) {
    const row = await this.db.getFirstAsync<Row>(
      `SELECT ${COLUMNS} FROM receipt_drafts WHERE local_id = ?`,
      [localId],
    );
    return row ? { draft: toDraft(row), companyId: row.company_id } : null;
  }

  async countPending(companyId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM receipt_drafts
       WHERE company_id = ? AND state IN ('queued', 'uploading', 'processing')`,
      [companyId],
    );
    return row?.n ?? 0;
  }
}
