// Jupiter-routed SOL → MYTH swap for the bridge relayer
// Uses Jupiter Lite API to build and execute swaps, which handles PumpSwap overflow issues

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
} from "@solana/spl-token";
import { logger } from "../utils/logger.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const MYTH_MINT = new PublicKey("5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MYTH_MINT_STR = "5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump";

// Pool token accounts (for rate calculation fallback)
const POOL_BASE_TOKEN_ACCOUNT = new PublicKey("iB28uxnFM6dA2fixVpX9KEthsRWeS2FWwmTXVxqnVyk");   // MYTH
const POOL_QUOTE_TOKEN_ACCOUNT = new PublicKey("3dgiBGb3qgsJb3GrkN1ikQTLtZS67dUEmSN1fCE63DAe"); // wSOL

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

const HELIUS_SEND_RPC = "https://mainnet.helius-rpc.com/?api-key=60aa17ec-d160-4cd9-8a51-e74f693bc403";

// ── AMM Math (constant product — for rate calculation only) ─────────────

function calculateBuyOutput(
  solAmountLamports: bigint,
  solReserve: bigint,
  mythReserve: bigint,
): bigint {
  const k = solReserve * mythReserve;
  const newSolReserve = solReserve + solAmountLamports;
  const newMythReserve = k / newSolReserve + BigInt(1);
  const mythOut = mythReserve - newMythReserve;
  return mythOut > BigInt(0) ? mythOut : BigInt(0);
}

// ── Jupiter Swap ────────────────────────────────────────────────────────

export interface SwapResult {
  txSignature: string;
  mythReceived: bigint;
  solSpent: bigint;
}

export async function swapSolForMyth(
  connection: Connection,
  relayer: Keypair,
  solAmountLamports: bigint,
  slippageBps: number = 500,
): Promise<SwapResult> {
  const user = relayer.publicKey;

  // Step 1: Get Jupiter quote
  const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${MYTH_MINT_STR}&amount=${solAmountLamports.toString()}&slippageBps=${slippageBps}`;

  logger.info({ solIn: solAmountLamports.toString(), slippageBps }, "Jupiter: fetching quote");

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json() as any;

  if (!quote.outAmount || quote.outAmount === "0") {
    throw new Error("Jupiter: no route found for SOL -> MYTH");
  }

  const expectedMythOut = BigInt(quote.outAmount);
  const minMythOut = BigInt(quote.otherAmountThreshold || quote.outAmount);

  logger.info({
    solIn: solAmountLamports.toString(),
    expectedMyth: expectedMythOut.toString(),
    minMyth: minMythOut.toString(),
    route: quote.routePlan?.map((r: any) => r.swapInfo?.label).join(" -> "),
  }, "Jupiter: quote received");

  // Step 2: Get swap transaction from Jupiter
  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 100000,
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Jupiter swap tx failed: ${swapRes.status} ${await swapRes.text()}`);
  }
  const swapData = await swapRes.json() as any;

  if (!swapData.swapTransaction) {
    throw new Error("Jupiter: no swapTransaction in response");
  }

  // Step 3: Deserialize, sign, send
  const txBuf = Buffer.from(swapData.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([relayer]);

  // Pre-swap MYTH balance
  const mythAta = getAssociatedTokenAddressSync(MYTH_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  let preBalance = BigInt(0);
  try {
    const bal = await connection.getTokenAccountBalance(mythAta);
    preBalance = BigInt(bal.value.amount);
  } catch {
    // ATA doesn't exist yet
  }

  // Send via Helius
  const sendConn = new Connection(HELIUS_SEND_RPC, "confirmed");
  const rawTx = Buffer.from(tx.serialize());

  const txSignature = await sendConn.sendRawTransaction(rawTx, {
    skipPreflight: true,
    maxRetries: 5,
  });

  // Also broadcast to public RPC
  try {
    const pubConn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    await pubConn.sendRawTransaction(rawTx, { skipPreflight: true });
    logger.info("Jupiter: tx also broadcast to public RPC");
  } catch { /* ignore */ }

  logger.info({ txSignature }, "Jupiter: tx broadcast, polling for confirmation");

  // Poll for confirmation
  const TIMEOUT_MS = 90_000;
  const POLL_MS = 2_000;
  const start = Date.now();
  let confirmed = false;

  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));

    try {
      const status = await sendConn.getSignatureStatus(txSignature);
      if (status?.value) {
        if (status.value.err) {
          const errStr = JSON.stringify(status.value.err);
          logger.error({ txSignature, err: errStr }, "Jupiter: tx failed on-chain");
          throw new Error("Jupiter swap tx failed on-chain: " + errStr);
        }
        const cs = status.value.confirmationStatus;
        if (cs === "confirmed" || cs === "finalized") {
          logger.info({ txSignature, status: cs }, "Jupiter: tx confirmed");
          confirmed = true;
          break;
        }
      }
    } catch (e: any) {
      if (e.message?.startsWith("Jupiter swap tx failed")) throw e;
      logger.warn({ err: e.message }, "Jupiter: polling error, retrying");
    }

    // Re-send every 10s
    if ((Date.now() - start) % 10_000 < POLL_MS) {
      try {
        await sendConn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
      } catch { /* ignore */ }
    }
  }

  if (!confirmed) {
    throw new Error("Jupiter tx not confirmed within " + (TIMEOUT_MS / 1000) + "s -- signature: " + txSignature);
  }

  // Post-swap MYTH balance
  let mythReceived = expectedMythOut; // fallback
  try {
    const postBal = await connection.getTokenAccountBalance(mythAta);
    const postBalance = BigInt(postBal.value.amount);
    mythReceived = postBalance - preBalance;
  } catch {
    logger.warn("Jupiter: could not read post-swap balance, using expected amount");
  }

  logger.info({
    txSignature,
    mythReceived: mythReceived.toString(),
    mythReadable: (Number(mythReceived) / 1e6).toFixed(2),
    expected: expectedMythOut.toString(),
  }, "Jupiter: swap completed");

  return { txSignature, mythReceived, solSpent: solAmountLamports };
}

/**
 * Transfer MYTH from relayer ATA to bridge vault (Token-2022).
 */
export async function transferMythToVault(
  connection: Connection,
  relayer: Keypair,
  bridgeVault: PublicKey,
  amount: bigint,
): Promise<string> {
  const user = relayer.publicKey;
  const userMythAta = getAssociatedTokenAddressSync(
    MYTH_MINT, user, false, TOKEN_2022_PROGRAM_ID,
  );

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  tx.add(createTransferInstruction(
    userMythAta, bridgeVault, user, amount, [], TOKEN_2022_PROGRAM_ID,
  ));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  tx.sign(relayer);

  const sendConn = new Connection(HELIUS_SEND_RPC, "confirmed");
  const sig = await sendConn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });

  // Wait for confirmation
  const TIMEOUT_MS = 60_000;
  const POLL_MS = 2_000;
  const pollStart = Date.now();
  while (Date.now() - pollStart < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const status = await sendConn.getSignatureStatus(sig);
    if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
      break;
    }
    if (status?.value?.err) {
      throw new Error("Transfer failed: " + JSON.stringify(status.value.err));
    }
  }

  logger.info({ sig, amount: amount.toString(), vault: bridgeVault.toBase58() }, "Transferred MYTH to bridge vault");
  return sig;
}

// ── Exported helpers for rate-based credit ──────────────────────────────

export interface PoolReserves {
  solReserve: bigint;
  mythReserve: bigint;
}

export async function getPoolReserves(connection: Connection): Promise<PoolReserves> {
  const [solBal, mythBal] = await Promise.all([
    connection.getTokenAccountBalance(POOL_QUOTE_TOKEN_ACCOUNT),
    connection.getTokenAccountBalance(POOL_BASE_TOKEN_ACCOUNT),
  ]);
  return {
    solReserve: BigInt(solBal.value.amount),
    mythReserve: BigInt(mythBal.value.amount),
  };
}

export function calculateBuyOutputExported(
  solAmountLamports: bigint,
  solReserve: bigint,
  mythReserve: bigint,
): bigint {
  return calculateBuyOutput(solAmountLamports, solReserve, mythReserve);
}
