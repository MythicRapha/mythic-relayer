// Restore L1 bridge challenge_period to 86400 (24 hours)
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";

const L1_RPC = "https://mainnet.helius-rpc.com/?api-key=60aa17ec-d160-4cd9-8a51-e74f693bc403";
const BRIDGE_PROGRAM = new PublicKey("oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ");

const connection = new Connection(L1_RPC, "confirmed");
const adminBytes = JSON.parse(fs.readFileSync("/mnt/data/mythic-l2/keys/deployer.json", "utf-8"));
const admin = Keypair.fromSecretKey(Uint8Array.from(adminBytes));

const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("bridge_config")], BRIDGE_PROGRAM
);

// UpdateConfig: new_sequencer=None, new_challenge_period=Some(86400)
const data = Buffer.alloc(11);
data.writeUInt8(6, 0); // IX_UPDATE_CONFIG
data.writeUInt8(0, 1); // None
data.writeUInt8(1, 2); // Some
data.writeBigInt64LE(86400n, 3);

const ix = new TransactionInstruction({
  programId: BRIDGE_PROGRAM,
  keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: true },
  ],
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
    commitment: "confirmed", skipPreflight: false,
  });
  console.log("SUCCESS: Challenge period restored to 86400 seconds (24 hours)");
  console.log("Tx:", sig);
} catch (err) {
  console.error("FAILED:", err.message);
}
