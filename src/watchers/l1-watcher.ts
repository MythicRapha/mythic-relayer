import { getRelayerState, setRelayerState } from "../db/index.js";
import { L1Client } from "../solana/l1-client.js";
import { L2Client } from "../solana/l2-client.js";
import { DepositProcessor } from "../processors/deposit.processor.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const STATE_KEY_LAST_SIG = "l1_last_seen_signature";

export class L1Watcher {
  private l1Client: L1Client;
  private depositProcessor: DepositProcessor;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(l1Client: L1Client, l2Client: L2Client) {
    this.l1Client = l1Client;
    this.depositProcessor = new DepositProcessor(l2Client);
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info(
      { program: config.L1_BRIDGE_PROGRAM, rpc: config.L1_RPC_URL },
      "L1Watcher: Starting — watching for deposit events"
    );
    await this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("L1Watcher: Stopped");
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
      logger.error({ err }, "L1Watcher: Unhandled error in poll cycle");
    } finally {
      this.schedule();
    }
  }

  private async pollOnce(): Promise<void> {
    // Load the last processed signature so we only fetch new ones
    const lastSig = getRelayerState(STATE_KEY_LAST_SIG) ?? undefined;

    logger.debug(
      { lastSig: lastSig ?? "none" },
      "L1Watcher: Fetching signatures"
    );

    // getSignaturesForAddress returns newest-first; "before" param means
    // "return signatures older than this one", so we use "until" semantics by
    // fetching without "before" and stopping when we hit the lastSig.
    const signatures = await this.l1Client.getRecentSignatures(
      undefined,
      config.SIGNATURES_FETCH_LIMIT
    );

    if (signatures.length === 0) {
      logger.debug("L1Watcher: No signatures returned");
      return;
    }

    // Signatures are newest-first. We process oldest-first to maintain ordering.
    // Collect only new signatures (those we haven't seen yet).
    const newSigs: typeof signatures = [];
    for (const sigInfo of signatures) {
      if (sigInfo.signature === lastSig) break;
      if (sigInfo.err !== null) continue; // skip failed txs
      newSigs.push(sigInfo);
    }

    if (newSigs.length === 0) {
      logger.debug("L1Watcher: No new signatures since last poll");
      return;
    }

    logger.info({ count: newSigs.length }, "L1Watcher: Processing new signatures");

    // Process oldest-first (reverse the newest-first list)
    const ordered = [...newSigs].reverse();

    let newestProcessed: string | null = null;

    for (const sigInfo of ordered) {
      const sig = sigInfo.signature;
      const tx = await this.l1Client.getTransaction(sig);

      if (!tx) {
        logger.warn({ sig }, "L1Watcher: Could not fetch transaction, skipping");
        continue;
      }

      const logs = L1Client.extractLogs(tx);
      const depositEvent = L1Client.parseDepositEvent(logs);

      if (!depositEvent) {
        // Not a deposit transaction — mark as seen but skip processing
        newestProcessed = sig;
        continue;
      }

      logger.info(
        {
          sig,
          depositor: depositEvent.depositor,
          l2Recipient: depositEvent.l2Recipient,
          amount: depositEvent.amount.toString(),
          nonce: depositEvent.nonce.toString(),
          isSol: depositEvent.isSol,
        },
        "L1Watcher: Deposit event detected"
      );

      try {
        await this.depositProcessor.processDeposit(sig, depositEvent);
        newestProcessed = sig;
      } catch (err) {
        logger.error({ err, sig }, "L1Watcher: Failed to process deposit");
        // Still advance the cursor so we don't get stuck
        newestProcessed = sig;
      }
    }

    // Persist the newest signature we've seen so next poll starts here
    if (newestProcessed) {
      // The newest in the newest-first list is signatures[0]
      // We want to store signatures[0] so next poll stops there
      setRelayerState(STATE_KEY_LAST_SIG, signatures[0].signature);
    }
  }
}
