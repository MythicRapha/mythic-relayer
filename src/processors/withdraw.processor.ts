import { PublicKey } from "@solana/web3.js";
import {
  getDb,
  getWithdrawalByL2Sig,
  insertWithdrawal,
  updateWithdrawalStatus,
  incrementWithdrawalRetry,
  getWithdrawalRetryCount,
  getWithdrawalsReadyToRelease,
  getInitiatedWithdrawalsReadyToFinalize,
} from "../db/index.js";
import { BurnEvent } from "../solana/l2-client.js";
import { L1Client } from "../solana/l1-client.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// L2 has 9 decimals, L1 has 6 decimals. Factor = 1000.
const DECIMAL_SCALING_FACTOR = 1000n;

// Addresses blocked from L2->L1 withdrawals
const WITHDRAWAL_BLACKLIST = new Set([
  "8KgM7vY56ETVgMC8MEHiXsbkjXw59Hsjc6tFdL6t1Xr4",
]);

export class WithdrawProcessor {
  private l1Client: L1Client;

  constructor(l1Client: L1Client) {
    this.l1Client = l1Client;
  }

  /**
   * Record a newly observed L2 burn event and start the local challenge clock.
   * Idempotent: if already recorded, does nothing.
   */
  async recordBurn(l2TxSignature: string, event: BurnEvent): Promise<void> {
    if (WITHDRAWAL_BLACKLIST.has(event.burner)) {
      logger.warn(
        { burner: event.burner, l2TxSig: l2TxSignature },
        "BLOCKED: Withdrawal from blacklisted address"
      );
      return;
    }

    const childLog = logger.child({
      l2TxSig: l2TxSignature,
      burnNonce: event.burnNonce.toString(),
      amount: event.amount.toString(),
    });

    const existing = getWithdrawalByL2Sig(l2TxSignature);
    if (existing) {
      childLog.debug("Burn event already recorded, skipping");
      return;
    }

    const recipientPubkey = hexToPubkey(event.l1Recipient);
    if (!recipientPubkey) {
      childLog.error(
        { l1Recipient: event.l1Recipient },
        "Invalid L1 recipient hex"
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
      "Burn recorded — local challenge started"
    );
  }

  /**
   * Phase 1: Process withdrawals whose LOCAL challenge has expired.
   * Calls InitiateWithdrawal on L1 to create the WithdrawalRequest PDA
   * and start the on-chain challenge period.
   */
  async processMatureWithdrawals(): Promise<void> {
    const ready = getWithdrawalsReadyToRelease();
    if (ready.length === 0) return;

    logger.info({ count: ready.length }, "Phase 1: Initiating withdrawals on L1");

    for (const withdrawal of ready) {
      const childLog = logger.child({
        withdrawalId: withdrawal.id,
        burnNonce: withdrawal.burn_nonce,
        recipient: withdrawal.recipient_l1,
      });

      const retries = getWithdrawalRetryCount(withdrawal.id);
      if (retries >= config.MAX_WITHDRAWAL_RETRIES) {
        childLog.error("InitiateWithdrawal exceeded max retries, marking failed");
        updateWithdrawalStatus(withdrawal.id, "failed");
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      if (withdrawal.challenge_expires_at > now) {
        continue;
      }

      updateWithdrawalStatus(withdrawal.id, "releasing");

      try {
        const recipient = new PublicKey(withdrawal.recipient_l1);
        const tokenMint = new PublicKey(resolveTokenMint(withdrawal.asset));
        const nonce = BigInt(withdrawal.burn_nonce);

        // Convert L2 lamports (9 decimals) to L1 lamports (6 decimals)
        const l2Amount = BigInt(withdrawal.amount_lamports);
        const l1Amount = l2Amount / DECIMAL_SCALING_FACTOR;

        // Find available L1 nonce (may differ from L2 burn nonce if nonce is taken)
        const l1Nonce = await this.l1Client.findAvailableL1Nonce(nonce);

        childLog.info(
          {
            l2BurnNonce: nonce.toString(),
            l1Nonce: l1Nonce.toString(),
            l2Amount: l2Amount.toString(),
            l1Amount: l1Amount.toString(),
            l1MythReadable: (Number(l1Amount) / 1e6).toFixed(6),
          },
          "Submitting InitiateWithdrawal to L1"
        );

        const l1TxSig = await this.l1Client.initiateWithdrawal({
          recipient,
          amount: l1Amount,
          tokenMint,
          nonce: l1Nonce,
        });

        // Store the L1 nonce used (may differ from burn_nonce)
        getDb()
          .prepare("UPDATE withdrawals SET burn_nonce = ? WHERE id = ?")
          .run(Number(l1Nonce), withdrawal.id);

        // Move to "initiated" — reuse challenge_expires_at for L1 deadline
        const l1ChallengeExpiresAt =
          Math.floor(Date.now() / 1000) + config.L1_CHALLENGE_PERIOD_SECONDS;

        getDb()
          .prepare(
            "UPDATE withdrawals SET status = ?, l1_tx_signature = ?, challenge_expires_at = ?, retry_count = 0, updated_at = ? WHERE id = ?"
          )
          .run("initiated", l1TxSig, l1ChallengeExpiresAt, Date.now(), withdrawal.id);

        childLog.info(
          {
            l1TxSig,
            finalizableAt: new Date(l1ChallengeExpiresAt * 1000).toISOString(),
          },
          "InitiateWithdrawal OK — waiting for L1 challenge period"
        );
      } catch (err) {
        incrementWithdrawalRetry(withdrawal.id);
        const retries = getWithdrawalRetryCount(withdrawal.id);
        childLog.error({ err, retries }, "Failed to initiate withdrawal on L1");

        if (retries >= config.MAX_WITHDRAWAL_RETRIES) {
          updateWithdrawalStatus(withdrawal.id, "failed");
        } else {
          updateWithdrawalStatus(withdrawal.id, "challenge");
        }
      }
    }
  }

  /**
   * Phase 2: Finalize withdrawals whose L1 challenge period has expired.
   * Ensures recipient ATA exists, then calls FinalizeWithdrawal on L1
   * to release tokens from the vault to the recipient.
   */
  async processInitiatedWithdrawals(): Promise<void> {
    const ready = getInitiatedWithdrawalsReadyToFinalize();
    if (ready.length === 0) return;

    logger.info({ count: ready.length }, "Phase 2: Finalizing withdrawals on L1");

    for (const withdrawal of ready) {
      const childLog = logger.child({
        withdrawalId: withdrawal.id,
        burnNonce: withdrawal.burn_nonce,
        recipient: withdrawal.recipient_l1,
      });

      const retries = getWithdrawalRetryCount(withdrawal.id);
      if (retries >= config.MAX_WITHDRAWAL_RETRIES) {
        childLog.error("FinalizeWithdrawal exceeded max retries, marking failed");
        updateWithdrawalStatus(withdrawal.id, "failed");
        continue;
      }

      try {
        const recipient = new PublicKey(withdrawal.recipient_l1);
        const tokenMint = new PublicKey(resolveTokenMint(withdrawal.asset));
        const nonce = BigInt(withdrawal.burn_nonce);

        // Ensure recipient has ATA for the token (Token-2022)
        const recipientAta = await this.l1Client.ensureRecipientATA(
          recipient,
          tokenMint
        );

        childLog.info(
          {
            nonce: nonce.toString(),
            recipientAta: recipientAta.toBase58(),
          },
          "Submitting FinalizeWithdrawal to L1"
        );

        const l1TxSig = await this.l1Client.finalizeWithdrawal({
          nonce,
          tokenMint,
          recipientTokenAccount: recipientAta,
        });

        updateWithdrawalStatus(withdrawal.id, "completed", l1TxSig);
        childLog.info({ l1TxSig }, "Withdrawal finalized — tokens released on L1!");
      } catch (err) {
        incrementWithdrawalRetry(withdrawal.id);
        childLog.error({ err }, "Failed to finalize withdrawal on L1");
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
