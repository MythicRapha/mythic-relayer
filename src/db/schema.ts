// Database schema definitions for the Mythic Bridge Relayer

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  l1_tx_signature TEXT UNIQUE NOT NULL,
  depositor_l1 TEXT NOT NULL,
  recipient_l2 TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_lamports INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  l2_tx_signature TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  l2_tx_signature TEXT UNIQUE NOT NULL,
  withdrawer_l2 TEXT NOT NULL,
  recipient_l1 TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_lamports INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  challenge_expires_at INTEGER NOT NULL,
  l1_tx_signature TEXT,
  burn_nonce INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relayer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_l1_tx ON deposits(l1_tx_signature);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_challenge ON withdrawals(challenge_expires_at);
CREATE INDEX IF NOT EXISTS idx_withdrawals_l2_tx ON withdrawals(l2_tx_signature);
`;

// Status enums
export type DepositStatus =
  | "pending"
  | "minting"
  | "completed"
  | "failed";

export type WithdrawalStatus =
  | "pending"
  | "challenge"
  | "releasing"
  | "completed"
  | "failed";

// Row types matching the schema
export interface DepositRow {
  id: string;
  l1_tx_signature: string;
  depositor_l1: string;
  recipient_l2: string;
  asset: string;
  amount_lamports: number;
  status: DepositStatus;
  l2_tx_signature: string | null;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export interface WithdrawalRow {
  id: string;
  l2_tx_signature: string;
  withdrawer_l2: string;
  recipient_l1: string;
  asset: string;
  amount_lamports: number;
  status: WithdrawalStatus;
  challenge_expires_at: number;
  l1_tx_signature: string | null;
  burn_nonce: number;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export interface RelayerStateRow {
  key: string;
  value: string;
}
