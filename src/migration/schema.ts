// Database schema for the L1→L2 migration system

export const MIGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  l1_pool_address TEXT UNIQUE NOT NULL,
  l1_token_mint TEXT NOT NULL,
  l1_quote_mint TEXT NOT NULL,
  l2_wrapped_mint TEXT,
  l2_pool_address TEXT,
  dex_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'detected',
  initial_base_amount INTEGER NOT NULL DEFAULT 0,
  initial_quote_amount INTEGER NOT NULL DEFAULT 0,
  l1_detection_tx TEXT NOT NULL,
  l2_wrap_tx TEXT,
  l2_pool_tx TEXT,
  token_name TEXT,
  token_symbol TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_registry (
  l1_mint TEXT PRIMARY KEY,
  l2_wrapped_mint TEXT NOT NULL,
  dex_source TEXT NOT NULL,
  name TEXT,
  symbol TEXT,
  decimals INTEGER NOT NULL DEFAULT 6,
  migrated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status);
CREATE INDEX IF NOT EXISTS idx_migrations_l1_mint ON migrations(l1_token_mint);
CREATE INDEX IF NOT EXISTS idx_migrations_dex ON migrations(dex_source);
CREATE INDEX IF NOT EXISTS idx_token_registry_l2 ON token_registry(l2_wrapped_mint);
`;
