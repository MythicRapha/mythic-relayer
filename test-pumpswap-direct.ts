#!/usr/bin/env npx tsx
// Quick test: direct PumpSwap buy_exact_quote_in with 0.001 SOL
// Tests whether the on-chain overflow (6023) has been fixed

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";

// ── Constants ───────────────────────────────────────────────────────────
const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMPFEE = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const ATA_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const MYTH_POOL = new PublicKey("Hg6fPz8zPQtrV7McXh7SxQndmd6zh4v8HSvQ6yYg3uuB");
const MYTH_MINT = new PublicKey("5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump");
const POOL_BASE = new PublicKey("iB28uxnFM6dA2fixVpX9KEthsRWeS2FWwmTXVxqnVyk");   // MYTH
const POOL_QUOTE = new PublicKey("3dgiBGb3qgsJb3GrkN1ikQTLtZS67dUEmSN1fCE63DAe"); // wSOL

// buy_exact_quote_in discriminator: sha256("global:buy_exact_quote_in")[0..8]
const BUY_EXACT_QUOTE_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
// buy discriminator
const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=60aa17ec-d160-4cd9-8a51-e74f693bc403";

const SOL_AMOUNT = BigInt(1_000_000); // 0.001 SOL

// ── Helpers ─────────────────────────────────────────────────────────────
function writeBigUInt64LE(buf: Buffer, value: bigint, offset: number) {
  const lo = Number(value & BigInt(0xFFFFFFFF));
  const hi = Number((value >> BigInt(32)) & BigInt(0xFFFFFFFF));
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

async function main() {
  const keyPath = "/mnt/data/mythic-l2/keys/sequencer-identity.json";
  const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const relayer = Keypair.fromSecretKey(Uint8Array.from(key));
  const user = relayer.publicKey;
  console.log("Relayer:", user.toBase58());

  const connection = new Connection(HELIUS_RPC, "confirmed");

  // Check balance
  const balance = await connection.getBalance(user);
  console.log("SOL balance:", balance / 1e9);

  // Derive PDAs
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")], PUMPSWAP,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], PUMPSWAP,
  );
  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_volume_accumulator")], PUMPSWAP,
  );
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBytes()], PUMPSWAP,
  );
  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), PUMPSWAP.toBytes()], PUMPFEE,
  );

  // Fetch pool data
  const poolInfo = await connection.getAccountInfo(MYTH_POOL);
  if (!poolInfo?.data) throw new Error("Failed to fetch pool");

  // coin_creator at offset 211
  const coinCreator = new PublicKey(poolInfo.data.subarray(211, 243));
  console.log("Pool coin_creator:", coinCreator.toBase58());

  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), coinCreator.toBytes()], PUMPSWAP,
  );
  const coinCreatorVaultAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, coinCreatorVaultAuthority, true, TOKEN_PROGRAM_ID,
  );

  // Fetch global config for protocol fee recipient
  const gcInfo = await connection.getAccountInfo(globalConfig);
  if (!gcInfo?.data) throw new Error("Failed to fetch global config");
  const protocolFeeRecipient = new PublicKey(gcInfo.data.subarray(57, 89));
  console.log("Protocol fee recipient:", protocolFeeRecipient.toBase58());

  const protocolFeeAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, protocolFeeRecipient, true, TOKEN_PROGRAM_ID,
  );

  // User ATAs
  const userMythAta = getAssociatedTokenAddressSync(MYTH_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);

  // Pre-swap MYTH balance
  let preBalance = BigInt(0);
  try {
    const bal = await connection.getTokenAccountBalance(userMythAta);
    preBalance = BigInt(bal.value.amount);
    console.log("Pre-swap MYTH:", Number(preBalance) / 1e6);
  } catch {
    console.log("No MYTH ATA yet");
  }

  // Pool reserves
  const [solBal, mythBal] = await Promise.all([
    connection.getTokenAccountBalance(POOL_QUOTE),
    connection.getTokenAccountBalance(POOL_BASE),
  ]);
  console.log("Pool SOL:", Number(solBal.value.amount) / 1e9);
  console.log("Pool MYTH:", Number(mythBal.value.amount) / 1e6);

  // ── Test buy_exact_quote_in ───────────────────────────────────────────
  console.log("\n=== Testing buy_exact_quote_in with 0.001 SOL ===");

  // Data: disc(8) + spendable_quote_in(u64) + min_base_amount_out(u64) + track_volume(OptionBool::None = 0x00)
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  BUY_EXACT_QUOTE_DISC.copy(data, 0);
  writeBigUInt64LE(data, SOL_AMOUNT, 8);     // 0.001 SOL
  writeBigUInt64LE(data, BigInt(0), 16);      // min output = 0 (no slippage for test)
  data[24] = 0x00;                            // OptionBool::None

  const buyIx = new TransactionInstruction({
    programId: PUMPSWAP,
    keys: [
      { pubkey: MYTH_POOL, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: MYTH_MINT, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: userMythAta, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: POOL_BASE, isSigner: false, isWritable: true },
      { pubkey: POOL_QUOTE, isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
      { pubkey: protocolFeeAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ATA_PROG, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: PUMPFEE, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userMythAta, user, MYTH_MINT, TOKEN_2022_PROGRAM_ID));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, NATIVE_MINT, TOKEN_PROGRAM_ID));

  // Wrap SOL - use exact amount for buy_exact_quote_in + some extra for fees
  const wrapAmount = SOL_AMOUNT + BigInt(10_000); // tiny extra for rounding
  tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsolAta, lamports: Number(wrapAmount) }));
  tx.add(createSyncNativeInstruction(userWsolAta, TOKEN_PROGRAM_ID));
  tx.add(buyIx);
  tx.add(createCloseAccountInstruction(userWsolAta, user, user, [], TOKEN_PROGRAM_ID));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  tx.sign(relayer);

  // First simulate
  console.log("Simulating...");
  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.error("SIMULATION FAILED:", JSON.stringify(sim.value.err));
      console.log("Logs:");
      sim.value.logs?.forEach(l => console.log("  ", l));

      // If buy_exact_quote_in fails, also try regular buy with very small amount
      console.log("\n=== Trying regular buy with small amount ===");
      await testRegularBuy(connection, relayer, user, globalConfig, eventAuthority,
        globalVolumeAccumulator, userVolumeAccumulator, feeConfig,
        coinCreatorVaultAta, coinCreatorVaultAuthority, protocolFeeRecipient, protocolFeeAta,
        userMythAta, userWsolAta);
      return;
    }
    console.log("SIMULATION SUCCESS!");
    sim.value.logs?.forEach(l => console.log("  ", l));
  } catch (e: any) {
    console.error("Sim error:", e.message);
    return;
  }

  // If simulation passed, send for real
  console.log("\nSending transaction...");
  const rawTx = tx.serialize();
  const sig = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });
  console.log("TX:", sig);

  // Wait for confirmation
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await connection.getSignatureStatus(sig);
    if (status?.value?.err) {
      console.error("TX FAILED:", JSON.stringify(status.value.err));
      return;
    }
    if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
      console.log("TX CONFIRMED!");
      break;
    }
  }

  // Post balance
  try {
    const postBal = await connection.getTokenAccountBalance(userMythAta);
    const postBalance = BigInt(postBal.value.amount);
    const mythReceived = postBalance - preBalance;
    console.log("MYTH received:", Number(mythReceived) / 1e6);
  } catch (e: any) {
    console.log("Could not read post balance:", e.message);
  }
}

async function testRegularBuy(
  connection: Connection,
  relayer: Keypair,
  user: PublicKey,
  globalConfig: PublicKey,
  eventAuthority: PublicKey,
  globalVolumeAccumulator: PublicKey,
  userVolumeAccumulator: PublicKey,
  feeConfig: PublicKey,
  coinCreatorVaultAta: PublicKey,
  coinCreatorVaultAuthority: PublicKey,
  protocolFeeRecipient: PublicKey,
  protocolFeeAta: PublicKey,
  userMythAta: PublicKey,
  userWsolAta: PublicKey,
) {
  // Try regular buy with a VERY small base_amount_out to avoid overflow in numerator
  // base_amount_out * quote_reserves < u64::MAX
  // quote_reserves ≈ 94.6 SOL = 94_600_000_000 lamports
  // u64::MAX / 94_600_000_000 ≈ 194_944_897 — so base_amount_out must be < ~194M (raw units)
  // That's 194 MYTH (at 6 decimals). Let's try 100 MYTH = 100_000_000 raw
  const baseAmountOut = BigInt(100_000_000); // 100 MYTH
  const maxQuoteIn = BigInt(2_000_000);      // 0.002 SOL max

  const data = Buffer.alloc(8 + 8 + 8 + 1);
  BUY_DISC.copy(data, 0);
  writeBigUInt64LE(data, baseAmountOut, 8);
  writeBigUInt64LE(data, maxQuoteIn, 16);
  data[24] = 0x00; // OptionBool::None

  const buyIx = new TransactionInstruction({
    programId: PUMPSWAP,
    keys: [
      { pubkey: MYTH_POOL, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: MYTH_MINT, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: userMythAta, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: POOL_BASE, isSigner: false, isWritable: true },
      { pubkey: POOL_QUOTE, isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
      { pubkey: protocolFeeAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ATA_PROG, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: PUMPFEE, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userMythAta, user, MYTH_MINT, TOKEN_2022_PROGRAM_ID));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, NATIVE_MINT, TOKEN_PROGRAM_ID));
  tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsolAta, lamports: Number(maxQuoteIn) }));
  tx.add(createSyncNativeInstruction(userWsolAta, TOKEN_PROGRAM_ID));
  tx.add(buyIx);
  tx.add(createCloseAccountInstruction(userWsolAta, user, user, [], TOKEN_PROGRAM_ID));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  tx.sign(relayer);

  console.log("Simulating regular buy (100 MYTH)...");
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("REGULAR BUY SIMULATION ALSO FAILED:", JSON.stringify(sim.value.err));
    sim.value.logs?.forEach(l => console.log("  ", l));
  } else {
    console.log("REGULAR BUY SIMULATION SUCCESS!");
    sim.value.logs?.forEach(l => console.log("  ", l));
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
