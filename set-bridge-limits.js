const { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require("fs");

async function main() {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/mnt/data/mythic-l2/keys/deployer.json", "utf8"))));
  
  const bridgeProgram = new PublicKey("oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ");
  const configPda = new PublicKey("4A76xw47iNfTkoC5dGSGND5DW5z3E5gPdjPzp8Gnk9s9");
  
  // IX 9 = SetLimits
  // SetLimitsParams: min_deposit_lamports (u64) + max_deposit_lamports (u64) + daily_limit_lamports (u64)
  const buf = Buffer.alloc(1 + 8 + 8 + 8);
  buf.writeUInt8(9, 0);  // IX discriminator
  
  // min_deposit: 10,000,000 lamports (0.01 SOL) - keep same
  buf.writeBigUInt64LE(10_000_000n, 1);
  
  // max_deposit: 1,000,000,000,000,000 (1 quadrillion - covers any token amount up to ~1B tokens with 6 decimals)
  buf.writeBigUInt64LE(1_000_000_000_000_000n, 9);
  
  // daily_limit: 100,000,000,000,000,000 (100 quadrillion)
  buf.writeBigUInt64LE(100_000_000_000_000_000n, 17);
  
  const ix = new TransactionInstruction({
    programId: bridgeProgram,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data: buf,
  });
  
  const tx = new Transaction().add(ix);
  
  console.log("Sending SetLimits tx...");
  console.log("  min_deposit: 10,000,000 (0.01 SOL)");
  console.log("  max_deposit: 1,000,000,000,000,000 (~1M SOL equiv)");
  console.log("  daily_limit: 100,000,000,000,000,000 (~100M SOL equiv)");
  
  const sig = await sendAndConfirmTransaction(conn, tx, [deployer]);
  console.log("SUCCESS:", sig);
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
