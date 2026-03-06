// Migration Processor — handles token wrapping on L2 and pool creation on MythicSwap

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import type { PoolCreationEvent, MigrationStatus } from "./types.js";
import {
  insertMigration,
  updateMigrationStatus,
  incrementMigrationRetry,
  getMigrationRetryCount,
  getPendingMigrations,
  insertTokenRegistry,
  getTokenByL1Mint,
} from "./db.js";

// L2 Program IDs
const L2_BRIDGE_PROGRAM = new PublicKey(config.L2_BRIDGE_PROGRAM);
const L2_SWAP_PROGRAM = new PublicKey(
  process.env.L2_SWAP_PROGRAM ?? "MythSwap11111111111111111111111111111111111"
);

// SPL Token program
const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bbd");

// Bridge PDA seeds (matching bridge-l2 program)
const L2_BRIDGE_CONFIG_SEED = Buffer.from("l2_bridge_config");
const WRAPPED_MINT_SEED = Buffer.from("wrapped_mint");
const MINT_SEED = Buffer.from("mint");
const BRIDGE_RESERVE_SEED = Buffer.from("bridge_reserve");

// Swap PDA seeds (matching swap program)
const SWAP_CONFIG_SEED = Buffer.from("swap_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const LP_MINT_SEED = Buffer.from("lp_mint");

// Known L1 to L2 mint mappings (pre-deployed wrapped tokens on L2)
const KNOWN_L2_MINTS: Record<string, string> = {
  // SOL -> wSOL on L2
  "So11111111111111111111111111111111111111112": "FEJa8wGyhXu9Hic1jNTg76Atb57C7jFkmDyDTQZkVwy3",
  // USDC -> wUSDC on L2
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "6QTVHn4TUPQSpCH1uGmAK1Vd6JhuSEeKMKSi1F1SZMN",
};

const MAX_RETRIES = 5;

export class MigrationProcessor {
  private l2Connection: Connection;
  private relayer: Keypair;

  constructor(relayerKeypair: Keypair) {
    this.l2Connection = new Connection(config.L2_RPC_URL, {
      commitment: "confirmed",
    });
    this.relayer = relayerKeypair;
  }

  /**
   * Record a pool detection without starting migration (manual mode).
   */
  async recordDetection(event: PoolCreationEvent): Promise<void> {
    const id = generateId();
    const now = Date.now();

    insertMigration({
      id,
      l1_pool_address: event.poolAddress,
      l1_token_mint: event.baseMint,
      l1_quote_mint: event.quoteMint,
      dex_source: event.dexSource,
      status: "detected",
      initial_base_amount: Number(event.baseAmount),
      initial_quote_amount: Number(event.quoteAmount),
      l1_detection_tx: event.txSignature,
      token_name: event.tokenName ?? null,
      token_symbol: event.tokenSymbol ?? null,
      created_at: now,
      updated_at: now,
    });

    logger.info({ id, pool: event.poolAddress }, "Migration: pool detected and recorded");
  }

  /**
   * Full auto-migration flow:
   * 1. Record detection
   * 2. Create/find wrapped mint on L2
   * 3. Create MythicSwap pool on L2
   */
  async startMigration(event: PoolCreationEvent): Promise<void> {
    const id = generateId();
    const now = Date.now();
    const log = logger.child({ migrationId: id, pool: event.poolAddress, dex: event.dexSource });

    // Step 1: Record
    insertMigration({
      id,
      l1_pool_address: event.poolAddress,
      l1_token_mint: event.baseMint,
      l1_quote_mint: event.quoteMint,
      dex_source: event.dexSource,
      status: "detected",
      initial_base_amount: Number(event.baseAmount),
      initial_quote_amount: Number(event.quoteAmount),
      l1_detection_tx: event.txSignature,
      token_name: event.tokenName ?? null,
      token_symbol: event.tokenSymbol ?? null,
      created_at: now,
      updated_at: now,
    });

    // Step 2: Resolve L2 mints
    try {
      await this.resolveL2Mints(id, event, log);
    } catch (err) {
      log.error({ err }, "Migration: failed during mint resolution");
      incrementMigrationRetry(id);
      updateMigrationStatus(id, "failed");
      return;
    }

    // Step 3: Create pool on L2
    try {
      await this.createL2Pool(id, event, log);
    } catch (err) {
      log.error({ err }, "Migration: failed during pool creation");
      incrementMigrationRetry(id);
      updateMigrationStatus(id, "failed");
      return;
    }
  }

  /**
   * Resolve L2 wrapped mints for both tokens in the pair.
   * For the base token (memecoin): derive the wrapped mint PDA from bridge-l2 program.
   * For the quote token (SOL/USDC): use the known L2 mapping.
   */
  private async resolveL2Mints(
    migrationId: string,
    event: PoolCreationEvent,
    log: typeof logger,
  ): Promise<{ l2BaseMint: string; l2QuoteMint: string }> {
    updateMigrationStatus(migrationId, "wrapping");

    // Resolve quote mint (SOL/USDC -> known L2 wrapped)
    let l2QuoteMint = KNOWN_L2_MINTS[event.quoteMint];
    if (!l2QuoteMint) {
      // Derive from bridge PDA
      l2QuoteMint = this.deriveL2Mint(event.quoteMint);
    }

    // Resolve base mint (memecoin -> L2 wrapped)
    let l2BaseMint: string;
    const existingMapping = getTokenByL1Mint(event.baseMint);

    if (existingMapping) {
      l2BaseMint = existingMapping.l2_wrapped_mint;
      log.info({ l1Mint: event.baseMint, l2Mint: l2BaseMint }, "Migration: using existing token mapping");
    } else {
      // Derive the L2 mint PDA from the bridge program
      l2BaseMint = this.deriveL2Mint(event.baseMint);

      // Check if the mint already exists on L2 (might have been created by a previous bridge operation)
      const mintExists = await this.checkAccountExists(new PublicKey(l2BaseMint));

      if (!mintExists) {
        log.info({
          l1Mint: event.baseMint,
          l2Mint: l2BaseMint,
          exists: false,
        }, "Migration: L2 wrapped mint PDA derived (will be created on first bridge)");
      } else {
        log.info({ l1Mint: event.baseMint, l2Mint: l2BaseMint }, "Migration: L2 wrapped mint already exists");
      }

      // Register in token registry
      insertTokenRegistry({
        l1_mint: event.baseMint,
        l2_wrapped_mint: l2BaseMint,
        dex_source: event.dexSource,
        name: event.tokenName ?? null,
        symbol: event.tokenSymbol ?? null,
        decimals: 6, // Most PumpFun tokens are 6 decimals
        migrated_at: Date.now(),
      });
    }

    updateMigrationStatus(migrationId, "wrapping", { l2_wrapped_mint: l2BaseMint });

    return { l2BaseMint, l2QuoteMint };
  }

  /**
   * Create a MythicSwap pool on L2 for the migrated token pair.
   *
   * This derives all the necessary PDAs and records the pool address.
   * The actual pool creation transaction will happen when bridged
   * liquidity arrives on L2.
   */
  private async createL2Pool(
    migrationId: string,
    event: PoolCreationEvent,
    log: typeof logger,
  ): Promise<void> {
    updateMigrationStatus(migrationId, "creating_pool");

    const l2BaseMint = this.deriveL2Mint(event.baseMint);
    const l2QuoteMint = KNOWN_L2_MINTS[event.quoteMint] ?? this.deriveL2Mint(event.quoteMint);

    // Sort mints for canonical pool PDA (smaller first)
    const mintA = l2BaseMint < l2QuoteMint ? l2BaseMint : l2QuoteMint;
    const mintB = l2BaseMint < l2QuoteMint ? l2QuoteMint : l2BaseMint;

    const mintAPubkey = new PublicKey(mintA);
    const mintBPubkey = new PublicKey(mintB);

    // Derive MythicSwap PDAs
    const [swapConfig] = PublicKey.findProgramAddressSync(
      [SWAP_CONFIG_SEED],
      L2_SWAP_PROGRAM,
    );
    const [poolPda] = PublicKey.findProgramAddressSync(
      [POOL_SEED, mintAPubkey.toBuffer(), mintBPubkey.toBuffer()],
      L2_SWAP_PROGRAM,
    );

    // Check if pool already exists
    const poolExists = await this.checkAccountExists(poolPda);
    if (poolExists) {
      log.info({
        pool: poolPda.toBase58(),
        mintA,
        mintB,
      }, "Migration: L2 pool already exists -- marking complete");

      updateMigrationStatus(migrationId, "completed", {
        l2_pool_address: poolPda.toBase58(),
      });
      return;
    }

    // Derive remaining PDAs for reference
    const [vaultA] = PublicKey.findProgramAddressSync(
      [POOL_VAULT_SEED, poolPda.toBuffer(), mintAPubkey.toBuffer()],
      L2_SWAP_PROGRAM,
    );
    const [vaultB] = PublicKey.findProgramAddressSync(
      [POOL_VAULT_SEED, poolPda.toBuffer(), mintBPubkey.toBuffer()],
      L2_SWAP_PROGRAM,
    );
    const [lpMint] = PublicKey.findProgramAddressSync(
      [LP_MINT_SEED, poolPda.toBuffer()],
      L2_SWAP_PROGRAM,
    );

    log.info({
      poolPda: poolPda.toBase58(),
      mintA,
      mintB,
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      lpMint: lpMint.toBase58(),
    }, "Migration: L2 pool PDAs derived -- pool will be created when bridged liquidity arrives");

    updateMigrationStatus(migrationId, "completed", {
      l2_pool_address: poolPda.toBase58(),
    });

    log.info({
      migrationId,
      l1Pool: event.poolAddress,
      l2Pool: poolPda.toBase58(),
      dex: event.dexSource,
    }, "Migration: completed -- token registered, L2 pool address reserved");
  }

  /**
   * Retry any pending migrations that previously failed.
   */
  async retryPendingMigrations(): Promise<void> {
    const pending = getPendingMigrations();
    if (pending.length === 0) return;

    for (const migration of pending) {
      const retries = getMigrationRetryCount(migration.id);
      if (retries >= MAX_RETRIES) {
        updateMigrationStatus(migration.id, "failed");
        logger.warn({ id: migration.id, retries }, "Migration: max retries exceeded, marking failed");
        continue;
      }

      // Only retry migrations stuck in intermediate states
      if (migration.status === "wrapping" || migration.status === "bridging" || migration.status === "creating_pool") {
        logger.info({ id: migration.id, status: migration.status, retries }, "Migration: retrying");

        const event: PoolCreationEvent = {
          poolAddress: migration.l1_pool_address,
          baseMint: migration.l1_token_mint,
          quoteMint: migration.l1_quote_mint,
          baseAmount: BigInt(migration.initial_base_amount),
          quoteAmount: BigInt(migration.initial_quote_amount),
          creator: "",
          txSignature: migration.l1_detection_tx,
          dexSource: migration.dex_source,
          tokenName: migration.token_name ?? undefined,
          tokenSymbol: migration.token_symbol ?? undefined,
        };

        try {
          if (migration.status === "wrapping") {
            const log = logger.child({ migrationId: migration.id });
            await this.resolveL2Mints(migration.id, event, log);
            await this.createL2Pool(migration.id, event, log);
          } else if (migration.status === "creating_pool") {
            const log = logger.child({ migrationId: migration.id });
            await this.createL2Pool(migration.id, event, log);
          }
        } catch (err) {
          incrementMigrationRetry(migration.id);
          logger.error({ err, id: migration.id }, "Migration: retry failed");
        }
      }
    }
  }

  // -- Helpers --

  /**
   * Derive the L2 wrapped mint PDA from the bridge-l2 program.
   */
  private deriveL2Mint(l1Mint: string): string {
    const l1MintPubkey = new PublicKey(l1Mint);
    const [mintPda] = PublicKey.findProgramAddressSync(
      [MINT_SEED, l1MintPubkey.toBuffer()],
      L2_BRIDGE_PROGRAM,
    );
    return mintPda.toBase58();
  }

  /**
   * Check if an account exists on L2.
   */
  private async checkAccountExists(pubkey: PublicKey): Promise<boolean> {
    try {
      const info = await this.l2Connection.getAccountInfo(pubkey);
      return info !== null;
    } catch {
      return false;
    }
  }
}

function generateId(): string {
  const ts = Date.now().toString(16);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `mig-${ts}-${rand}`;
}
