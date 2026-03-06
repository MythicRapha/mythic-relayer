// Types for the L1→L2 token migration system

export type MigrationStatus =
  | "detected"        // Pool creation detected on L1
  | "wrapping"        // Creating wrapped mint on L2
  | "bridging"        // Bridging liquidity from L1 to L2
  | "creating_pool"   // Creating pool on MythicSwap L2
  | "completed"       // Migration fully done
  | "failed"          // Migration failed (retryable)
  | "skipped";        // Intentionally skipped (blacklisted, too small, etc.)

export type DexSource = "pumpswap" | "raydium" | "meteora";

export interface MigrationRow {
  id: string;
  l1_pool_address: string;
  l1_token_mint: string;
  l1_quote_mint: string;
  l2_wrapped_mint: string | null;
  l2_pool_address: string | null;
  dex_source: DexSource;
  status: MigrationStatus;
  initial_base_amount: number;
  initial_quote_amount: number;
  l1_detection_tx: string;
  l2_wrap_tx: string | null;
  l2_pool_tx: string | null;
  token_name: string | null;
  token_symbol: string | null;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export interface TokenRegistryRow {
  l1_mint: string;
  l2_wrapped_mint: string;
  dex_source: DexSource;
  name: string | null;
  symbol: string | null;
  decimals: number;
  migrated_at: number;
}

export interface PoolCreationEvent {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseAmount: bigint;
  quoteAmount: bigint;
  creator: string;
  txSignature: string;
  dexSource: DexSource;
  tokenName?: string;
  tokenSymbol?: string;
}

export interface MigrationConfig {
  // Minimum SOL liquidity in the pool to trigger migration (in lamports)
  minLiquidityLamports: bigint;
  // Whether to auto-migrate or require manual approval
  autoMigrate: boolean;
  // Blacklisted token mints (never migrate)
  blacklistedMints: Set<string>;
  // Whitelisted token mints (always migrate, even below threshold)
  whitelistedMints: Set<string>;
  // Poll interval for L1 DEX events (ms)
  pollIntervalMs: number;
}
