import { getRelayerState, setRelayerState } from "../db/index.js";
import { L2Client } from "../solana/l2-client.js";
import { L1Client } from "../solana/l1-client.js";
import { WithdrawProcessor } from "../processors/withdraw.processor.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const STATE_KEY_LAST_SIG = "l2_last_seen_signature";

export class L2Watcher {
  private l2Client: L2Client;
  private withdrawProcessor: WithdrawProcessor;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(l2Client: L2Client, l1Client: L1Client) {
    this.l2Client = l2Client;
    this.withdrawProcessor = new WithdrawProcessor(l1Client);
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info(
      { program: config.L2_BRIDGE_PROGRAM, rpc: config.L2_RPC_URL },
      "L2Watcher: Starting — watching for BridgeToL1 withdrawal events"
    );
    await this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("L2Watcher: Stopped");
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.poll();
    }, config.POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (err) {
      logger.error({ err }, "L2Watcher: Unhandled error in poll cycle");
    } finally {
      this.schedule();
    }
  }

  private async pollOnce(): Promise<void> {
    // ── Part 1: Watch for new BurnWrapped events ──────────────────────────────
    const lastSig = getRelayerState(STATE_KEY_LAST_SIG) ?? undefined;

    logger.debug(
      { lastSig: lastSig ?? "none" },
      "L2Watcher: Fetching signatures"
    );

    const signatures = await this.l2Client.getRecentSignatures(
      undefined,
      config.SIGNATURES_FETCH_LIMIT
    );

    if (signatures.length > 0) {
      // Collect new signatures since last seen
      const newSigs: typeof signatures = [];
      for (const sigInfo of signatures) {
        if (sigInfo.signature === lastSig) break;
        if (sigInfo.err !== null) continue;
        newSigs.push(sigInfo);
      }

      if (newSigs.length > 0) {
        logger.info(
          { count: newSigs.length },
          "L2Watcher: Processing new signatures"
        );

        // Process oldest-first
        const ordered = [...newSigs].reverse();

        for (const sigInfo of ordered) {
          const sig = sigInfo.signature;
          const tx = await this.l2Client.getTransaction(sig);

          if (!tx) {
            logger.warn(
              { sig },
              "L2Watcher: Could not fetch transaction, skipping"
            );
            continue;
          }

          const logs = L2Client.extractLogs(tx);
          const burnEvent = L2Client.parseBurnEvent(logs);

          if (!burnEvent) {
            // Not a burn transaction — skip
            continue;
          }

          logger.info(
            {
              sig,
              burner: burnEvent.burner,
              l1Recipient: burnEvent.l1Recipient,
              amount: burnEvent.amount.toString(),
              burnNonce: burnEvent.burnNonce.toString(),
              l1Mint: burnEvent.l1Mint,
            },
            "L2Watcher: BridgeToL1 event detected"
          );

          try {
            await this.withdrawProcessor.recordBurn(sig, burnEvent);
          } catch (err) {
            logger.error(
              { err, sig },
              "L2Watcher: Failed to record burn event"
            );
          }
        }

        // Advance the cursor to the newest signature seen
        setRelayerState(STATE_KEY_LAST_SIG, signatures[0].signature);
      } else {
        logger.debug("L2Watcher: No new signatures since last poll");
      }
    }

    // ── Part 2: Initiate mature withdrawals on L1 ────────────────────────────
    try {
      await this.withdrawProcessor.processMatureWithdrawals();
    } catch (err) {
      logger.error(
        { err },
        "L2Watcher: Error initiating mature withdrawals"
      );
    }

    // ── Part 3: Finalize initiated withdrawals on L1 ──────────────────────────
    try {
      await this.withdrawProcessor.processInitiatedWithdrawals();
    } catch (err) {
      logger.error(
        { err },
        "L2Watcher: Error finalizing initiated withdrawals"
      );
    }
  }
}
