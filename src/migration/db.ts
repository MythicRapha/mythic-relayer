// Database operations for the migration system

import { getDb } from "../db/index.js";
import { MIGRATION_SCHEMA_SQL } from "./schema.js";
import type { MigrationRow, MigrationStatus, TokenRegistryRow, DexSource } from "./types.js";

let initialized = false;

export function initMigrationDb(): void {
  if (initialized) return;
  getDb().exec(MIGRATION_SCHEMA_SQL);
  initialized = true;
}

// -- Migrations --

export function insertMigration(
  migration: Omit<MigrationRow, "retry_count" | "l2_wrapped_mint" | "l2_pool_address" | "l2_wrap_tx" | "l2_pool_tx">
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO migrations
         (id, l1_pool_address, l1_token_mint, l1_quote_mint, l2_wrapped_mint, l2_pool_address,
          dex_source, status, initial_base_amount, initial_quote_amount,
          l1_detection_tx, l2_wrap_tx, l2_pool_tx, token_name, token_symbol,
          retry_count, created_at, updated_at)
       VALUES
         (@id, @l1_pool_address, @l1_token_mint, @l1_quote_mint, NULL, NULL,
          @dex_source, @status, @initial_base_amount, @initial_quote_amount,
          @l1_detection_tx, NULL, NULL, @token_name, @token_symbol,
          0, @created_at, @updated_at)`
    )
    .run(migration);
}

export function getMigrationByPool(l1PoolAddress: string): MigrationRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM migrations WHERE l1_pool_address = ?")
      .get(l1PoolAddress) as MigrationRow | undefined) ?? null
  );
}

export function getMigrationByMint(l1TokenMint: string): MigrationRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM migrations WHERE l1_token_mint = ? ORDER BY created_at DESC LIMIT 1")
      .get(l1TokenMint) as MigrationRow | undefined) ?? null
  );
}

export function getPendingMigrations(): MigrationRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM migrations WHERE status IN ('detected', 'wrapping', 'bridging', 'creating_pool') ORDER BY created_at ASC"
    )
    .all() as MigrationRow[];
}

export function getCompletedMigrations(limit: number = 50): MigrationRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM migrations WHERE status = 'completed' ORDER BY updated_at DESC LIMIT ?"
    )
    .all(limit) as MigrationRow[];
}

export function updateMigrationStatus(
  id: string,
  status: MigrationStatus,
  extra?: { l2_wrapped_mint?: string; l2_pool_address?: string; l2_wrap_tx?: string; l2_pool_tx?: string }
): void {
  const now = Date.now();
  const sets = ["status = ?", "updated_at = ?"];
  const params: any[] = [status, now];

  if (extra?.l2_wrapped_mint) {
    sets.push("l2_wrapped_mint = ?");
    params.push(extra.l2_wrapped_mint);
  }
  if (extra?.l2_pool_address) {
    sets.push("l2_pool_address = ?");
    params.push(extra.l2_pool_address);
  }
  if (extra?.l2_wrap_tx) {
    sets.push("l2_wrap_tx = ?");
    params.push(extra.l2_wrap_tx);
  }
  if (extra?.l2_pool_tx) {
    sets.push("l2_pool_tx = ?");
    params.push(extra.l2_pool_tx);
  }

  params.push(id);
  getDb()
    .prepare(`UPDATE migrations SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
}

export function incrementMigrationRetry(id: string): void {
  getDb()
    .prepare("UPDATE migrations SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function getMigrationRetryCount(id: string): number {
  const row = getDb()
    .prepare("SELECT retry_count FROM migrations WHERE id = ?")
    .get(id) as { retry_count: number } | undefined;
  return row?.retry_count ?? 0;
}

export function getMigrationStats(): { total: number; completed: number; failed: number; pending: number } {
  const total = (getDb().prepare("SELECT COUNT(*) as c FROM migrations").get() as any).c;
  const completed = (getDb().prepare("SELECT COUNT(*) as c FROM migrations WHERE status = 'completed'").get() as any).c;
  const failed = (getDb().prepare("SELECT COUNT(*) as c FROM migrations WHERE status = 'failed'").get() as any).c;
  const pending = (getDb().prepare("SELECT COUNT(*) as c FROM migrations WHERE status IN ('detected','wrapping','bridging','creating_pool')").get() as any).c;
  return { total, completed, failed, pending };
}

// -- Token Registry --

export function insertTokenRegistry(entry: TokenRegistryRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO token_registry
         (l1_mint, l2_wrapped_mint, dex_source, name, symbol, decimals, migrated_at)
       VALUES
         (@l1_mint, @l2_wrapped_mint, @dex_source, @name, @symbol, @decimals, @migrated_at)`
    )
    .run(entry);
}

export function getTokenByL1Mint(l1Mint: string): TokenRegistryRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM token_registry WHERE l1_mint = ?")
      .get(l1Mint) as TokenRegistryRow | undefined) ?? null
  );
}

export function getTokenByL2Mint(l2Mint: string): TokenRegistryRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM token_registry WHERE l2_wrapped_mint = ?")
      .get(l2Mint) as TokenRegistryRow | undefined) ?? null
  );
}

export function getAllMigratedTokens(): TokenRegistryRow[] {
  return getDb()
    .prepare("SELECT * FROM token_registry ORDER BY migrated_at DESC")
    .all() as TokenRegistryRow[];
}
