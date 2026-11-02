// Holds the numbers published in README.md and the case study to the committed data.
// If this fails, the data changed: update the write-ups along with it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sizeTicket } from "../src/sizing.mjs";

const statePath = fileURLToPath(new URL("../state.json", import.meta.url));
const logPath = fileURLToPath(new URL("../PAPER-TRADER-LOG.md", import.meta.url));
const updateLog = fileURLToPath(new URL("../bin/update-log.mjs", import.meta.url));
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const tickets = state.closedTickets;
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

test("the win and loss counters match the published totals", () => {
  assert.equal(state.paperWins, 1053);
  assert.equal(state.paperLosses, 440);
  assert.equal(state.mode, "PAPER");
});

test("replaying every ticket reproduces the final bankroll", () => {
  const replayed = state.startingBankroll + sum(tickets, (t) => t.pnlUsd);
  assert.ok(Math.abs(replayed - state.bankroll) < 0.01, `replayed ${replayed}, state says ${state.bankroll}`);
});

test("the published peak and -99.51% loss are right", () => {
  let bankroll = state.startingBankroll, peak = bankroll;
  for (const t of tickets) {
    bankroll += t.pnlUsd;
    peak = Math.max(peak, bankroll);
  }
  assert.equal(peak.toFixed(2), "202.84");
  assert.equal(((state.bankroll / state.startingBankroll - 1) * 100).toFixed(2), "-99.51");
});

test("the hit rate sits on the size-weighted break-even", () => {
  const volume = sum(tickets, (t) => t.sizeUsd);
  const breakEven = sum(tickets, (t) => t.sizeUsd * t.entryPrice) / volume;
  const hitRate = sum(tickets, (t) => (t.won ? t.sizeUsd : 0)) / volume;
  assert.equal(breakEven.toFixed(3), "0.704");
  assert.equal(hitRate.toFixed(3), "0.705");
});

test("every ticket assumed the locked 88.2% win probability", () => {
  assert.ok(tickets.every((t) => t.winProb === 0.882));
});

test("at the final bankroll a ticket rounds down to nothing", () => {
  const { sizeUsd } = sizeTicket({ ticket: { side: "YES", price: 0.7 }, winProb: 0.882, bankroll: state.bankroll, openExposure: 0 });
  assert.equal(sizeUsd, 0);
});

test("the log regenerates identically from state", () => {
  const before = fs.readFileSync(logPath);
  try {
    execFileSync(process.execPath, [updateLog]);
    // Only the generation timestamp may differ.
    const normalize = (text) => text.toString().replace(/\r\n/g, "\n").replace(/_Last updated: .*_/, "");
    assert.equal(normalize(fs.readFileSync(logPath)), normalize(before));
  } finally {
    fs.writeFileSync(logPath, before);
  }
});
