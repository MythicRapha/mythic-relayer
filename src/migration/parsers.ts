// Event parsers for PumpSwap, Raydium, and Meteora pool creation events

import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type { PoolCreationEvent, DexSource } from "./types.js";
import { logger } from "../utils/logger.js";

// Program IDs for L1 DEXes
export const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const RAYDIUM_CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const METEORA_DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const METEORA_AMM_PROGRAM = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

// SOL and known quote mints
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const KNOWN_QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/**
 * Parse a PumpSwap create_pool event from transaction logs and accounts.
 *
 * PumpSwap create_pool instruction layout:
 *   Accounts:
 *     0: pool (writable)
 *     1: creator (signer)
 *     2: baseMint
 *     3: quoteMint
 *     4: lpMint (writable)
 *     5: userBaseTokenAccount (writable)
 *     6: userQuoteTokenAccount (writable)
 *     7: poolBaseTokenAccount (writable)
 *     8: poolQuoteTokenAccount (writable)
 *     9: globalConfig
 *     ...system accounts
 *
 *   Logs contain: "Program log: Instruction: CreatePool" or similar
 */
export function parsePumpSwapPoolCreation(
  tx: ParsedTransactionWithMeta,
  signature: string,
): PoolCreationEvent | null {
  const logs = tx.meta?.logMessages ?? [];

  // Look for PumpSwap program invocation with pool creation
  let isPumpSwapCreate = false;
  for (const log of logs) {
    if (
      log.includes(PUMPSWAP_PROGRAM.toBase58()) &&
      (log.includes("CreatePool") || log.includes("create_pool"))
    ) {
      isPumpSwapCreate = true;
      break;
    }
  }

  // Also check if PumpSwap program is in the instruction list
  if (!isPumpSwapCreate) {
    const instructions = tx.transaction?.message?.instructions ?? [];
    for (const ix of instructions) {
      if ("programId" in ix && ix.programId.toBase58() === PUMPSWAP_PROGRAM.toBase58()) {
        // Check logs for pool creation indicator
        for (const log of logs) {
          if (log.includes("CreatePool") || log.includes("create_pool") || log.includes("Pool created")) {
            isPumpSwapCreate = true;
            break;
          }
        }
      }
    }
  }

  if (!isPumpSwapCreate) return null;

  // Extract account keys from the transaction
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  if (accountKeys.length < 9) return null;

  // Find PumpSwap program instruction accounts
  const instructions = tx.transaction?.message?.instructions ?? [];
  for (const ix of instructions) {
    const programId = "programId" in ix ? ix.programId.toBase58() : "";
    if (programId !== PUMPSWAP_PROGRAM.toBase58()) continue;

    // For parsed instructions, accounts might be in different format
    if ("accounts" in ix && Array.isArray(ix.accounts)) {
      const accts = ix.accounts as PublicKey[];
      if (accts.length >= 9) {
        const poolAddress = accts[0].toBase58();
        const creator = accts[1].toBase58();
        const baseMint = accts[2].toBase58();
        const quoteMint = accts[3].toBase58();

        // Get pre/post token balances to determine initial liquidity
        const { baseAmount, quoteAmount } = extractTokenChanges(tx, baseMint, quoteMint);

        return {
          poolAddress,
          baseMint,
          quoteMint,
          baseAmount,
          quoteAmount,
          creator,
          txSignature: signature,
          dexSource: "pumpswap",
        };
      }
    }
  }

  // Fallback: try to parse from inner instructions / account list
  // PumpSwap create_pool is often called via CPI from PumpFun graduation
  const innerInstructions = tx.meta?.innerInstructions ?? [];
  for (const inner of innerInstructions) {
    for (const innerIx of inner.instructions) {
      const programId = "programId" in innerIx ? innerIx.programId.toBase58() : "";
      if (programId !== PUMPSWAP_PROGRAM.toBase58()) continue;
      if (!("accounts" in innerIx) || !Array.isArray(innerIx.accounts)) continue;

      const accts = innerIx.accounts as PublicKey[];
      if (accts.length >= 9) {
        const poolAddress = accts[0].toBase58();
        const creator = accts[1].toBase58();
        const baseMint = accts[2].toBase58();
        const quoteMint = accts[3].toBase58();

        const { baseAmount, quoteAmount } = extractTokenChanges(tx, baseMint, quoteMint);

        return {
          poolAddress,
          baseMint,
          quoteMint,
          baseAmount,
          quoteAmount,
          creator,
          txSignature: signature,
          dexSource: "pumpswap",
        };
      }
    }
  }

  return null;
}

/**
 * Parse a Raydium CPMM pool initialization from transaction logs.
 *
 * Raydium CPMM initialize instruction accounts:
 *   0: creator (signer)
 *   1: ammConfig
 *   2: authority (PDA)
 *   3: poolState (writable)
 *   4: token0Mint
 *   5: token1Mint
 *   6: lpMint (writable)
 *   7: creatorToken0 (writable)
 *   8: creatorToken1 (writable)
 *   9: creatorLpToken (writable)
 *   10: token0Vault (writable)
 *   11: token1Vault (writable)
 *   ...system accounts
 */
export function parseRaydiumPoolCreation(
  tx: ParsedTransactionWithMeta,
  signature: string,
): PoolCreationEvent | null {
  const logs = tx.meta?.logMessages ?? [];

  let isRaydiumCreate = false;
  for (const log of logs) {
    if (
      log.includes(RAYDIUM_CPMM_PROGRAM.toBase58()) &&
      (log.includes("Initialize") || log.includes("initialize"))
    ) {
      isRaydiumCreate = true;
      break;
    }
  }

  if (!isRaydiumCreate) return null;

  const instructions = tx.transaction?.message?.instructions ?? [];
  for (const ix of instructions) {
    const programId = "programId" in ix ? ix.programId.toBase58() : "";
    if (programId !== RAYDIUM_CPMM_PROGRAM.toBase58()) continue;

    if ("accounts" in ix && Array.isArray(ix.accounts)) {
      const accts = ix.accounts as PublicKey[];
      if (accts.length >= 12) {
        const creator = accts[0].toBase58();
        const poolAddress = accts[3].toBase58();
        const token0Mint = accts[4].toBase58();
        const token1Mint = accts[5].toBase58();

        // Determine which is base and which is quote
        const { baseMint, quoteMint } = identifyBaseQuote(token0Mint, token1Mint);
        const { baseAmount, quoteAmount } = extractTokenChanges(tx, baseMint, quoteMint);

        return {
          poolAddress,
          baseMint,
          quoteMint,
          baseAmount,
          quoteAmount,
          creator,
          txSignature: signature,
          dexSource: "raydium",
        };
      }
    }
  }

  return null;
}

/**
 * Parse a Meteora DLMM or Dynamic AMM pool creation.
 */
export function parseMeteoraPoolCreation(
  tx: ParsedTransactionWithMeta,
  signature: string,
): PoolCreationEvent | null {
  const logs = tx.meta?.logMessages ?? [];

  let isMeteoraCreate = false;
  let isDlmm = false;
  for (const log of logs) {
    if (log.includes(METEORA_DLMM_PROGRAM.toBase58()) && log.includes("InitializeLbPair")) {
      isMeteoraCreate = true;
      isDlmm = true;
      break;
    }
    if (log.includes(METEORA_AMM_PROGRAM.toBase58()) && log.includes("Initialize")) {
      isMeteoraCreate = true;
      break;
    }
  }

  if (!isMeteoraCreate) return null;

  const programId = isDlmm ? METEORA_DLMM_PROGRAM : METEORA_AMM_PROGRAM;
  const instructions = tx.transaction?.message?.instructions ?? [];

  for (const ix of instructions) {
    const ixProgramId = "programId" in ix ? ix.programId.toBase58() : "";
    if (ixProgramId !== programId.toBase58()) continue;

    if ("accounts" in ix && Array.isArray(ix.accounts)) {
      const accts = ix.accounts as PublicKey[];
      if (accts.length >= 6) {
        // Meteora DLMM: accounts[0] = lbPair, accounts[4] = tokenMintX, accounts[5] = tokenMintY
        // Meteora AMM: accounts[0] = pool, accounts[3] = tokenAMint, accounts[4] = tokenBMint
        const poolAddress = accts[0].toBase58();
        const mintA = isDlmm ? accts[4].toBase58() : accts[3].toBase58();
        const mintB = isDlmm ? accts[5].toBase58() : accts[4].toBase58();
        const creator = accts[isDlmm ? 1 : 1].toBase58();

        const { baseMint, quoteMint } = identifyBaseQuote(mintA, mintB);
        const { baseAmount, quoteAmount } = extractTokenChanges(tx, baseMint, quoteMint);

        return {
          poolAddress,
          baseMint,
          quoteMint,
          baseAmount,
          quoteAmount,
          creator,
          txSignature: signature,
          dexSource: "meteora",
        };
      }
    }
  }

  return null;
}

/**
 * Try all parsers on a transaction and return the first match.
 */
export function parsePoolCreation(
  tx: ParsedTransactionWithMeta,
  signature: string,
): PoolCreationEvent | null {
  return (
    parsePumpSwapPoolCreation(tx, signature) ??
    parseRaydiumPoolCreation(tx, signature) ??
    parseMeteoraPoolCreation(tx, signature)
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Identify which mint is the "base" token (the memecoin) and which is the "quote" (SOL/USDC).
 */
function identifyBaseQuote(mintA: string, mintB: string): { baseMint: string; quoteMint: string } {
  if (KNOWN_QUOTE_MINTS.has(mintA)) {
    return { baseMint: mintB, quoteMint: mintA };
  }
  if (KNOWN_QUOTE_MINTS.has(mintB)) {
    return { baseMint: mintA, quoteMint: mintB };
  }
  // Neither is a known quote mint; use mintA as base by default
  return { baseMint: mintA, quoteMint: mintB };
}

/**
 * Extract token balance changes from pre/post token balances.
 */
function extractTokenChanges(
  tx: ParsedTransactionWithMeta,
  baseMint: string,
  quoteMint: string,
): { baseAmount: bigint; quoteAmount: bigint } {
  let baseAmount = BigInt(0);
  let quoteAmount = BigInt(0);

  const postBalances = tx.meta?.postTokenBalances ?? [];

  for (const bal of postBalances) {
    const mint = bal.mint;
    const amount = BigInt(bal.uiTokenAmount?.amount ?? "0");

    if (mint === baseMint && amount > baseAmount) {
      baseAmount = amount;
    }
    if (mint === quoteMint && amount > quoteAmount) {
      quoteAmount = amount;
    }
  }

  return { baseAmount, quoteAmount };
}
