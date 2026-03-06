#!/usr/bin/env npx tsx
// Test: Get a fresh Jupiter swap tx, simulate it, compare with our direct PumpSwap

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import * as fs from "fs";

const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=60aa17ec-d160-4cd9-8a51-e74f693bc403";

async function main() {
  const key = JSON.parse(fs.readFileSync("/mnt/data/mythic-l2/keys/sequencer-identity.json", "utf8"));
  const relayer = Keypair.fromSecretKey(Uint8Array.from(key));
  const connection = new Connection(HELIUS_RPC, "confirmed");

  // Step 1: Get Jupiter quote
  const quoteRes = await fetch(
    "https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump&amount=1000000&slippageBps=500"
  );
  const quote = await quoteRes.json() as any;
  console.log("Quote:", quote.outAmount, "MYTH raw for 0.001 SOL");
  console.log("Route:", quote.routePlan?.[0]?.swapInfo?.label);

  // Step 2: Get swap tx
  const swapRes = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: relayer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 100000,
    }),
  });
  const swapData = await swapRes.json() as any;
  if (!swapData.swapTransaction) {
    console.error("No swap tx:", swapData);
    return;
  }

  // Step 3: Deserialize and sign
  const txBuf = Buffer.from(swapData.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([relayer]);

  // Step 4: Simulate
  console.log("\nSimulating Jupiter swap tx...");
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    console.error("SIMULATION FAILED:", JSON.stringify(sim.value.err));
    const logs = sim.value.logs || [];
    logs.filter(l =>
      l.includes("pAMMBay") ||
      l.includes("Error") ||
      l.includes("Instruction:") ||
      l.includes("success") ||
      l.includes("Transfer") ||
      l.includes("BuyExact")
    ).forEach(l => console.log("  ", l));
  } else {
    console.log("SIMULATION SUCCESS!");
    const logs = sim.value.logs || [];
    logs.filter(l =>
      l.includes("pAMMBay") ||
      l.includes("Transfer") ||
      l.includes("BuyExact") ||
      l.includes("success")
    ).forEach(l => console.log("  ", l));
  }

  // Step 5: Decode the inner instruction to PumpSwap
  console.log("\n=== Analyzing Jupiter's TX structure ===");
  const msg = tx.message;
  // Get all account keys
  const staticKeys = msg.staticAccountKeys;
  console.log("Static account keys:", staticKeys.length);

  // Find PumpSwap program
  for (let i = 0; i < staticKeys.length; i++) {
    const k = staticKeys[i].toBase58();
    if (k === "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA") {
      console.log("PumpSwap at static key index:", i);
    }
  }

  // Check compiled instructions
  const ixs = msg.compiledInstructions;
  console.log("Compiled instructions:", ixs.length);
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const pid = staticKeys[ix.programIdIndex]?.toBase58() || "lookup";
    console.log(`  IX[${i}]: program=${pid.substring(0,20)}... accounts=${ix.accountKeyIndexes.length} data=${Buffer.from(ix.data).toString("hex").substring(0, 40)}...`);
  }

  // Check if there are address lookup tables
  const alt = msg.addressTableLookups;
  console.log("\nAddress lookup tables:", alt.length);
  for (const t of alt) {
    console.log(`  Table: ${t.accountKey.toBase58()}`);
    console.log(`    Writable indices: ${t.writableIndexes}`);
    console.log(`    Readonly indices: ${t.readonlyIndexes}`);
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
