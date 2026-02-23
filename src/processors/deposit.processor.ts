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
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export class DepositProcessor {
  private l2Client: L2Client;

  constructor(l2Client: L2Client) {
    this.l2Client = l2Client;
  }

  /**
   * Process a single deposit event observed on L1.
   * Idempotent: if the deposit has already been processed, this is a no-op.
   *
   * Flow:
   *  1. Check if already processed in DB
   *  2. Insert record if new
   *  3. Build MintWrapped instruction on L2
   *  4. Sign and submit to L2 RPC
   *  5. Mark as completed in DB
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
      // If pending/minting, check retry count
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

  private async attemptMint(
    depositId: string,
    l1TxSignature: string,
    event: DepositEvent,
    log: typeof logger
  ): Promise<void> {
    updateDepositStatus(depositId, "minting");

    try {
      // Convert hex-encoded l2_recipient to a PublicKey
      const recipientPubkey = hexToPubkey(event.l2Recipient);
      if (!recipientPubkey) {
        log.error(
          { l2Recipient: event.l2Recipient },
          "Invalid L2 recipient hex — cannot decode pubkey"
        );
        updateDepositStatus(depositId, "failed");
        return;
      }

      // Determine the L1 mint PublicKey (use MYTH token if SOL deposit)
      const l1MintPubkey = event.isSol
        ? new PublicKey(config.MYTH_TOKEN_MINT)
        : new PublicKey(event.tokenMint);

      // Convert the L1 tx signature (base58) to a 64-byte array
      const sigBytes = decodeSignatureToBytes(l1TxSignature);

      log.info(
        {
          recipient: recipientPubkey.toBase58(),
          l1Mint: l1MintPubkey.toBase58(),
          nonce: event.nonce.toString(),
        },
        "Submitting MintWrapped to L2"
      );

      const l2TxSig = await this.l2Client.mintWrapped({
        l1Mint: l1MintPubkey,
        recipient: recipientPubkey,
        amount: event.amount,
        depositNonce: event.nonce,
        l1TxSignature: sigBytes,
      });

      updateDepositStatus(depositId, "completed", l2TxSig);
      log.info({ l2TxSig }, "Deposit relayed successfully");
    } catch (err) {
      incrementDepositRetry(depositId);
      const retries = getDepositRetryCount(depositId);
      log.error({ err, retries }, "Failed to mint on L2");

      if (retries >= config.MAX_DEPOSIT_RETRIES) {
        updateDepositStatus(depositId, "failed");
        log.error({ depositId }, "Deposit marked as failed after max retries");
      } else {
        // Reset back to pending so the next poll cycle will retry
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
    // Solana signatures are base58-encoded 64-byte arrays
    const decoded = bs58.decode(sig);
    if (decoded.length === 64) return decoded;
  } catch {
    // fall through
  }
  // Fallback: return zeroed 64 bytes
  return new Uint8Array(64);
}

function assetName(tokenMint: string): string {
  const mintToName: Record<string, string> = {
    MythToken1111111111111111111111111111111111: "MYTH",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    So11111111111111111111111111111111111111112: "SOL",
  };
  return mintToName[tokenMint] ?? tokenMint.slice(0, 8);
}

function generateId(): string {
  // Use a simple timestamp + random hex to avoid importing uuid
  const ts = Date.now().toString(16);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${ts}-${rand}`;
}
