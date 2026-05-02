// Backtest harness. For each market with a known outcome, compute features at
// the decision time and simulate placing a single ticket. Report aggregate
// hit rate, expectancy, p-value, and PnL on a hypothetical bankroll.
//
// PnL math (per $1 staked at price p on the chosen side):
//   WIN  → (1 - p) / p
//   LOSS → -1
//
// Decision rule v1 (testable, simple):
//   If netYesUsdLate > +THRESH and yesPrice in [P_MIN, P_MAX] → BET YES at yesPrice
//   If netYesUsdLate < -THRESH and noPrice  in [P_MIN, P_MAX] → BET NO  at noPrice
//   else FLAT
//
// Constraints:
//   - need at least MIN_LATE_TRADES in the late window (else FLAT)

import { featuresAtDecision } from "./features.mjs";

export function decideTicket(features, params) {
  const { thresh, pMin, pMax, minLateTrades, slippageCents = 0 } = params;
  const f = features;
  if (f.nTradesLate < minLateTrades) return { side: "FLAT", reason: "few late trades" };
  const slip = slippageCents / 100;
  if (f.netYesUsdLate > thresh) {
    if (f.yesPrice == null) return { side: "FLAT", reason: "no yes price" };
    if (f.yesPrice < pMin || f.yesPrice > pMax)
      return { side: "FLAT", reason: `yes price ${f.yesPrice} out of band` };
    const entry = Math.min(0.99, f.yesPrice + slip);
    return { side: "YES", price: entry, observedPrice: f.yesPrice };
  }
  if (f.netYesUsdLate < -thresh) {
    if (f.noPrice == null) return { side: "FLAT", reason: "no no price" };
    if (f.noPrice < pMin || f.noPrice > pMax)
      return { side: "FLAT", reason: `no price ${f.noPrice} out of band` };
    const entry = Math.min(0.99, f.noPrice + slip);
    return { side: "NO", price: entry, observedPrice: f.noPrice };
  }
  return { side: "FLAT", reason: "below threshold" };
}

// PnL per $1 staked. Fee modeled as a flat fraction of stake deducted from
// every ticket regardless of outcome (covers Polymarket withdrawal/conversion
// drag — Polymarket itself is gas-free on Polygon for binary).
export function pnlPerDollar(ticket, outcome, feeBps = 0) {
  if (ticket.side === "FLAT") return 0;
  const fee = feeBps / 10000;
  const won =
    (ticket.side === "YES" && outcome === "UP") ||
    (ticket.side === "NO" && outcome === "DOWN");
  const gross = won ? (1 - ticket.price) / ticket.price : -1;
  return gross - fee;
}

// Two-sided binomial p-value (normal approximation, sample-size > 20).
// H0: hit rate = 0.5. Returns p value for observed wins out of n.
export function binomialPValue(wins, n) {
  if (n === 0) return 1;
  const p = 0.5;
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  const z = (wins - mean) / sd;
  // Two-sided
  return 2 * (1 - normalCdf(Math.abs(z)));
}

function normalCdf(z) {
  // Abramowitz & Stegun 26.2.17 — error < 7.5e-8
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t *
            (1.781477937 +
              t * (-1.821255978 + t * 1.330274429))));
  return 1 - p;
}

// Run the backtest over a list of {market, outcome} pairs.
export function runBacktest({ markets, outcomes, params }) {
  const tickets = [];
  for (const m of markets) {
    const decisionTs = m.marketEndTs - (params.decisionBufferSec || 60) * 1000;
    const f = featuresAtDecision({
      trades: m.trades,
      marketStartTs: m.marketStartTs,
      marketEndTs: m.marketEndTs,
      decisionTs,
    });
    const t = decideTicket(f, params);
    const outcome = outcomes[m.slug]?.outcome || null;
    if (t.side !== "FLAT" && outcome) {
      const pnl = pnlPerDollar(t, outcome, params.feeBps || 0);
      tickets.push({
        slug: m.slug,
        side: t.side,
        price: t.price,
        outcome,
        pnl,
        win: pnl > 0,
        netYesUsdLate: f.netYesUsdLate,
        hhiAll: f.hhiAll,
        nTradesLate: f.nTradesLate,
        marketStartTs: m.marketStartTs,
      });
    }
  }
  const wins = tickets.filter((t) => t.win).length;
  const n = tickets.length;
  const hitRate = n ? wins / n : 0;
  const totalPnl = tickets.reduce((s, t) => s + t.pnl, 0);
  const expectancy = n ? totalPnl / n : 0;
  const pValue = binomialPValue(wins, n);
  return {
    n,
    wins,
    losses: n - wins,
    hitRate,
    totalPnlPerDollar: totalPnl,
    expectancyPerDollar: expectancy,
    pValue,
    tickets,
  };
}
