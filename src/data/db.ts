/**
 * SQLite schema and migrations.
 *
 * SQLite (rather than AsyncStorage) because the brief asks for a "durable
 * draft or clearly modeled persistence" that survives the app being killed
 * mid-queue. A key/value blob store gives you no atomic partial update and no
 * way to index by (company, state) — which is exactly the query the sync
 * engine runs on every wake-up.
 */

import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'receipts.db';

/** Bump this and add a migration below. Never edit a shipped migration. */
export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS receipt_drafts (
      local_id                     TEXT    PRIMARY KEY NOT NULL,
      company_id                   TEXT    NOT NULL,
      file_uri                     TEXT,
      file_name                    TEXT,
      file_mime_type               TEXT,
      file_size_bytes              INTEGER,
      vendor                       TEXT,
      -- Integer minor units. Deliberately never REAL: SQLite REAL is an IEEE
      -- double and would reintroduce the float rounding the domain layer works
      -- so hard to avoid.
      amount_minor_units           INTEGER,
      currency                     TEXT,
      -- 'YYYY-MM-DD' date-only. Stored as TEXT, never as a unix epoch, because
      -- an epoch forces a timezone and this value does not have one.
      transaction_date             TEXT,
      notes                        TEXT,
      state                        TEXT    NOT NULL,
      idempotency_key              TEXT    NOT NULL,
      server_receipt_id            TEXT,
      matched_transaction_id       TEXT,
      pending_match_transaction_id TEXT,
      provenance_json              TEXT    NOT NULL,
      last_error                   TEXT,
      last_error_retryable         INTEGER NOT NULL DEFAULT 0,
      attempt_count                INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT    NOT NULL,
      updated_at                   TEXT    NOT NULL,
      last_server_sync_at          TEXT
    );

    -- The sync engine's hot query: "what does company X still owe the server?"
    CREATE INDEX IF NOT EXISTS idx_drafts_company_state
      ON receipt_drafts (company_id, state);

    -- Local backstop for the duplicate-submission invariant. The server is the
    -- real authority on idempotency, but this stops a client bug from ever
    -- queueing the same logical submission twice within one tenant.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_company_idem
      ON receipt_drafts (company_id, idempotency_key);
  `,
};

export async function migrate(db: SQLiteDatabase): Promise<void> {
  // WAL keeps reads non-blocking while the sync engine writes.
  await db.execAsync('PRAGMA journal_mode = WAL;');
  // Off by default in SQLite; we rely on it for schema-level integrity.
  await db.execAsync('PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  let current = row?.user_version ?? 0;

  while (current < SCHEMA_VERSION) {
    const next = current + 1;
    const sql = MIGRATIONS[next];
    if (!sql) throw new Error(`Missing migration to schema version ${next}`);
    await db.execAsync(sql);
    // PRAGMA does not accept bound parameters, hence the interpolation. `next`
    // is a number from our own constant table, never user input.
    await db.execAsync(`PRAGMA user_version = ${next};`);
    current = next;
  }
}

export async function openDatabase(): Promise<SQLiteDatabase> {
  const SQLite = await import('expo-sqlite');
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await migrate(db);
  return db;
}
