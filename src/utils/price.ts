import { logger } from "./logger.js";

const MYTH_MINT = "5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_URL = `https://api.jup.ag/price/v2?ids=${MYTH_MINT},${SOL_MINT}`;
const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${MYTH_MINT}`;

let cachedRate: { solToMyth: number; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function fetchSolToMythRate(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.ts < CACHE_TTL_MS) {
    return cachedRate.solToMyth;
  }

  // Try Jupiter first
  try {
    const res = await fetch(JUPITER_URL);
    if (res.ok) {
      const data: any = await res.json();
      const mythPriceUsd = parseFloat(data?.data?.[MYTH_MINT]?.price || "0");
      const solPriceUsd = parseFloat(data?.data?.[SOL_MINT]?.price || "0");

      if (mythPriceUsd > 0 && solPriceUsd > 0) {
        const rate = solPriceUsd / mythPriceUsd;
        cachedRate = { solToMyth: rate, ts: Date.now() };
        logger.info(
          { rate: rate.toFixed(2), mythPriceUsd, solPriceUsd, source: "jupiter" },
          "Price: fetched SOL/MYTH rate"
        );
        return rate;
      }
    }
  } catch (err) {
    logger.warn({ err }, "Price: Jupiter fetch failed, trying DexScreener");
  }

  // Fallback: DexScreener
  try {
    const res = await fetch(DEXSCREENER_URL);
    if (res.ok) {
      const data: any = await res.json();
      const pairs = (data.pairs as any[]) || [];
      const solPair = pairs.find(
        (p: any) =>
          p.quoteToken?.symbol === "SOL" || p.quoteToken?.symbol === "WSOL"
      );
      const pair = solPair || pairs[0];
      if (pair) {
        const priceNative = parseFloat(pair.priceNative || "0");
        if (priceNative > 0) {
          const rate = 1 / priceNative;
          cachedRate = { solToMyth: rate, ts: Date.now() };
          logger.info(
            { rate: rate.toFixed(2), priceNative, source: "dexscreener" },
            "Price: fetched SOL/MYTH rate"
          );
          return rate;
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Price: DexScreener fetch failed");
  }

  if (cachedRate) {
    logger.warn(
      { staleSec: Math.round((Date.now() - cachedRate.ts) / 1000) },
      "Price: using stale cached rate"
    );
    return cachedRate.solToMyth;
  }

  throw new Error("Failed to fetch SOL/MYTH price from all sources");
}
