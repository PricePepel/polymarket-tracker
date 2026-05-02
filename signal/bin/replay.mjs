#!/usr/bin/env node
// Replay the live tick over the last N historical markets to validate the
// end-to-end ticket-emission + settlement path. Useful for visualizing what
// 50 forward paper tickets will look like.
//
// Usage: node bin/replay.mjs [N=30]

import fs from "node:fs";
import path from "node:path";
import { parseDir, groupByMarket } from "../src/parse.mjs";
import { tick } from "../src/live.mjs";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""),
  ".."
);
const dataDir =
  process.env.SIGNAL_DATA_DIR ||
  "C:\\Users\\Asus\\Documents\\Obsidian Vault\\Polymarket-Tracker\\data\\btc-5m";

const N = Number(process.argv[2] || 30);

// Use a separate state/tickets dir so we don't clobber the real one.
const replayRoot = path.join(root, "cache", "replay");
fs.rmSync(replayRoot, { recursive: true, force: true });
fs.mkdirSync(replayRoot, { recursive: true });

const { trades } = parseDir(dataDir);
const markets = groupByMarket(trades);
const recent = markets.slice(-N);

console.log(`replaying ${recent.length} markets (paper mode)`);
console.log("");

for (const m of recent) {
  // Tick "1 second before market close" so featuresAtDecision sees the
  // full late window.
  const nowMs = m.marketEndTs - 1000;
  const result = await tick({
    dataDir,
    outcomesPath: path.join(root, "cache", "outcomes.json"),
    ticketsDir: path.join(replayRoot, "tickets"),
    statePath: path.join(replayRoot, "state.json"),
    nowMs,
  });
  // Re-tick at marketEnd + 60s to settle
  await tick({
    dataDir,
    outcomesPath: path.join(root, "cache", "outcomes.json"),
    ticketsDir: path.join(replayRoot, "tickets"),
    statePath: path.join(replayRoot, "state.json"),
    nowMs: m.marketEndTs + 60_000,
  });
  if (result.summary.verdict === "YES" || result.summary.verdict === "NO") {
    const t = result.summary.ticket;
    console.log(
      `${t.emittedAt}  ${t.mode}  ${t.side} @ $${t.entryPrice.toFixed(
        3
      )}  size=$${t.sizeUsd.toFixed(2)}  net=$${t.netYesUsdLate.toFixed(
        0
      )}  ${t.slug}`
    );
  }
}

const finalState = JSON.parse(
  fs.readFileSync(path.join(replayRoot, "state.json"), "utf8")
);
console.log("");
console.log(`replay complete:`);
console.log(`  bankroll:        $${finalState.bankroll.toFixed(2)} (started $${finalState.startingBankroll.toFixed(2)})`);
console.log(`  paper W/L:       ${finalState.paperWins} / ${finalState.paperLosses}`);
console.log(`  paper PnL:       $${finalState.paperPnl.toFixed(2)}`);
console.log(`  closed tickets:  ${finalState.closedTickets.length}`);
console.log(`  open tickets:    ${finalState.openTickets.length}`);
const wins = finalState.closedTickets.filter((t) => t.won).length;
const totalNonFlat = finalState.closedTickets.length;
if (totalNonFlat > 0) {
  console.log(`  hit rate:        ${((wins / totalNonFlat) * 100).toFixed(1)}%`);
  const roi =
    ((finalState.bankroll - finalState.startingBankroll) /
      finalState.startingBankroll) *
    100;
  console.log(`  ROI:             ${roi.toFixed(1)}%`);
}
console.log(`  artifacts:       ${replayRoot}`);
