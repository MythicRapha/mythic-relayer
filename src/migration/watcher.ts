// L1 DEX Watcher — monitors PumpSwap, Raydium, and Meteora for pool creation events

import {
  Connection,
  PublicKey,
  ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { getRelayerState, setRelayerState } from "../db/index.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import {
  PUMPSWAP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  METEORA_DLMM_PROGRAM,
  METEORA_AMM_PROGRAM,
  parsePoolCreation,
} from "./parsers.js";
import { MigrationProcessor } from "./processor.js";
import type { PoolCreationEvent, MigrationConfig } from "./types.js";
import { getMigrationByPool, initMigrationDb } from "./db.js";

// State keys for cursor tracking (one per DEX)
const STATE_PUMPSWAP_LAST_SIG = "migration_pumpswap_last_sig";
const STATE_RAYDIUM_LAST_SIG = "migration_raydium_last_sig";
const STATE_METEORA_LAST_SIG = "migration_meteora_last_sig";

// Default minimum liquidity: 1 SOL (1e9 lamports)
const DEFAULT_MIN_LIQUIDITY = BigInt(1_000_000_000);

interface WatchTarget {
  programId: PublicKey;
  stateKey: string;
  name: string;
}

export class MigrationWatcher {
  private connection: Connection;
  private processor: MigrationProcessor;
  private migrationConfig: MigrationConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private watchTargets: WatchTarget[] = [
    { programId: PUMPSWAP_PROGRAM, stateKey: STATE_PUMPSWAP_LAST_SIG, name: "PumpSwap" },
    { programId: RAYDIUM_CPMM_PROGRAM, stateKey: STATE_RAYDIUM_LAST_SIG, name: "Raydium" },
    { programId: METEORA_DLMM_PROGRAM, stateKey: STATE_METEORA_LAST_SIG, name: "Meteora DLMM" },
  ];

  constructor(processor: MigrationProcessor) {
    this.connection = new Connection(config.L1_RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: false,
    });
    this.processor = processor;

    // Parse config from env
    const minLiq = process.env.MIGRATION_MIN_LIQUIDITY_SOL
      ? BigInt(Math.floor(parseFloat(process.env.MIGRATION_MIN_LIQUIDITY_SOL) * 1e9))
      : DEFAULT_MIN_LIQUIDITY;

    const blacklisted = (process.env.MIGRATION_BLACKLIST ?? "").split(",").filter(Boolean);
    const whitelisted = (process.env.MIGRATION_WHITELIST ?? "").split(",").filter(Boolean);

    this.migrationConfig = {
      minLiquidityLamports: minLiq,
      autoMigrate: process.env.MIGRATION_AUTO !== "false",
      blacklistedMints: new Set(blacklisted),
      whitelistedMints: new Set(whitelisted),
      pollIntervalMs: parseInt(process.env.MIGRATION_POLL_MS ?? "15000", 10),
    };
  }

  async start(): Promise<void> {
    initMigrationDb();
    this.running = true;

    logger.info({
      targets: this.watchTargets.map(t => t.name),
      minLiquidity: `${Number(this.migrationConfig.minLiquidityLamports) / 1e9} SOL`,
      autoMigrate: this.migrationConfig.autoMigrate,
      pollIntervalMs: this.migrationConfig.pollIntervalMs,
    }, "MigrationWatcher: Starting — watching L1 DEXes for pool creation events");

    await this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("MigrationWatcher: Stopped");
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.poll();
    }, this.migrationConfig.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.pollAllTargets();
    } catch (err) {
      logger.error({ err }, "MigrationWatcher: Unhandled error in poll cycle");
    } finally {
      this.schedule();
    }
  }

  private async pollAllTargets(): Promise<void> {
    // Poll each DEX program sequentially to avoid rate limiting
    for (const target of this.watchTargets) {
      try {
        await this.pollTarget(target);
      } catch (err) {
        logger.warn({ err, target: target.name }, "MigrationWatcher: Error polling target");
      }
    }

    // Also retry any pending migrations
    try {
      await this.processor.retryPendingMigrations();
    } catch (err) {
      logger.warn({ err }, "MigrationWatcher: Error retrying pending migrations");
    }
  }

  private async pollTarget(target: WatchTarget): Promise<void> {
    const lastSig = getRelayerState(target.stateKey) ?? undefined;

    // Fetch recent signatures for this DEX program
    let signatures: ConfirmedSignatureInfo[];
    try {
      const opts: { limit: number; before?: string } = { limit: 25 };
      if (lastSig) {
        // Only get signatures after our cursor
      }
      signatures = await this.connection.getSignaturesForAddress(
        target.programId,
        opts
      );
    } catch (err) {
      logger.warn({ err, target: target.name }, "MigrationWatcher: Failed to fetch signatures");
      return;
    }

    if (signatures.length === 0) return;

    // Filter to new signatures since last seen
    const newSigs: ConfirmedSignatureInfo[] = [];
    for (const sigInfo of signatures) {
      if (sigInfo.signature === lastSig) break;
      if (sigInfo.err !== null) continue;
      newSigs.push(sigInfo);
    }

    if (newSigs.length === 0) return;

    logger.debug({ count: newSigs.length, target: target.name }, "MigrationWatcher: Processing signatures");

    // Process oldest first
    const ordered = [...newSigs].reverse();

    for (const sigInfo of ordered) {
      const sig = sigInfo.signature;

      try {
        const tx = await this.connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

        if (!tx) continue;

        const event = parsePoolCreation(tx, sig);
        if (!event) continue;

        // Check if already processed
        const existing = getMigrationByPool(event.poolAddress);
        if (existing) {
          logger.debug({ pool: event.poolAddress }, "MigrationWatcher: Pool already tracked");
          continue;
        }

        // Check filters
        if (!this.shouldMigrate(event)) {
          logger.info({
            pool: event.poolAddress,
            baseMint: event.baseMint,
            quoteMint: event.quoteMint,
            dex: event.dexSource,
            quoteAmount: event.quoteAmount.toString(),
          }, "MigrationWatcher: Pool detected but filtered out");
          continue;
        }

        logger.info({
          pool: event.poolAddress,
          baseMint: event.baseMint,
          quoteMint: event.quoteMint,
          dex: event.dexSource,
          baseAmount: event.baseAmount.toString(),
          quoteAmount: event.quoteAmount.toString(),
          creator: event.creator,
        }, "MigrationWatcher: New pool detected — starting migration");

        // Start migration
        if (this.migrationConfig.autoMigrate) {
          await this.processor.startMigration(event);
        } else {
          // Just record it for manual review
          await this.processor.recordDetection(event);
        }

      } catch (err) {
        logger.warn({ err, sig, target: target.name }, "MigrationWatcher: Error processing transaction");
      }
    }

    // Advance cursor
    setRelayerState(target.stateKey, signatures[0].signature);
  }

  /**
   * Determine if a detected pool should be auto-migrated.
   */
  private shouldMigrate(event: PoolCreationEvent): boolean {
    // Check blacklist
    if (this.migrationConfig.blacklistedMints.has(event.baseMint)) {
      return false;
    }

    // Whitelisted tokens always pass
    if (this.migrationConfig.whitelistedMints.has(event.baseMint)) {
      return true;
    }

    // Check minimum liquidity (quote side, typically SOL)
    if (event.quoteAmount < this.migrationConfig.minLiquidityLamports) {
      return false;
    }

    return true;
  }
}
