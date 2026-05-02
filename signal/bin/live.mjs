#!/usr/bin/env node
// Entry point for the 5-min live signal loop. Run via cron / scheduled task
// AFTER the polymarket-tracker's own scan has completed.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { tick } from "../src/live.mjs";

// Cross-platform: fileURLToPath handles Windows drive letters AND Linux paths.
// (The hand-rolled replace(/^\//, "") variant only worked on Windows.)
const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

const result = await tick({
  dataDir:
    process.env.SIGNAL_DATA_DIR ||
    "C:\\Users\\Asus\\Documents\\Obsidian Vault\\Polymarket-Tracker\\data\\btc-5m",
  outcomesPath: path.join(root, "cache", "outcomes.json"),
  ticketsDir: path.join(root, "tickets"),
  statePath: path.join(root, "state.json"),
});

console.log(`mode=${result.state.mode}  bankroll=$${result.state.bankroll.toFixed(2)}  paperScansLeft=${result.state.paperRemainingScans}  consecLoss=${result.state.consecutiveLosses}`);
console.log(`paper PnL=$${result.state.paperPnl.toFixed(2)}  W/L=${result.state.paperWins}/${result.state.paperLosses}`);
console.log(`open tickets: ${result.state.openTickets.length}`);
console.log(``);

if (
  result.summary.verdict === "NO_OPEN_MARKET" ||
  result.summary.verdict === "TOO_EARLY" ||
  result.summary.verdict === "ALREADY_TICKETED"
) {
  console.log(`verdict: ${result.summary.verdict}  (${result.summary.reason})`);
} else if (result.summary.verdict === "FLAT") {
  console.log(`verdict: FLAT on ${result.summary.slug}  (${result.summary.reason})`);
} else if (!result.summary.ticket) {
  // Defensive: tick() promises ticket on YES/NO verdicts, but if anything
  // upstream goes sideways we don't want to crash the scheduled run.
  console.log(`verdict: ${result.summary.verdict}  (no ticket attached — investigate)`);
} else {
  const t = result.summary.ticket;
  console.log(`TICKET (${t.mode}):`);
  console.log(`  market:     ${t.slug}  closes ${new Date(t.marketEndTs).toISOString()}`);
  console.log(`  side:       ${t.side} @ $${t.entryPrice.toFixed(3)}  (observed $${t.observedPrice.toFixed(3)} + 2¢ slip)`);
  console.log(`  size:       $${t.sizeUsd.toFixed(2)}  (f*=${t.kellyFStar.toFixed(3)}, f_used=${t.kellyFUsed.toFixed(3)})`);
  console.log(`  thesis:     late top-50 net $${t.netYesUsdLate.toFixed(0)} over ${t.nTradesLate} trades (HHI ${t.hhi.toFixed(2)})`);
  if (t.riskNotes.length) console.log(`  risk:       ${t.riskNotes.join("; ")}`);
  console.log(``);
  console.log(`appended to: tickets/${new Date().toISOString().slice(0, 10)}.md`);
}
