#!/usr/bin/env node
// Walk-forward validation with realistic slippage + fee.
//
// Procedure:
//   1. Sort markets by start time.
//   2. Split TRAIN = first 60%, TEST = last 40%.
//   3. Sweep the parameter grid on TRAIN with slippage + fees ON.
//   4. Pick the best config by expectancy * sqrt(n) with n >= 20.
//   5. Evaluate that config on TEST. Report TRAIN vs TEST stats.
//
// Slippage default = 2 cents adverse to chosen side.
// Fee default = 100 bps (1%) flat per ticket.

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
  console.error(`outcomes cache missing: ${cachePath}\nRun: node bin/resolve.mjs`);
  process.exit(2);
}

const SLIPPAGE_CENTS = Number(process.env.SLIPPAGE_CENTS ?? 2);
const FEE_BPS = Number(process.env.FEE_BPS ?? 100);

const { trades } = parseDir(dataDir);
const all = groupByMarket(trades).sort(
  (a, b) => a.marketStartTs - b.marketStartTs
);
const outcomes = JSON.parse(fs.readFileSync(cachePath, "utf8"));

// Only consider markets with a known outcome
const labeled = all.filter((m) => outcomes[m.slug]?.outcome);
const split = Math.floor(labeled.length * 0.6);
const train = labeled.slice(0, split);
const test = labeled.slice(split);
console.log(
  `markets total=${all.length}  labeled=${labeled.length}  train=${train.length}  test=${test.length}`
);
console.log(`slippage=${SLIPPAGE_CENTS}¢  fees=${FEE_BPS}bps`);

const grid = {
  thresh: [25, 50, 100, 200],
  pMin: [0.15, 0.30, 0.50],
  pMax: [0.85, 0.90, 0.95],
  minLateTrades: [1, 2, 3],
  decisionBufferSec: [30, 60, 90],
};

const trainRows = [];
for (const thresh of grid.thresh)
  for (const pMin of grid.pMin)
    for (const pMax of grid.pMax) {
      if (pMax <= pMin) continue;
      for (const minLateTrades of grid.minLateTrades)
        for (const decisionBufferSec of grid.decisionBufferSec) {
          const params = {
            thresh,
            pMin,
            pMax,
            minLateTrades,
            decisionBufferSec,
            slippageCents: SLIPPAGE_CENTS,
            feeBps: FEE_BPS,
          };
          const r = runBacktest({ markets: train, outcomes, params });
          trainRows.push({ params, ...r });
        }
    }

const MIN_TRAIN_N = Number(process.env.MIN_TRAIN_N ?? 50);
const trainRanked = trainRows
  .filter((r) => r.n >= MIN_TRAIN_N)
  .sort((a, b) => b.expectancyPerDollar * Math.sqrt(b.n) - a.expectancyPerDollar * Math.sqrt(a.n));
console.log(`(picker requires TRAIN n >= ${MIN_TRAIN_N}; ${trainRanked.length} configs qualify)`);

console.log(`\nTRAIN top 10 by expectancy * sqrt(n):`);
console.log(
  "thresh  pMin  pMax  minLT  decBuf  n    hit%   exp$    pVal"
);
for (const r of trainRanked.slice(0, 10)) {
  const p = r.params;
  console.log(
    `${String(p.thresh).padStart(6)}  ${p.pMin.toFixed(2)}  ${p.pMax.toFixed(
      2
    )}  ${String(p.minLateTrades).padStart(5)}  ${String(
      p.decisionBufferSec
    ).padStart(6)}  ${String(r.n).padStart(3)}  ${(r.hitRate * 100)
      .toFixed(1)
      .padStart(5)}  ${r.expectancyPerDollar.toFixed(3).padStart(6)}  ${r.pValue
      .toFixed(3)
      .padStart(5)}`
  );
}

if (trainRanked.length === 0) {
  console.log("\nno TRAIN config met n>=20 — insufficient data; need more scans");
  process.exit(0);
}

const bestParams = trainRanked[0].params;
console.log(`\n→ best TRAIN config:`, bestParams);

const trainResult = trainRanked[0];
const testResult = runBacktest({ markets: test, outcomes, params: bestParams });

console.log(`\nTRAIN  n=${trainResult.n}  hit=${(trainResult.hitRate * 100).toFixed(1)}%  exp=$${trainResult.expectancyPerDollar.toFixed(3)}  pVal=${trainResult.pValue.toFixed(3)}`);
console.log(`TEST   n=${testResult.n}  hit=${(testResult.hitRate * 100).toFixed(1)}%  exp=$${testResult.expectancyPerDollar.toFixed(3)}  pVal=${testResult.pValue.toFixed(3)}`);

// Edge gate: in-sample edge survives out-of-sample with positive expectancy
// at p < 0.10 AND n >= 30.
const passes =
  testResult.expectancyPerDollar > 0 &&
  testResult.pValue < 0.10 &&
  testResult.n >= 30;
console.log(
  `\nGATE: expectancy>0 AND pVal<0.10 AND n>=30  →  ${passes ? "PASS ✓" : "FAIL ✗"}`
);

const outPath = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""),
  "..",
  "cache",
  "walkforward.json"
);
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      slippageCents: SLIPPAGE_CENTS,
      feeBps: FEE_BPS,
      bestParams,
      train: {
        n: trainResult.n,
        hitRate: trainResult.hitRate,
        expectancyPerDollar: trainResult.expectancyPerDollar,
        pValue: trainResult.pValue,
      },
      test: {
        n: testResult.n,
        hitRate: testResult.hitRate,
        expectancyPerDollar: testResult.expectancyPerDollar,
        pValue: testResult.pValue,
      },
      passed: passes,
    },
    null,
    2
  )
);
console.log(`saved → ${outPath}`);
