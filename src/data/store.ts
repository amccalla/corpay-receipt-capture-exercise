/**
 * The persistence boundary.
 *
 * Every read and write is COMPANY-SCOPED BY SIGNATURE: there is no method that
 * returns a draft without being told which company is asking. This is the
 * structural half of the brief's invariant that a company switch or logout
 * cannot upload a queued receipt under the wrong company — you cannot
 * accidentally fetch another tenant's row, because there is no API for it.
 *
 * The one deliberate exception is `getAnyCompanyDraftById`, which exists only
 * so the UI can tell a user "this draft belongs to Northwind, switch companies
 * to submit it" instead of silently showing nothing. It is named to be
 * conspicuous at every call site, and it is never used by the sync engine.
 */

import type { ReceiptDraft, ReceiptState } from '../domain/types';

export interface ReceiptStore {
  /** Insert a brand-new draft. Throws if localId already exists. */
  insert(draft: ReceiptDraft): Promise<void>;

  /**
   * Overwrite an existing draft. `companyId` must match the stored row's
   * company or this throws — a caller holding a stale draft object from
   * another tenant cannot write through it.
   */
  update(companyId: string, draft: ReceiptDraft): Promise<void>;

  get(companyId: string, localId: string): Promise<ReceiptDraft | null>;

  list(companyId: string): Promise<ReceiptDraft[]>;

  listByState(companyId: string, states: ReceiptState[]): Promise<ReceiptDraft[]>;

  delete(companyId: string, localId: string): Promise<void>;

  /**
   * Look up a draft WITHOUT company scoping, for the express purpose of
   * explaining a cross-company situation to the user. Returns the owning
   * companyId alongside so the caller must acknowledge the mismatch.
   * NEVER call this from upload/sync paths.
   */
  getAnyCompanyDraftById(localId: string): Promise<{ draft: ReceiptDraft; companyId: string } | null>;

  /** Count of drafts still owed to the server, per company. For badges. */
  countPending(companyId: string): Promise<number>;
}

export class DraftNotFoundError extends Error {
  constructor(localId: string) {
    super(`No draft '${localId}' visible to this company`);
    this.name = 'DraftNotFoundError';
  }
}

export class CrossCompanyWriteError extends Error {
  constructor(localId: string, owning: string, attempted: string) {
    super(
      `Refusing cross-company write to draft '${localId}': owned by '${owning}', ` +
        `attempted by '${attempted}'`,
    );
    this.name = 'CrossCompanyWriteError';
  }
}

export class DuplicateDraftError extends Error {
  constructor(localId: string) {
    super(`Draft '${localId}' already exists`);
    this.name = 'DuplicateDraftError';
  }
}

/**
 * In-memory implementation. Used by the test suite so the tenancy and state
 * rules can be verified as pure logic, with no native SQLite dependency.
 * Deep-copies on the way in and out so callers cannot mutate stored state by
 * holding a reference — the same isolation a real database gives you.
 */
export class InMemoryReceiptStore implements ReceiptStore {
  private rows = new Map<string, ReceiptDraft>();

  private clone(d: ReceiptDraft): ReceiptDraft {
    return { ...d, provenance: { ...d.provenance } };
  }

  async insert(draft: ReceiptDraft): Promise<void> {
    if (this.rows.has(draft.localId)) throw new DuplicateDraftError(draft.localId);
    this.rows.set(draft.localId, this.clone(draft));
  }

  async update(companyId: string, draft: ReceiptDraft): Promise<void> {
    const existing = this.rows.get(draft.localId);
    if (!existing) throw new DraftNotFoundError(draft.localId);
    if (existing.companyId !== companyId) {
      throw new CrossCompanyWriteError(draft.localId, existing.companyId, companyId);
    }
    // The draft's own companyId is immutable; a payload claiming otherwise is a bug.
    if (draft.companyId !== existing.companyId) {
      throw new CrossCompanyWriteError(draft.localId, existing.companyId, draft.companyId);
    }
    this.rows.set(draft.localId, this.clone(draft));
  }

  async get(companyId: string, localId: string): Promise<ReceiptDraft | null> {
    const row = this.rows.get(localId);
    if (!row || row.companyId !== companyId) return null;
    return this.clone(row);
  }

  async list(companyId: string): Promise<ReceiptDraft[]> {
    return [...this.rows.values()]
      .filter((r) => r.companyId === companyId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.localId < b.localId ? -1 : 1))
      .map((r) => this.clone(r));
  }

  async listByState(companyId: string, states: ReceiptState[]): Promise<ReceiptDraft[]> {
    const wanted = new Set(states);
    return (await this.list(companyId)).filter((r) => wanted.has(r.state));
  }

  async delete(companyId: string, localId: string): Promise<void> {
    const row = this.rows.get(localId);
    if (!row || row.companyId !== companyId) throw new DraftNotFoundError(localId);
    this.rows.delete(localId);
  }

  async getAnyCompanyDraftById(localId: string) {
    const row = this.rows.get(localId);
    return row ? { draft: this.clone(row), companyId: row.companyId } : null;
  }

  async countPending(companyId: string): Promise<number> {
    return (await this.listByState(companyId, ['queued', 'uploading', 'processing'])).length;
  }

  /** Test helper: total rows across all tenants, to assert nothing leaked. */
  _totalRowCount(): number {
    return this.rows.size;
  }
}
