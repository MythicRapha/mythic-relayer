import { PublicKey } from "@solana/web3.js";
import {
  getWithdrawalByL2Sig,
  insertWithdrawal,
  updateWithdrawalStatus,
  incrementWithdrawalRetry,
  getWithdrawalRetryCount,
  getWithdrawalsReadyToRelease,
} from "../db/index.js";
import { BurnEvent } from "../solana/l2-client.js";
import { L1Client } from "../solana/l1-client.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export class WithdrawProcessor {
  private l1Client: L1Client;

  constructor(l1Client: L1Client) {
    this.l1Client = l1Client;
  }

  /**
   * Record a newly observed L2 burn event and start the challenge clock.
   * Idempotent: if already recorded, does nothing.
   */
  async recordBurn(l2TxSignature: string, event: BurnEvent): Promise<void> {
    const childLog = logger.child({
      l2TxSig: l2TxSignature,
      burnNonce: event.burnNonce.toString(),
      amount: event.amount.toString(),
    });

    // Idempotency: if already in DB, skip
    const existing = getWithdrawalByL2Sig(l2TxSignature);
    if (existing) {
      childLog.debug("Burn event already recorded, skipping");
      return;
    }

    const recipientPubkey = hexToPubkey(event.l1Recipient);
    if (!recipientPubkey) {
      childLog.error(
        { l1Recipient: event.l1Recipient },
        "Invalid L1 recipient hex — cannot decode pubkey"
      );
      return;
    }

    const now = Date.now();
    const challengeExpiresAt =
      Math.floor(now / 1000) + config.CHALLENGE_PERIOD_SECONDS;

    const withdrawalId = generateId();
    insertWithdrawal({
      id: withdrawalId,
      l2_tx_signature: l2TxSignature,
      withdrawer_l2: event.burner,
      recipient_l1: recipientPubkey.toBase58(),
      asset: assetName(event.l1Mint),
      amount_lamports: Number(event.amount),
      status: "challenge",
      challenge_expires_at: challengeExpiresAt,
      burn_nonce: Number(event.burnNonce),
      created_at: now,
      updated_at: now,
    });

    childLog.info(
      {
        withdrawalId,
        recipient: recipientPubkey.toBase58(),
        challengeExpiresAt: new Date(challengeExpiresAt * 1000).toISOString(),
      },
      "Burn recorded — challenge window started"
    );
  }

  /**
   * Check all withdrawals whose challenge period has expired and release tokens on L1.
   * Called on every poll cycle by the L2 watcher.
   */
  async processMatureWithdrawals(): Promise<void> {
    const ready = getWithdrawalsReadyToRelease();

    if (ready.length === 0) return;

    logger.info({ count: ready.length }, "Processing mature withdrawals");

    for (const withdrawal of ready) {
      const childLog = logger.child({
        withdrawalId: withdrawal.id,
        burnNonce: withdrawal.burn_nonce,
        recipient: withdrawal.recipient_l1,
      });

      // Check retry count
      const retries = getWithdrawalRetryCount(withdrawal.id);
      if (retries >= config.MAX_WITHDRAWAL_RETRIES) {
        childLog.error("Withdrawal exceeded max retries, marking failed");
        updateWithdrawalStatus(withdrawal.id, "failed");
        continue;
      }

      // Double-check challenge period has genuinely expired
      const now = Math.floor(Date.now() / 1000);
      if (withdrawal.challenge_expires_at > now) {
        childLog.debug("Challenge period not yet expired, skipping");
        continue;
      }

      updateWithdrawalStatus(withdrawal.id, "releasing");

      try {
        const recipient = new PublicKey(withdrawal.recipient_l1);
        const tokenMint = new PublicKey(resolveTokenMint(withdrawal.asset));
        const nonce = BigInt(withdrawal.burn_nonce);

        // Derive the recipient's ATA for the token
        // Note: for a real production deployment, we would use finalize_withdrawal
        // on the L1 bridge program which releases from the escrow vault.
        // Here we call initiateWithdrawal (which the sequencer posts to start the process).
        // In the full flow the actual token transfer happens via FinalizeWithdrawal
        // after the challenge window, which any party can call.
        childLog.info(
          { nonce: nonce.toString(), asset: withdrawal.asset },
          "Submitting InitiateWithdrawal to L1"
        );

        const l1TxSig = await this.l1Client.initiateWithdrawal({
          recipient,
          amount: BigInt(withdrawal.amount_lamports),
          tokenMint,
          nonce,
        });

        updateWithdrawalStatus(withdrawal.id, "completed", l1TxSig);
        childLog.info({ l1TxSig }, "Withdrawal relayed to L1 successfully");
      } catch (err) {
        incrementWithdrawalRetry(withdrawal.id);
        const retries = getWithdrawalRetryCount(withdrawal.id);
        childLog.error({ err, retries }, "Failed to relay withdrawal to L1");

        if (retries >= config.MAX_WITHDRAWAL_RETRIES) {
          updateWithdrawalStatus(withdrawal.id, "failed");
          childLog.error("Withdrawal marked as failed after max retries");
        } else {
          // Reset to challenge so it can be retried
          updateWithdrawalStatus(withdrawal.id, "challenge");
        }
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

function assetName(tokenMint: string): string {
  const mintToName: Record<string, string> = {
    MythToken1111111111111111111111111111111111: "MYTH",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    So11111111111111111111111111111111111111112: "SOL",
  };
  return mintToName[tokenMint] ?? tokenMint.slice(0, 8);
}

function resolveTokenMint(asset: string): string {
  const assetToMint: Record<string, string> = {
    MYTH: config.MYTH_TOKEN_MINT,
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    SOL: "So11111111111111111111111111111111111111112",
  };
  return assetToMint[asset] ?? config.MYTH_TOKEN_MINT;
}

function generateId(): string {
  const ts = Date.now().toString(16);
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${ts}-${rand}`;
}
