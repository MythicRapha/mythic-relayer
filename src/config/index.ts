import dotenv from "dotenv";
import path from "path";

// Load .env from the project root
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  // Network
  L1_RPC_URL: optionalEnv("L1_RPC_URL", "https://api.devnet.solana.com"),
  L2_RPC_URL: optionalEnv("L2_RPC_URL", "http://MYTHIC_SERVER_IP:8899"),
  NETWORK: optionalEnv("NETWORK", "devnet"),

  // Programs
  L1_BRIDGE_PROGRAM: optionalEnv(
    "L1_BRIDGE_PROGRAM",
    "MythBrdg11111111111111111111111111111111111"
  ),
  L2_BRIDGE_PROGRAM: optionalEnv(
    "L2_BRIDGE_PROGRAM",
    "MythBrdgL2111111111111111111111111111111111"
  ),
  MYTH_TOKEN_MINT: optionalEnv(
    "MYTH_TOKEN_MINT",
    "MythToken1111111111111111111111111111111111"
  ),

  // Keypair
  RELAYER_KEYPAIR_PATH: optionalEnv(
    "RELAYER_KEYPAIR_PATH",
    "/mnt/data/mythic-l2/keys/relayer.json"
  ),

  // Database
  DB_PATH: optionalEnv("DB_PATH", "./data/relayer.db"),

  // Timing
  POLL_INTERVAL_MS: parseInt(optionalEnv("POLL_INTERVAL_MS", "5000"), 10),
  CHALLENGE_PERIOD_SECONDS: parseInt(
    optionalEnv("CHALLENGE_PERIOD_SECONDS", "604800"),
    10
  ),

  // Logging
  LOG_LEVEL: optionalEnv("LOG_LEVEL", "info"),

  // Internal constants
  MAX_DEPOSIT_RETRIES: 3,
  MAX_WITHDRAWAL_RETRIES: 3,
  SIGNATURES_FETCH_LIMIT: 100,
} as const;

export type Config = typeof config;
