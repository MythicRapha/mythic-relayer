#!/usr/bin/env npx tsx
// Test: Match Jupiter's exact BuyExactQuoteIn format (24 bytes, NO track_volume)

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

const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMPFEE = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const ATA_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const MYTH_POOL = new PublicKey("Hg6fPz8zPQtrV7McXh7SxQndmd6zh4v8HSvQ6yYg3uuB");
const MYTH_MINT = new PublicKey("5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump");
const POOL_BASE = new PublicKey("iB28uxnFM6dA2fixVpX9KEthsRWeS2FWwmTXVxqnVyk");
const POOL_QUOTE = new PublicKey("3dgiBGb3qgsJb3GrkN1ikQTLtZS67dUEmSN1fCE63DAe");

const BUY_EXACT_QUOTE_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=60aa17ec-d160-4cd9-8a51-e74f693bc403";
const SOL_AMOUNT = BigInt(1_000_000); // 0.001 SOL

function writeBigUInt64LE(buf: Buffer, value: bigint, offset: number) {
  const lo = Number(value & BigInt(0xFFFFFFFF));
  const hi = Number((value >> BigInt(32)) & BigInt(0xFFFFFFFF));
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

async function main() {
  const key = JSON.parse(fs.readFileSync("/mnt/data/mythic-l2/keys/sequencer-identity.json", "utf8"));
  const relayer = Keypair.fromSecretKey(Uint8Array.from(key));
  const user = relayer.publicKey;
  console.log("Relayer:", user.toBase58());

  const connection = new Connection(HELIUS_RPC, "confirmed");

  // Derive PDAs
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP);
  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMPSWAP);
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), user.toBytes()], PUMPSWAP);
  const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), PUMPSWAP.toBytes()], PUMPFEE);

  // Print our derived PDAs vs Jupiter's
  console.log("\n=== PDA COMPARISON ===");
  console.log("Our globalConfig:            ", globalConfig.toBase58());
  console.log("Jupiter's globalConfig:       ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
  console.log("Match:", globalConfig.toBase58() === "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");

  console.log("Our eventAuthority:          ", eventAuthority.toBase58());
  console.log("Jupiter's eventAuthority:     GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
  console.log("Match:", eventAuthority.toBase58() === "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");

  console.log("Our globalVolumeAccumulator: ", globalVolumeAccumulator.toBase58());
  console.log("Jupiter's:                    C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw");
  console.log("Match:", globalVolumeAccumulator.toBase58() === "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw");

  console.log("Our userVolumeAccumulator:   ", userVolumeAccumulator.toBase58());
  console.log("Jupiter's:                    2AyPBC7ZCnbHiQFvz2miGwm8BJPvmnGwDSkiEyAo5RPg");
  console.log("Match:", userVolumeAccumulator.toBase58() === "2AyPBC7ZCnbHiQFvz2miGwm8BJPvmnGwDSkiEyAo5RPg");

  console.log("Our feeConfig:               ", feeConfig.toBase58());
  console.log("Jupiter's:                    5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
  console.log("Match:", feeConfig.toBase58() === "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");

  // Fetch pool data
  const poolInfo = await connection.getAccountInfo(MYTH_POOL);
  if (!poolInfo?.data) throw new Error("Failed to fetch pool");
  const coinCreator = new PublicKey(poolInfo.data.subarray(211, 243));
  console.log("\nPool coin_creator:", coinCreator.toBase58());

  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), coinCreator.toBytes()], PUMPSWAP,
  );
  const coinCreatorVaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, coinCreatorVaultAuthority, true, TOKEN_PROGRAM_ID);
  console.log("Our coinCreatorVaultAta:     ", coinCreatorVaultAta.toBase58());
  console.log("Jupiter's:                    7znmpogZJo5hjZHTXeLxnYAKT4zyt5LY9WzihCoXZCKS");
  console.log("Match:", coinCreatorVaultAta.toBase58() === "7znmpogZJo5hjZHTXeLxnYAKT4zyt5LY9WzihCoXZCKS");
  console.log("Our coinCreatorVaultAuth:    ", coinCreatorVaultAuthority.toBase58());
  console.log("Jupiter's:                    8JnoUKU8KDdxLXbvU5UL5KvgNFEr7vV4ZPQeEBFrY9Kz");
  console.log("Match:", coinCreatorVaultAuthority.toBase58() === "8JnoUKU8KDdxLXbvU5UL5KvgNFEr7vV4ZPQeEBFrY9Kz");

  // Protocol fee recipient
  const gcInfo = await connection.getAccountInfo(globalConfig);
  if (!gcInfo?.data) throw new Error("Failed to fetch global config");
  const protocolFeeRecipient = new PublicKey(gcInfo.data.subarray(57, 89));
  console.log("\nOur protocolFeeRecipient:    ", protocolFeeRecipient.toBase58());
  console.log("Jupiter's:                    JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU");
  console.log("Match:", protocolFeeRecipient.toBase58() === "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU");

  // If protocolFeeRecipient doesn't match, print all 8 from globalConfig
  if (protocolFeeRecipient.toBase58() !== "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU") {
    console.log("\n=== ALL 8 PROTOCOL FEE RECIPIENTS (from globalConfig) ===");
    for (let i = 0; i < 8; i++) {
      const off = 57 + i * 32;
      const pk = new PublicKey(gcInfo.data.subarray(off, off + 32));
      console.log(`  [${i}] offset ${off}: ${pk.toBase58()}`);
    }
  }

  const protocolFeeAta = getAssociatedTokenAddressSync(NATIVE_MINT, protocolFeeRecipient, true, TOKEN_PROGRAM_ID);
  const userMythAta = getAssociatedTokenAddressSync(MYTH_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);

  // ============================================================
  // TEST 1: Jupiter's exact format — 24 bytes, NO track_volume
  // ============================================================
  console.log("\n=== TEST 1: 24-byte format (NO track_volume, like Jupiter) ===");
  const data24 = Buffer.alloc(24); // disc(8) + spendable_quote_in(8) + min_base_out(8)
  BUY_EXACT_QUOTE_DISC.copy(data24, 0);
  writeBigUInt64LE(data24, SOL_AMOUNT, 8);
  writeBigUInt64LE(data24, BigInt(1), 16);  // min_base = 1 (like Jupiter)
  console.log("Data hex:", data24.toString("hex"));

  await testBuyExactQuoteIn(connection, relayer, data24, user, globalConfig, eventAuthority,
    globalVolumeAccumulator, userVolumeAccumulator, feeConfig, coinCreatorVaultAta,
    coinCreatorVaultAuthority, protocolFeeRecipient, protocolFeeAta, userMythAta, userWsolAta,
    "24-byte (no track_volume)");

  // ============================================================
  // TEST 2: 26-byte format — OptionBool::Some(false) = [0x01, 0x00]
  // ============================================================
  console.log("\n=== TEST 2: 26-byte format (track_volume = Some(false)) ===");
  const data26 = Buffer.alloc(26);
  BUY_EXACT_QUOTE_DISC.copy(data26, 0);
  writeBigUInt64LE(data26, SOL_AMOUNT, 8);
  writeBigUInt64LE(data26, BigInt(1), 16);
  data26[24] = 0x01; // variant = Some
  data26[25] = 0x00; // value = false
  console.log("Data hex:", data26.toString("hex"));

  await testBuyExactQuoteIn(connection, relayer, data26, user, globalConfig, eventAuthority,
    globalVolumeAccumulator, userVolumeAccumulator, feeConfig, coinCreatorVaultAta,
    coinCreatorVaultAuthority, protocolFeeRecipient, protocolFeeAta, userMythAta, userWsolAta,
    "26-byte (track_volume=Some(false))");

  // ============================================================
  // TEST 3: Use Jupiter's exact protocolFeeRecipient if ours differs
  // ============================================================
  const jupProtocolFeeRecipient = new PublicKey("JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU");
  if (protocolFeeRecipient.toBase58() !== jupProtocolFeeRecipient.toBase58()) {
    console.log("\n=== TEST 3: Using Jupiter's protocolFeeRecipient ===");
    const jupProtocolFeeAta = getAssociatedTokenAddressSync(NATIVE_MINT, jupProtocolFeeRecipient, true, TOKEN_PROGRAM_ID);
    console.log("Jupiter protocolFeeRecipient:", jupProtocolFeeRecipient.toBase58());
    console.log("Jupiter protocolFeeAta:", jupProtocolFeeAta.toBase58());
    console.log("Our protocolFeeAta:", protocolFeeAta.toBase58());
    console.log("Jupiter's protocolFeeAta:     DWpvfqzGWuVy9jVSKSShdM2733nrEsnnhsUStYbkj6Nn");

    await testBuyExactQuoteIn(connection, relayer, data24, user, globalConfig, eventAuthority,
      globalVolumeAccumulator, userVolumeAccumulator, feeConfig, coinCreatorVaultAta,
      coinCreatorVaultAuthority, jupProtocolFeeRecipient, jupProtocolFeeAta, userMythAta, userWsolAta,
      "24-byte + Jupiter's protocolFeeRecipient");
  }
}

async function testBuyExactQuoteIn(
  connection: Connection,
  relayer: Keypair,
  data: Buffer,
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
  label: string,
) {
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
      { pubkey: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"), isSigner: false, isWritable: false },
    ],
    data,
  });

  const wrapAmount = BigInt(1_100_000); // slightly more than 0.001 SOL
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userMythAta, user, MYTH_MINT, TOKEN_2022_PROGRAM_ID));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, NATIVE_MINT, TOKEN_PROGRAM_ID));
  tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsolAta, lamports: Number(wrapAmount) }));
  tx.add(createSyncNativeInstruction(userWsolAta, TOKEN_PROGRAM_ID));
  tx.add(buyIx);
  tx.add(createCloseAccountInstruction(userWsolAta, user, user, [], TOKEN_PROGRAM_ID));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  tx.sign(relayer);

  console.log(`Simulating ${label}...`);
  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.error(`  FAILED: ${JSON.stringify(sim.value.err)}`);
      // Print last few relevant logs
      const logs = sim.value.logs || [];
      const pumpLogs = logs.filter(l => l.includes("pAMMBay") || l.includes("Error") || l.includes("Instruction:") || l.includes("success"));
      pumpLogs.slice(-8).forEach(l => console.log("    ", l));
    } else {
      console.log("  SUCCESS!");
      const logs = sim.value.logs || [];
      logs.filter(l => l.includes("pAMMBay") || l.includes("Transfer")).forEach(l => console.log("    ", l));
    }
  } catch (e: any) {
    console.error(`  Exception: ${e.message}`);
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
