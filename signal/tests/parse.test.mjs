import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isBullishUp, netYesUsd, parseDir, parseLine } from "../src/parse.mjs";

const sample = fileURLToPath(new URL("../../data/btc-5m/2026-05-01.md", import.meta.url));
const line = fs.readFileSync(sample, "utf8").split(/\r?\n/).find((l) => l.startsWith("- `"));

test("parseDir reads a single day's file and sorts by trade time", () => {
  const { trades, totalSkipped } = parseDir(sample);
  assert.ok(trades.length > 0);
  assert.equal(totalSkipped, 0);
  assert.ok(trades.every((t, i) => i === 0 || trades[i - 1].tradeTs <= t.tradeTs));
});

test("non-trade lines are skipped", () => {
  assert.equal(parseLine("### scan @ 2026-04-30 19:24:47 UTC — 149 new trades"), null);
  assert.equal(parseLine(""), null);
});

test("a real logged trade parses into canonical fields", () => {
  const t = parseLine(line);
  assert.ok(t, "expected the first logged trade to parse");
  assert.match(t.wallet, /^0x[0-9a-f]{40}$/);
  assert.ok(["BUY", "SELL"].includes(t.side));
  assert.ok(["Up", "Down"].includes(t.outcome));
  assert.ok(t.price > 0 && t.price < 1);
  assert.ok(t.usd > 0);
  assert.match(t.slug, /^btc-updown-5m-\d+$/);
});

test("markets last 5 minutes and a trade lands near its market", () => {
  const t = parseLine(line);
  assert.equal(t.marketEndTs - t.marketStartTs, 300_000);
  assert.ok(t.tradeTs >= t.marketStartTs - 300_000 && t.tradeTs <= t.marketEndTs + 1_800_000);
});

test("direction follows side and outcome together", () => {
  assert.equal(isBullishUp({ side: "BUY", outcome: "Up" }), true);
  assert.equal(isBullishUp({ side: "SELL", outcome: "Down" }), true);
  assert.equal(isBullishUp({ side: "BUY", outcome: "Down" }), false);
  assert.equal(isBullishUp({ side: "SELL", outcome: "Up" }), false);
});

test("net flow nets bullish against bearish", () => {
  assert.equal(netYesUsd([{ side: "BUY", outcome: "Up", usd: 10 }, { side: "BUY", outcome: "Down", usd: 4 }]), 6);
});
