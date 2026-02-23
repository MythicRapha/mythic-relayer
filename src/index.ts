import fs from "fs";
import { Keypair } from "@solana/web3.js";
import { initDb } from "./db/index.js";
import { L1Watcher } from "./watchers/l1-watcher.js";
import { L2Watcher } from "./watchers/l2-watcher.js";
import { L1Client } from "./solana/l1-client.js";
import { L2Client } from "./solana/l2-client.js";
import { logger } from "./utils/logger.js";
import { config } from "./config/index.js";

async function loadKeypair(keypairPath: string): Promise<Keypair> {
  const resolved = keypairPath.startsWith("/")
    ? keypairPath
    : `${process.cwd()}/${keypairPath}`;

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Relayer keypair file not found: ${resolved}\n` +
        `Set RELAYER_KEYPAIR_PATH to the path of your relayer keypair JSON.`
    );
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

async function main(): Promise<void> {
  logger.info("Mythic Bridge Relayer starting...");

  // Load relayer keypair
  let relayerKeypair: Keypair;
  try {
    relayerKeypair = await loadKeypair(config.RELAYER_KEYPAIR_PATH);
  } catch (err) {
    logger.error(
      { err, keypairPath: config.RELAYER_KEYPAIR_PATH },
      "Failed to load relayer keypair"
    );
    process.exit(1);
  }

  logger.info(
    { pubkey: relayerKeypair.publicKey.toBase58() },
    "Relayer keypair loaded"
  );

  // Initialize the SQLite database
  try {
    initDb();
    logger.info({ dbPath: config.DB_PATH }, "Database initialized");
  } catch (err) {
    logger.error({ err }, "Failed to initialize database");
    process.exit(1);
  }

  // Create Solana clients
  const l1Client = new L1Client(relayerKeypair);
  const l2Client = new L2Client(relayerKeypair);

  // Log startup configuration
  logger.info(
    {
      l1Rpc: config.L1_RPC_URL,
      l2Rpc: config.L2_RPC_URL,
      l1Bridge: config.L1_BRIDGE_PROGRAM,
      l2Bridge: config.L2_BRIDGE_PROGRAM,
      mythToken: config.MYTH_TOKEN_MINT,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      challengePeriodSeconds: config.CHALLENGE_PERIOD_SECONDS,
      network: config.NETWORK,
    },
    "Relayer configuration"
  );

  // Create watchers
  const l1Watcher = new L1Watcher(l1Client, l2Client);
  const l2Watcher = new L2Watcher(l2Client, l1Client);

  // Start both watchers concurrently
  // Each watcher runs its own poll loop; start() kicks off the first poll
  // immediately and then schedules subsequent polls via setTimeout.
  await Promise.all([l1Watcher.start(), l2Watcher.start()]);

  logger.info(
    {
      l1: config.L1_RPC_URL,
      l2: config.L2_RPC_URL,
      pollInterval: config.POLL_INTERVAL_MS,
    },
    "Relayer active — watching both chains"
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Received shutdown signal");
    await l1Watcher.stop();
    await l2Watcher.stop();
    logger.info("Relayer stopped gracefully");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — relayer will exit");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
    // Don't exit — let the next poll cycle recover
  });
}

main().catch((err) => {
  logger.error({ err }, "Relayer crashed during startup");
  process.exit(1);
});
