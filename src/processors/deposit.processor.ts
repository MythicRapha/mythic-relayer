import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  getDepositByL1Sig,
  insertDeposit,
  updateDepositStatus,
  incrementDepositRetry,
  getDepositRetryCount,
} from "../db/index.js";
import { L1Client, DepositEvent } from "../solana/l1-client.js";
import { L2Client } from "../solana/l2-client.js";
import { swapSolForMyth, transferMythToVault, MYTH_MINT, getPoolReserves, calculateBuyOutputExported } from "../solana/pumpswap.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// MYTH on L1 has 6 decimals, L2 native has 9 decimals
const MYTH_L1_TO_L2_SCALE = BigInt(1000);

// Minimum relayer SOL balance to attempt on-chain swap (0.05 SOL)
const MIN_SOL_FOR_SWAP = BigInt(50_000_000);

export class DepositProcessor {
  private l1Client: L1Client;
  private l2Client: L2Client;

  constructor(l2Client: L2Client, l1Client: L1Client) {
    this.l2Client = l2Client;
    this.l1Client = l1Client;
  }

  /**
   * Process a single deposit event observed on L1.
   * Idempotent: if the deposit has already been processed, this is a no-op.
   */
  async processDeposit(
    l1TxSignature: string,
    event: DepositEvent
  ): Promise<void> {
    const childLog = logger.child({
      l1TxSig: l1TxSignature,
      nonce: event.nonce.toString(),
      amount: event.amount.toString(),
    });

    // Step 1: idempotency check
    const existing = getDepositByL1Sig(l1TxSignature);
    if (existing) {
      if (existing.status === "completed") {
        childLog.debug("Deposit already completed, skipping");
        return;
      }
      if (existing.status === "failed") {
        childLog.warn("Deposit previously failed, not retrying");
        return;
      }
      const retries = getDepositRetryCount(existing.id);
      if (retries >= config.MAX_DEPOSIT_RETRIES) {
        childLog.error(
          { retries },
          "Deposit exceeded max retries, marking failed"
        );
        updateDepositStatus(existing.id, "failed");
        return;
      }
      childLog.info({ retries }, "Retrying deposit that was pending/minting");
      await this.attemptMint(existing.id, l1TxSignature, event, childLog as typeof logger);
      return;
    }

    // Step 2: insert new deposit record
    const depositId = generateId();
    const now = Date.now();
    insertDeposit({
      id: depositId,
      l1_tx_signature: l1TxSignature,
      depositor_l1: event.depositor,
      recipient_l2: event.l2Recipient,
      asset: event.isSol ? "SOL" : assetName(event.tokenMint),
      amount_lamports: Number(event.amount),
      status: "pending",
      created_at: now,
      updated_at: now,
    });

    childLog.info({ depositId }, "New deposit recorded — starting L2 mint");
    await this.attemptMint(depositId, l1TxSignature, event, childLog as typeof logger);
  }

  /**
   * For SOL deposits: determine L2 MYTH amount.
   *
   * Strategy:
   *   1. Try to withdraw SOL from bridge vault + do an actual PumpSwap swap
   *   2. If that fails (not enough SOL, program not upgraded, etc.),
   *      fall back to calculating the MYTH equivalent from pool reserves.
   *      SOL stays in the vault as collateral.
   */
  private async swapAndVault(
    event: DepositEvent,
    log: typeof logger,
  ): Promise<bigint> {
    const conn = this.l1Client.connection;
    const relayer = this.l1Client.relayer;

    log.info({
      solLamports: event.amount.toString(),
      solAmount: (Number(event.amount) / 1e9).toFixed(4),
    }, "PumpSwap: starting SOL → MYTH conversion");

    // Check relayer SOL balance to decide strategy
    let relayerBalance = BigInt(0);
    try {
      relayerBalance = BigInt(await conn.getBalance(relayer.publicKey));
      log.info({ relayerBalance: relayerBalance.toString() }, "Relayer SOL balance");
    } catch {}

    // Strategy 1: Try vault withdrawal + on-chain swap (requires bridge upgrade)
    const totalNeeded = event.amount + MIN_SOL_FOR_SWAP;
    if (relayerBalance >= totalNeeded) {
      // Relayer has enough SOL — do the on-chain swap directly
      try {
        return await this.doOnChainSwap(event, log);
      } catch (err) {
        log.warn({ err }, "PumpSwap: on-chain swap failed, falling back to rate-based credit");
      }
    } else {
      // Check vault balance before attempting withdrawal to avoid generating failed L1 txs
      try {
        const solVault = this.l1Client.solVaultPda();
        const vaultBalance = BigInt(await conn.getBalance(solVault));
        log.info({ vaultBalance: vaultBalance.toString(), needed: event.amount.toString() }, "PumpSwap: vault balance check");

        if (vaultBalance >= event.amount + BigInt(10_000_000)) {
          // Vault has enough — withdraw and swap
          const withdrawTx = await this.l1Client.withdrawSolFromVault(event.amount);
          log.info({ withdrawTx }, "PumpSwap: withdrew SOL from vault");
          return await this.doOnChainSwap(event, log);
        } else {
          log.info("PumpSwap: vault balance too low for withdrawal, using rate-based credit");
        }
      } catch (err) {
        log.warn({ err }, "PumpSwap: vault balance check or withdraw failed, using rate-based credit");
      }
    }

    // Strategy 2: Calculate MYTH equivalent from PumpSwap pool reserves
    // SOL stays in vault as collateral, MYTH credited on L2 at market rate
    return await this.calculateMythFromPoolRate(event, log);
  }

  /**
   * Execute the actual on-chain PumpSwap swap and vault the MYTH.
   */
  private async doOnChainSwap(
    event: DepositEvent,
    log: typeof logger,
  ): Promise<bigint> {
    const conn = this.l1Client.connection;
    const relayer = this.l1Client.relayer;

    const swap = await swapSolForMyth(conn, relayer, event.amount, 500);

    log.info({
      swapTx: swap.txSignature,
      mythReceivedL1: swap.mythReceived.toString(),
      mythReadable: (Number(swap.mythReceived) / 1e6).toFixed(2),
    }, "PumpSwap: swap executed, depositing MYTH to bridge vault");

    // Transfer received MYTH to the bridge MYTH vault (best-effort)
    const bridgeMythVault = this.l1Client.vaultPda(MYTH_MINT);
    try {
      const vaultTx = await transferMythToVault(conn, relayer, bridgeMythVault, swap.mythReceived);
      log.info({ vaultTx }, "PumpSwap: MYTH deposited to bridge vault");
    } catch (err) {
      log.warn({ err }, "PumpSwap: failed to deposit MYTH to vault (non-fatal)");
    }

    // Convert L1 MYTH (6 decimals) → L2 MYTH (9 decimals)
    const l2Amount = swap.mythReceived * MYTH_L1_TO_L2_SCALE;

    log.info({
      mythL1: swap.mythReceived.toString(),
      mythL2: l2Amount.toString(),
      mythL2Readable: (Number(l2Amount) / 1e9).toFixed(4),
      method: "on-chain-swap",
    }, "PumpSwap: L2 amount calculated");

    return l2Amount;
  }

  /**
   * Calculate MYTH equivalent from PumpSwap pool reserves WITHOUT doing an on-chain swap.
   * The deposited SOL stays in the vault as collateral.
   * Uses the same constant-product AMM math as the actual swap.
   */
  private async calculateMythFromPoolRate(
    event: DepositEvent,
    log: typeof logger,
  ): Promise<bigint> {
    const conn = this.l1Client.connection;

    // Fetch current pool reserves
    const reserves = await getPoolReserves(conn);

    // Calculate MYTH output using AMM math (same formula as PumpSwap)
    const mythOutL1 = calculateBuyOutputExported(event.amount, reserves.solReserve, reserves.mythReserve);

    if (mythOutL1 <= BigInt(0)) {
      throw new Error("Pool has insufficient liquidity for rate calculation");
    }

    // Convert L1 MYTH (6 decimals) → L2 MYTH (9 decimals)
    const l2Amount = mythOutL1 * MYTH_L1_TO_L2_SCALE;

    log.info({
      solIn: event.amount.toString(),
      mythOutL1: mythOutL1.toString(),
      mythL2: l2Amount.toString(),
      mythL2Readable: (Number(l2Amount) / 1e9).toFixed(4),
      poolSol: reserves.solReserve.toString(),
      poolMyth: reserves.mythReserve.toString(),
      method: "rate-based",
    }, "PumpSwap: calculated MYTH from pool rate (no on-chain swap)");

    return l2Amount;
  }

  /**
   * Calculate the L2 MYTH amount for non-SOL deposits.
   * - MYTH SPL deposits: Scale from 6 decimals (L1) to 9 decimals (L2)
   * - Other tokens: Pass through (1:1 lamports)
   */
  private calculateL2Amount(event: DepositEvent, log: typeof logger): bigint {
    const mythMint = config.MYTH_TOKEN_MINT;
    const pumpMint = "5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump";
    if (event.tokenMint === mythMint || event.tokenMint === pumpMint) {
      const l2Amount = event.amount * MYTH_L1_TO_L2_SCALE;
      log.info({
        l1Amount: event.amount.toString(),
        l2Amount: l2Amount.toString(),
        scale: "1000x (6→9 decimals)",
      }, "Decimal conversion: MYTH L1 → L2");
      return l2Amount;
    }

    log.warn({ tokenMint: event.tokenMint }, "Unknown token — using 1:1 amount");
    return event.amount;
  }

  private async attemptMint(
    depositId: string,
    l1TxSignature: string,
    event: DepositEvent,
    log: typeof logger
  ): Promise<void> {
    updateDepositStatus(depositId, "minting");

    try {
      const recipientPubkey = hexToPubkey(event.l2Recipient);
      if (!recipientPubkey) {
        log.error(
          { l2Recipient: event.l2Recipient },
          "Invalid L2 recipient hex — cannot decode pubkey"
        );
        updateDepositStatus(depositId, "failed");
        return;
      }

      // Calculate L2 amount: SOL deposits go through PumpSwap, others are direct
      let l2Amount: bigint;
      if (event.isSol) {
        l2Amount = await this.swapAndVault(event, log);
      } else {
        l2Amount = this.calculateL2Amount(event, log);
      }

      const l1MintPubkey = event.isSol
        ? new PublicKey(config.MYTH_TOKEN_MINT)
        : new PublicKey(event.tokenMint);

      const sigBytes = decodeSignatureToBytes(l1TxSignature);

      log.info({
        recipient: recipientPubkey.toBase58(),
        l1Mint: l1MintPubkey.toBase58(),
        l1Amount: event.amount.toString(),
        l2Amount: l2Amount.toString(),
        nonce: event.nonce.toString(),
        method: event.isSol ? "pumpswap" : "direct",
      }, "Submitting ReleaseBridged to L2");

      const l2TxSig = await this.l2Client.mintWrapped({
        l1Mint: l1MintPubkey,
        recipient: recipientPubkey,
        amount: l2Amount,
        depositNonce: event.nonce,
        l1TxSignature: sigBytes,
      });

      updateDepositStatus(depositId, "completed", l2TxSig);
      log.info({
        l2TxSig,
        l2MythAmount: (Number(l2Amount) / 1e9).toFixed(4),
        method: event.isSol ? "pumpswap" : "direct",
      }, "Deposit relayed successfully");
    } catch (err) {
      incrementDepositRetry(depositId);
      const retries = getDepositRetryCount(depositId);
      log.error({ err, retries }, "Failed to mint on L2");

      if (retries >= config.MAX_DEPOSIT_RETRIES) {
        updateDepositStatus(depositId, "failed");
        log.error({ depositId }, "Deposit marked as failed after max retries");
      } else {
        updateDepositStatus(depositId, "pending");
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToPubkey(hexStr: string): PublicKey | null {
  if (hexStr.length !== 64) return null;
  try {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
    }
    return new PublicKey(bytes);
  } catch {
    return null;
  }
}

function decodeSignatureToBytes(sig: string): Uint8Array {
  try {
    const decoded = bs58.decode(sig);
    if (decoded.length === 64) return decoded;
  } catch {
    // fall through
  }
  return new Uint8Array(64);
}

function assetName(tokenMint: string): string {
  const mintToName: Record<string, string> = {
    MythToken1111111111111111111111111111111111: "MYTH",
    "5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump": "MYTH",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    So11111111111111111111111111111111111111112: "SOL",
  };
  return mintToName[tokenMint] ?? tokenMint.slice(0, 8);
}

function generateId(): string {
  const ts = Date.now().toString(16);
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${ts}-${rand}`;
}
