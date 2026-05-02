#!/usr/bin/env node
// Regenerate signal/PAPER-TRADER-LOG.md from state.json.
// Idempotent: re-run after every scan; the file is fully derived from state.
// The polymarket-tracker repo is synced into the user's Obsidian vault via
// the Obsidian Git plugin, so this file shows up there automatically.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const statePath = path.join(root, "state.json");
const outPath = path.join(root, "PAPER-TRADER-LOG.md");

if (!fs.existsSync(statePath)) {
  console.log(`[update-log] no state.json at ${statePath}, skipping`);
  process.exit(0);
}

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

const totalPnl = (state.bankroll - state.startingBankroll).toFixed(2);
const totalPct = (
  ((state.bankroll - state.startingBankroll) / state.startingBankroll) *
  100
).toFixed(2);
const wins = state.paperWins || 0;
const losses = state.paperLosses || 0;
const totalBets = wins + losses;
const hitRate = totalBets ? ((wins / totalBets) * 100).toFixed(0) : "—";

// Group closed tickets by UTC settle date (YYYY-MM-DD).
const byDay = new Map();
for (const t of state.closedTickets || []) {
  const day = (t.settledAt || t.emittedAt || "").slice(0, 10);
  if (!day) continue;
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(t);
}

// Newest day first.
const days = [...byDay.keys()].sort().reverse();

const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : "—");
// Render a USD amount with sign before the dollar sign: +$1.23 / -$1.23.
const usd = (n, d = 2) => {
  if (typeof n !== "number") return "—";
  const a = Math.abs(n).toFixed(d);
  return `${n < 0 ? "-" : "+"}$${a}`;
};

const lines = [];
lines.push("# Polymarket paper trader — log");
lines.push("");
lines.push("_Auto-generated from `signal/state.json` on every cloud scan._");
lines.push("_Do not edit by hand — changes will be overwritten._");
lines.push("");
lines.push("## Running totals");
lines.push("");
lines.push(`- **Bankroll:** $${fmt(state.bankroll)} (started $${fmt(state.startingBankroll)})`);
lines.push(`- **All-time PnL:** ${usd(+totalPnl)} (${+totalPct >= 0 ? "+" : ""}${totalPct}%)`);
lines.push(`- **Mode:** ${state.mode}${state.halted ? " · ⚠ HALTED" : ""}`);
lines.push(`- **W/L:** ${wins} / ${losses}  (hit rate ${hitRate}%)`);
lines.push(`- **Scans completed:** ${state.paperScanCount || 0}`);
lines.push(`- **Open tickets:** ${(state.openTickets || []).length}`);
lines.push(`- **Consecutive losses:** ${state.consecutiveLosses || 0}`);
if (state.dailyDate) {
  const dayPnl = (state.bankroll - (state.dailyStartBankroll || state.bankroll)).toFixed(2);
  lines.push(`- **Today (${state.dailyDate}) PnL:** ${usd(+dayPnl)}`);
}
lines.push("");
lines.push("## Daily snapshots");
lines.push("");

if (days.length === 0) {
  lines.push("_No settled tickets yet._");
  lines.push("");
} else {
  for (const day of days) {
    const tickets = byDay.get(day);
    const dayPnl = tickets.reduce((s, t) => s + (t.pnlUsd || 0), 0);
    const dayWins = tickets.filter((t) => t.won).length;
    const dayLosses = tickets.filter((t) => t.won === false).length;

    lines.push(`### ${day}`);
    lines.push("");
    lines.push(
      `Day PnL: **${usd(dayPnl)}** · W/L: **${dayWins}/${dayLosses}** · trades: ${tickets.length}`
    );
    lines.push("");
    lines.push("| Time (UTC) | Side | Entry | Size | Outcome | Result | PnL |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const t of tickets) {
      const time = (t.emittedAt || "").slice(11, 16);
      const result = t.won === true ? "✅ WIN" : t.won === false ? "❌ LOSS" : "—";
      lines.push(
        `| ${time} | ${t.side} | $${fmt(t.entryPrice, 3)} | $${fmt(t.sizeUsd)} | ${t.outcome || "—"} | ${result} | ${usd(t.pnlUsd || 0)} |`
      );
    }
    lines.push("");
  }
}

lines.push(`---`);
lines.push(`_Last updated: ${new Date().toISOString()}_`);
lines.push("");

fs.writeFileSync(outPath, lines.join("\n"));
console.log(`[update-log] wrote ${outPath} (${days.length} days, ${totalBets} trades)`);
