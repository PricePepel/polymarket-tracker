#!/usr/bin/env node
// Quick sanity stats over the existing scan data.
// Usage: node bin/stats.mjs [DATA_DIR]

import path from "node:path";
import { parseDir, groupByMarket, netYesUsd } from "../src/parse.mjs";

const DEFAULT_DATA_DIR =
  "C:\\Users\\Asus\\Documents\\Obsidian Vault\\Polymarket-Tracker\\data\\btc-5m";
const dataDir = process.argv[2] || DEFAULT_DATA_DIR;

const { trades, totalSkipped } = parseDir(dataDir);
console.log(`data dir:           ${dataDir}`);
console.log(`parsed trades:      ${trades.length}`);
console.log(`skipped lines:      ${totalSkipped}`);

if (trades.length === 0) {
  console.log("no trades — exiting");
  process.exit(0);
}

const first = trades[0];
const last = trades[trades.length - 1];
const span =
  (last.tradeTs - first.tradeTs) / 1000 / 60 / 60;
console.log(
  `time span:          ${new Date(first.tradeTs).toISOString()} → ${new Date(
    last.tradeTs
  ).toISOString()}  (${span.toFixed(1)} h)`
);

const markets = groupByMarket(trades);
console.log(`unique markets:     ${markets.length}`);
const tradesPerMarket = markets.map((m) => m.trades.length);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
console.log(
  `trades / market:    median ${median(tradesPerMarket)}, max ${Math.max(
    ...tradesPerMarket
  )}, mean ${(sum(tradesPerMarket) / markets.length).toFixed(1)}`
);

// Side / outcome breakdown
const counts = { BUY_Up: 0, BUY_Down: 0, SELL_Up: 0, SELL_Down: 0 };
let totalUsd = 0;
for (const t of trades) {
  counts[`${t.side}_${t.outcome}`]++;
  totalUsd += t.usd;
}
console.log(`side × outcome:`);
for (const [k, v] of Object.entries(counts)) {
  console.log(`  ${k.padEnd(10)} ${v.toString().padStart(6)}`);
}
console.log(`total USD:          $${totalUsd.toFixed(0)}`);

// Top traders by total USD
const byWallet = new Map();
for (const t of trades) {
  const cur = byWallet.get(t.wallet) || {
    wallet: t.wallet,
    name: t.name,
    rank: t.rank,
    usd: 0,
    n: 0,
  };
  cur.usd += t.usd;
  cur.n++;
  byWallet.set(t.wallet, cur);
}
const top = Array.from(byWallet.values())
  .sort((a, b) => b.usd - a.usd)
  .slice(0, 10);
console.log(`top 10 traders by total USD:`);
for (const t of top) {
  console.log(
    `  rank #${String(t.rank).padStart(2)}  ${t.name
      .padEnd(40)
      .slice(0, 40)}  trades=${String(t.n).padStart(4)}  $${t.usd.toFixed(0)}`
  );
}

// Closing-price oracle preview: for each market, look at last trades
// to see whether the side trades clustered near $1 or $0.
let upWins = 0,
  downWins = 0,
  unclear = 0;
for (const m of markets) {
  // Use only trades in the last 60s of the market (after marketEnd - 60s),
  // but if there are none, use the last 3 trades regardless.
  const lateCut = m.marketEndTs - 60_000;
  let late = m.trades.filter((t) => t.tradeTs >= lateCut);
  if (late.length === 0) late = m.trades.slice(-3);

  // Approximate UP-side price: trades on Up at the end. Take the median price
  // of the latest Up-related trades, similarly for Down.
  const upPrices = late
    .filter((t) => t.outcome === "Up")
    .map((t) => t.price);
  const downPrices = late
    .filter((t) => t.outcome === "Down")
    .map((t) => t.price);

  const lastUp = upPrices.length ? upPrices[upPrices.length - 1] : null;
  const lastDown = downPrices.length ? downPrices[downPrices.length - 1] : null;

  if (lastUp != null && lastUp >= 0.95) upWins++;
  else if (lastDown != null && lastDown >= 0.95) downWins++;
  else if (lastUp != null && lastUp <= 0.05) downWins++;
  else if (lastDown != null && lastDown <= 0.05) upWins++;
  else unclear++;
}
console.log(`oracle preview:     UP=${upWins}  DOWN=${downWins}  unclear=${unclear}  (over ${markets.length} markets)`);

// Pretty: how many markets have ≥ N trades (i.e., enough for any signal)
for (const k of [3, 5, 10, 20]) {
  const n = markets.filter((m) => m.trades.length >= k).length;
  console.log(`markets with ≥${k.toString().padStart(2)} trades:    ${n}`);
}

// Net YES USD distribution
const netYes = markets.map((m) => netYesUsd(m.trades));
netYes.sort((a, b) => a - b);
const pct = (p) => netYes[Math.min(netYes.length - 1, Math.floor(p * netYes.length))];
console.log(
  `net YES USD across markets:  p10=${pct(0.1).toFixed(0)}  median=${pct(
    0.5
  ).toFixed(0)}  p90=${pct(0.9).toFixed(0)}`
);
