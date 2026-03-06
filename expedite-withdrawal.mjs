// Expedite withdrawal: set challenge_period to 3600 (minimum), reset failed withdrawal
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";

const L1_RPC = "https://mainnet.helius-rpc.com/?api-key=60aa17ec-d160-4cd9-8a51-e74f693bc403";
const BRIDGE_PROGRAM = new PublicKey("oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ");
const ADMIN_KEY_PATH = "/mnt/data/mythic-l2/keys/deployer.json";
const IX_UPDATE_CONFIG = 6;

const connection = new Connection(L1_RPC, "confirmed");

// Load admin keypair (deployer is the admin)
const adminBytes = JSON.parse(fs.readFileSync(ADMIN_KEY_PATH, "utf-8"));
const admin = Keypair.fromSecretKey(Uint8Array.from(adminBytes));
console.log("Admin:", admin.publicKey.toBase58());

// Derive bridge config PDA
const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("bridge_config")],
  BRIDGE_PROGRAM
);
console.log("Config PDA:", configPda.toBase58());

// Build UpdateConfig instruction
// UpdateConfigParams (Borsh):
//   new_sequencer: Option<Pubkey> = None (1 byte = 0)
//   new_challenge_period: Option<i64> = Some(3600) (1 byte = 1 + 8 bytes LE)
const data = Buffer.alloc(1 + 1 + 1 + 8); // discriminator + Option<Pubkey>(None) + Option<i64>(Some)
data.writeUInt8(IX_UPDATE_CONFIG, 0);
data.writeUInt8(0, 1); // None for new_sequencer
data.writeUInt8(1, 2); // Some for new_challenge_period
data.writeBigInt64LE(3600n, 3); // 3600 seconds = 1 hour

const accounts = [
  { pubkey: admin.publicKey, isSigner: true, isWritable: false }, // admin
  { pubkey: configPda, isSigner: false, isWritable: true },       // config
];

const ix = new TransactionInstruction({
  programId: BRIDGE_PROGRAM,
  keys: accounts,
  data,
});

const computeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 });

const { blockhash } = await connection.getLatestBlockhash("confirmed");
const tx = new Transaction();
tx.add(computeIx, ix);
tx.recentBlockhash = blockhash;
tx.feePayer = admin.publicKey;

try {
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  console.log("SUCCESS: Challenge period set to 3600 seconds (1 hour)");
  console.log("Tx:", sig);
} catch (err) {
  console.error("FAILED:", err.message);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
}
