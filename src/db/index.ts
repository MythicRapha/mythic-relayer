import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "../config/index.js";
import {
  SCHEMA_SQL,
  DepositRow,
  DepositStatus,
  WithdrawalRow,
  WithdrawalStatus,
} from "./schema.js";

let db: Database.Database;

export function initDb(): void {
  const dbPath = path.resolve(process.cwd(), config.DB_PATH);
  const dbDir = path.dirname(dbPath);

  // Ensure the data directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  // Create tables
  db.exec(SCHEMA_SQL);
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return db;
}

// ── Relayer State ─────────────────────────────────────────────────────────────

export function getRelayerState(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM relayer_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setRelayerState(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO relayer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

// ── Deposits ──────────────────────────────────────────────────────────────────

export function insertDeposit(
  deposit: Omit<DepositRow, "retry_count" | "l2_tx_signature">
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO deposits
         (id, l1_tx_signature, depositor_l1, recipient_l2, asset, amount_lamports, status, l2_tx_signature, retry_count, created_at, updated_at)
       VALUES
         (@id, @l1_tx_signature, @depositor_l1, @recipient_l2, @asset, @amount_lamports, @status, NULL, 0, @created_at, @updated_at)`
    )
    .run(deposit);
}

export function getDepositByL1Sig(l1TxSignature: string): DepositRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM deposits WHERE l1_tx_signature = ?")
      .get(l1TxSignature) as DepositRow | undefined) ?? null
  );
}

export function getPendingDeposits(): DepositRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM deposits WHERE status IN ('pending', 'minting') ORDER BY created_at ASC"
    )
    .all() as DepositRow[];
}

export function updateDepositStatus(
  id: string,
  status: DepositStatus,
  l2TxSignature?: string
): void {
  const now = Date.now();
  if (l2TxSignature) {
    getDb()
      .prepare(
        "UPDATE deposits SET status = ?, l2_tx_signature = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, l2TxSignature, now, id);
  } else {
    getDb()
      .prepare("UPDATE deposits SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }
}

export function incrementDepositRetry(id: string): void {
  getDb()
    .prepare(
      "UPDATE deposits SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?"
    )
    .run(Date.now(), id);
}

export function getDepositRetryCount(id: string): number {
  const row = getDb()
    .prepare("SELECT retry_count FROM deposits WHERE id = ?")
    .get(id) as { retry_count: number } | undefined;
  return row?.retry_count ?? 0;
}

// ── Withdrawals ───────────────────────────────────────────────────────────────

export function insertWithdrawal(
  withdrawal: Omit<WithdrawalRow, "retry_count" | "l1_tx_signature">
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO withdrawals
         (id, l2_tx_signature, withdrawer_l2, recipient_l1, asset, amount_lamports, status, challenge_expires_at, l1_tx_signature, burn_nonce, retry_count, created_at, updated_at)
       VALUES
         (@id, @l2_tx_signature, @withdrawer_l2, @recipient_l1, @asset, @amount_lamports, @status, @challenge_expires_at, NULL, @burn_nonce, 0, @created_at, @updated_at)`
    )
    .run(withdrawal);
}

export function getWithdrawalByL2Sig(l2TxSignature: string): WithdrawalRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM withdrawals WHERE l2_tx_signature = ?")
      .get(l2TxSignature) as WithdrawalRow | undefined) ?? null
  );
}

export function getWithdrawalsReadyToRelease(): WithdrawalRow[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb()
    .prepare(
      `SELECT * FROM withdrawals
       WHERE status = 'challenge'
         AND challenge_expires_at <= ?
       ORDER BY challenge_expires_at ASC`
    )
    .all(now) as WithdrawalRow[];
}

export function getPendingWithdrawals(): WithdrawalRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM withdrawals WHERE status IN ('pending', 'challenge', 'releasing') ORDER BY created_at ASC"
    )
    .all() as WithdrawalRow[];
}

export function updateWithdrawalStatus(
  id: string,
  status: WithdrawalStatus,
  l1TxSignature?: string
): void {
  const now = Date.now();
  if (l1TxSignature) {
    getDb()
      .prepare(
        "UPDATE withdrawals SET status = ?, l1_tx_signature = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, l1TxSignature, now, id);
  } else {
    getDb()
      .prepare("UPDATE withdrawals SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }
}

export function incrementWithdrawalRetry(id: string): void {
  getDb()
    .prepare(
      "UPDATE withdrawals SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?"
    )
    .run(Date.now(), id);
}

export function getWithdrawalRetryCount(id: string): number {
  const row = getDb()
    .prepare("SELECT retry_count FROM withdrawals WHERE id = ?")
    .get(id) as { retry_count: number } | undefined;
  return row?.retry_count ?? 0;
}
