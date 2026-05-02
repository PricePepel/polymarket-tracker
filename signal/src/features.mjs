// Per-market features computed from a slice of trades that occurred at or
// before a decision time. All features must be leakage-free: they look at
// trades up to T_dec only.
//
// Conventions:
//   - "YES" = market resolves "Up"
//   - "NO"  = market resolves "Down"
//   - bullish-up trade: BUY Up or SELL Down

import { isBullishUp } from "./parse.mjs";

// Last observed taker price for each outcome side, before decision time.
// Returns { yesPrice, noPrice } where each is null if unseen.
export function lastSidePrices(trades) {
  let yesPrice = null;
  let noPrice = null;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (yesPrice == null && t.outcome === "Up") yesPrice = t.price;
    if (noPrice == null && t.outcome === "Down") noPrice = t.price;
    if (yesPrice != null && noPrice != null) break;
  }
  return { yesPrice, noPrice };
}

// HHI of trader contributions (by absolute USD), 0 = perfectly diffuse,
// 1 = single-trader dominated.
export function concentrationHHI(trades) {
  const byWallet = new Map();
  let total = 0;
  for (const t of trades) {
    byWallet.set(t.wallet, (byWallet.get(t.wallet) || 0) + t.usd);
    total += t.usd;
  }
  if (total <= 0) return 0;
  let hhi = 0;
  for (const v of byWallet.values()) {
    const s = v / total;
    hhi += s * s;
  }
  return hhi;
}

// Net YES USD flow for trades inside [t0, t1].
export function netYesUsdInRange(trades, t0, t1) {
  let net = 0;
  for (const t of trades) {
    if (t.tradeTs < t0 || t.tradeTs > t1) continue;
    net += isBullishUp(t) ? t.usd : -t.usd;
  }
  return net;
}

// Build the full feature vector for a market at a given decision time.
//   marketStartTs, marketEndTs — bounds of the market
//   decisionTs — typically marketEndTs - 60_000 (1 min before close)
//   trades — array of canonical trades for this market (any time)
//
// The function only looks at trades with tradeTs <= decisionTs.
export function featuresAtDecision({ trades, marketStartTs, marketEndTs, decisionTs }) {
  const before = trades.filter((t) => t.tradeTs <= decisionTs);
  const lateWindow = Math.max(marketStartTs, decisionTs - 90_000); // last 90s

  const { yesPrice, noPrice } = lastSidePrices(before);

  return {
    nTradesBefore: before.length,
    nTradesLate: before.filter((t) => t.tradeTs >= lateWindow).length,
    netYesUsdAll: netYesUsdInRange(before, marketStartTs, decisionTs),
    netYesUsdLate: netYesUsdInRange(before, lateWindow, decisionTs),
    grossUsdAll: before.reduce((s, t) => s + t.usd, 0),
    grossUsdLate: before
      .filter((t) => t.tradeTs >= lateWindow)
      .reduce((s, t) => s + t.usd, 0),
    hhiAll: concentrationHHI(before),
    yesPrice,
    noPrice,
  };
}
