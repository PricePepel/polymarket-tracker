#!/usr/bin/env node
// Run the backtest with a parameter sweep and print a summary table.

import fs from "node:fs";
import path from "node:path";
import { parseDir, groupByMarket } from "../src/parse.mjs";
import { runBacktest } from "../src/backtest.mjs";

const DEFAULT_DATA_DIR =
  "C:\\Users\\Asus\\Documents\\Obsidian Vault\\Polymarket-Tracker\\data\\btc-5m";
const dataDir = process.argv[2] || DEFAULT_DATA_DIR;
const cachePath = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""),
  "..",
  "cache",
  "outcomes.json"
);

if (!fs.existsSync(cachePath)) {
  console.error(`outcomes cache not found: ${cachePath}\nRun:  node bin/resolve.mjs`);
  process.exit(2);
}

const { trades } = parseDir(dataDir);
const markets = groupByMarket(trades);
const outcomes = JSON.parse(fs.readFileSync(cachePath, "utf8"));

const grids = {
  thresh: [25, 50, 100, 200, 400],
  pMin: [0.15, 0.30, 0.50],
  pMax: [0.85, 0.90, 0.95],
  minLateTrades: [1, 2, 3],
  decisionBufferSec: [30, 60, 90],
};

const rows = [];
for (const thresh of grids.thresh) {
  for (const pMin of grids.pMin) {
    for (const pMax of grids.pMax) {
      if (pMax <= pMin) continue;
      for (const minLateTrades of grids.minLateTrades) {
        for (const decisionBufferSec of grids.decisionBufferSec) {
          const r = runBacktest({
            markets,
            outcomes,
            params: { thresh, pMin, pMax, minLateTrades, decisionBufferSec },
          });
          rows.push({
            thresh,
            pMin,
            pMax,
            minLateTrades,
            decisionBufferSec,
            n: r.n,
            hitRate: r.hitRate,
            expectancy: r.expectancyPerDollar,
            pValue: r.pValue,
          });
        }
      }
    }
  }
}

// Sort by expectancy * sqrt(n) (a rough bayesian-ish ranking that rewards
// both edge and sample size), but require n >= 20 so we don't celebrate
// 3-trade sweepstakes flukes.
const ranked = rows
  .filter((r) => r.n >= 20)
  .sort(
    (a, b) =>
      b.expectancy * Math.sqrt(b.n) - a.expectancy * Math.sqrt(a.n)
  );

console.log(`backtest grid: ${rows.length} configs, ${ranked.length} with n≥20`);
console.log("");
console.log(
  "thresh  pMin  pMax  minLT  decBuf  n    hit%   exp$    pVal"
);
console.log(
  "----------------------------------------------------------------"
);
for (const r of ranked.slice(0, 20)) {
  console.log(
    `${String(r.thresh).padStart(6)}  ${r.pMin.toFixed(2)}  ${r.pMax.toFixed(
      2
    )}  ${String(r.minLateTrades).padStart(5)}  ${String(
      r.decisionBufferSec
    ).padStart(6)}  ${String(r.n).padStart(3)}  ${(r.hitRate * 100)
      .toFixed(1)
      .padStart(5)}  ${r.expectancy.toFixed(3).padStart(6)}  ${r.pValue
      .toFixed(3)
      .padStart(5)}`
  );
}

// Also report a baseline: bet randomly (50/50) — expectancy should be ~0
// under the same payout structure with no edge.
console.log("");
console.log("WORST 5 (sanity — should be no worse than random):");
for (const r of ranked.slice(-5)) {
  console.log(
    `${String(r.thresh).padStart(6)}  ${r.pMin.toFixed(2)}  ${r.pMax.toFixed(
      2
    )}  ${String(r.minLateTrades).padStart(5)}  ${String(
      r.decisionBufferSec
    ).padStart(6)}  ${String(r.n).padStart(3)}  ${(r.hitRate * 100)
      .toFixed(1)
      .padStart(5)}  ${r.expectancy.toFixed(3).padStart(6)}  ${r.pValue
      .toFixed(3)
      .padStart(5)}`
  );
}

// Save full results
const outPath = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""),
  "..",
  "cache",
  "backtest.json"
);
fs.writeFileSync(outPath, JSON.stringify(ranked, null, 2));
console.log(`\nfull ranked grid saved → ${outPath}`);
