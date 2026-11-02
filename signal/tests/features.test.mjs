import test from "node:test";
import assert from "node:assert/strict";
import { concentrationHHI, featuresAtDecision, lastSidePrices, netYesUsdInRange } from "../src/features.mjs";

const trade = (tradeTs, side, outcome, usd, wallet = "a", price = 0.5) => ({ tradeTs, side, outcome, usd, wallet, price });

test("buying Up and selling Down both count as bullish flow", () => {
  const trades = [trade(1, "BUY", "Up", 10), trade(2, "SELL", "Down", 5), trade(3, "BUY", "Down", 3), trade(4, "SELL", "Up", 2)];
  assert.equal(netYesUsdInRange(trades, 0, 10), 10);
});

test("net flow ignores trades outside the window", () => {
  const trades = [trade(1, "BUY", "Up", 10), trade(5, "BUY", "Up", 20), trade(9, "BUY", "Up", 40)];
  assert.equal(netYesUsdInRange(trades, 2, 8), 20);
});

test("concentration is 1 for one wallet and 0.5 for two equal wallets", () => {
  assert.equal(concentrationHHI([trade(1, "BUY", "Up", 10)]), 1);
  assert.equal(concentrationHHI([trade(1, "BUY", "Up", 10, "a"), trade(2, "BUY", "Up", 10, "b")]), 0.5);
  assert.equal(concentrationHHI([]), 0);
});

test("the last observed price wins for each side", () => {
  const trades = [trade(1, "BUY", "Up", 1, "a", 0.4), trade(2, "BUY", "Up", 1, "a", 0.6), trade(3, "BUY", "Down", 1, "a", 0.3)];
  assert.deepEqual(lastSidePrices(trades), { yesPrice: 0.6, noPrice: 0.3 });
});

test("features never see a trade made after the decision", () => {
  const start = 0, decision = 200_000;
  const before = trade(190_000, "BUY", "Up", 10, "a", 0.6);
  const leak = trade(250_000, "BUY", "Up", 1000, "b", 0.99);
  const clean = featuresAtDecision({ trades: [before], marketStartTs: start, marketEndTs: 300_000, decisionTs: decision });
  const withFuture = featuresAtDecision({ trades: [before, leak], marketStartTs: start, marketEndTs: 300_000, decisionTs: decision });
  assert.deepEqual(withFuture, clean);
  assert.equal(withFuture.yesPrice, 0.6);
});

test("the late window covers only the final 90 seconds", () => {
  const trades = [trade(100_000, "BUY", "Up", 7), trade(150_000, "BUY", "Up", 11)];
  const f = featuresAtDecision({ trades, marketStartTs: 0, marketEndTs: 300_000, decisionTs: 200_000 });
  assert.equal(f.netYesUsdAll, 18);
  assert.equal(f.netYesUsdLate, 11);
  assert.equal(f.nTradesLate, 1);
});
