import test from "node:test";
import assert from "node:assert/strict";
import { kellyFraction, sizeTicket, riskCheck, DEFAULTS } from "../src/sizing.mjs";

const yes = (price) => ({ side: "YES", price });

test("kellyFraction matches the binary Kelly formula", () => {
  // p=0.5 pays 1:1, so w=0.6 gives f* = 0.6 - 0.4 = 0.2.
  assert.ok(Math.abs(kellyFraction({ winProb: 0.6, price: 0.5 }) - 0.2) < 1e-9);
});

test("kellyFraction is zero or negative without an edge", () => {
  assert.ok(Math.abs(kellyFraction({ winProb: 0.7, price: 0.7 })) < 1e-9);
  assert.ok(kellyFraction({ winProb: 0.6, price: 0.7 }) < 0);
});

test("kellyFraction rejects impossible inputs", () => {
  assert.equal(kellyFraction({ winProb: 1, price: 0.5 }), 0);
  assert.equal(kellyFraction({ winProb: 0.5, price: 0 }), 0);
});

test("sizeTicket refuses a flat signal and a negative edge", () => {
  assert.equal(sizeTicket({ ticket: { side: "FLAT" }, winProb: 0.9, bankroll: 100, openExposure: 0 }).sizeUsd, 0);
  const noEdge = sizeTicket({ ticket: yes(0.9), winProb: 0.6, bankroll: 100, openExposure: 0 });
  assert.equal(noEdge.sizeUsd, 0);
  assert.equal(noEdge.reason, "negative kelly");
});

test("sizeTicket applies quarter Kelly below the cap", () => {
  const { sizeUsd, fUsed } = sizeTicket({ ticket: yes(0.5), winProb: 0.6, bankroll: 100, openExposure: 0 });
  assert.ok(Math.abs(fUsed - 0.05) < 1e-9);
  // Size rounds down to a cent, and floating point can land one cent under.
  assert.ok(sizeUsd >= 4.99 && sizeUsd <= 5, `got ${sizeUsd}`);
});

test("sizeTicket never exceeds the per-ticket cap", () => {
  const { fUsed } = sizeTicket({ ticket: yes(0.5), winProb: 0.99, bankroll: 100, openExposure: 0 });
  assert.equal(fUsed, DEFAULTS.maxFractionPerTicket);
});

test("sizeTicket shrinks to the remaining exposure budget", () => {
  const { sizeUsd } = sizeTicket({ ticket: yes(0.5), winProb: 0.99, bankroll: 100, openExposure: 25 });
  assert.ok(sizeUsd >= 4.99 && sizeUsd <= 5, `got ${sizeUsd}`);
  assert.equal(sizeTicket({ ticket: yes(0.5), winProb: 0.99, bankroll: 100, openExposure: 30 }).sizeUsd, 0);
});

test("riskCheck blocks live mode for each risk rule", () => {
  const clean = { halted: false, bankroll: 100, dailyStartBankroll: 100, consecutiveLosses: 0, paperRemainingScans: 0, mode: "LIVE" };
  assert.equal(riskCheck({ state: clean }).canGoLive, true);
  for (const change of [{ halted: true }, { bankroll: 79 }, { consecutiveLosses: 3 }, { paperRemainingScans: 1 }, { mode: "PAPER" }]) {
    assert.equal(riskCheck({ state: { ...clean, ...change } }).canGoLive, false, JSON.stringify(change));
  }
});
