// Parse polymarket-tracker scan logs into canonical trade objects.
//
// Input: markdown files under
//   C:\Users\Asus\Documents\Obsidian Vault\Polymarket-Tracker\data\btc-5m\YYYY-MM-DD.md
// Each tracked trade is a single line of the form:
//   - `HH:MM:SSZ` [#RANK] **Name** | `0xWALLET…` [profile](URL) — **SIDE OUTCOME** SIZE @ $PRICE ($USD) → [Title](https://polymarket.com/event/btc-updown-5m-EPOCH)
//
// Output: array of canonical trades:
//   { slug, marketStartTs, marketEndTs, tradeTs, rank, wallet, name, side, outcome, size, price, usd, raw }
//
// All timestamps are in UTC milliseconds. marketEndTs = marketStartTs + 5min.

import fs from "node:fs";
import path from "node:path";

const TRADE_LINE_RE =
  /^- `(\d{2}):(\d{2}):(\d{2})Z` \[#(\d+)\] (?:\*\*([^*]+)\*\*|`(0x[0-9a-fA-F…]+)`) \[profile\]\((https:\/\/polymarket\.com\/profile\/0x[0-9a-fA-F]+)\) — \*\*(BUY|SELL) (Up|Down)\*\* ([\d.]+) @ \$([\d.]+) \(\$([\d.]+)\) → \[([^\]]+)\]\(https:\/\/polymarket\.com\/event\/(btc-updown-5m-(\d+))\)\s*$/;

const MARKET_DURATION_MS = 5 * 60 * 1000;

export function parseLine(line) {
  const m = TRADE_LINE_RE.exec(line);
  if (!m) return null;
  const [
    ,
    hh,
    mm,
    ss,
    rankStr,
    nameOrUndef,
    walletShortOrUndef,
    profileUrl,
    side,
    outcome,
    sizeStr,
    priceStr,
    usdStr,
    title,
    slug,
    epochStr,
  ] = m;

  const wallet = profileUrl.split("/").pop().toLowerCase();
  const name = nameOrUndef ?? walletShortOrUndef;
  const rank = Number(rankStr);
  const epoch = Number(epochStr);
  const marketStartTs = epoch * 1000;
  const marketEndTs = marketStartTs + MARKET_DURATION_MS;

  // Reconstruct full UTC timestamp for the trade.
  // We know the market start; the trade happens within roughly
  // [marketStart - 60s, marketEnd + 60s]. Choose the day that puts
  // trade into that window, handling UTC midnight wrap.
  const startDay = new Date(marketStartTs);
  let tradeTs = Date.UTC(
    startDay.getUTCFullYear(),
    startDay.getUTCMonth(),
    startDay.getUTCDate(),
    Number(hh),
    Number(mm),
    Number(ss)
  );
  const ONE_DAY = 86_400_000;
  if (tradeTs < marketStartTs - 5 * 60 * 1000) tradeTs += ONE_DAY;
  else if (tradeTs > marketEndTs + 30 * 60 * 1000) tradeTs -= ONE_DAY;

  return {
    slug,
    marketStartTs,
    marketEndTs,
    tradeTs,
    rank,
    wallet,
    name,
    side, // BUY | SELL
    outcome, // Up | Down
    size: Number(sizeStr),
    price: Number(priceStr),
    usd: Number(usdStr),
    raw: line,
  };
}

export function parseFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const trades = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("- `")) continue;
    const t = parseLine(line);
    if (t) trades.push(t);
    else skipped++;
  }
  return { trades, skipped };
}

export function parseDir(dirPath) {
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .map((f) => path.join(dirPath, f));
  const all = [];
  let totalSkipped = 0;
  for (const f of files) {
    const { trades, skipped } = parseFile(f);
    all.push(...trades);
    totalSkipped += skipped;
  }
  // Dedup by (wallet, tradeTs, slug, side, outcome, size, price) — tracker can
  // theoretically log the same trade twice across overlapping scans, even with
  // its hash dedup, if we're paranoid.
  const seen = new Set();
  const deduped = [];
  for (const t of all) {
    const k = `${t.wallet}|${t.tradeTs}|${t.slug}|${t.side}|${t.outcome}|${t.size}|${t.price}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(t);
  }
  // Sort ascending by trade time
  deduped.sort((a, b) => a.tradeTs - b.tradeTs);
  return { trades: deduped, totalSkipped };
}

// Group trades by market slug, with per-market metadata.
export function groupByMarket(trades) {
  const byMarket = new Map();
  for (const t of trades) {
    let g = byMarket.get(t.slug);
    if (!g) {
      g = {
        slug: t.slug,
        marketStartTs: t.marketStartTs,
        marketEndTs: t.marketEndTs,
        trades: [],
      };
      byMarket.set(t.slug, g);
    }
    g.trades.push(t);
  }
  return Array.from(byMarket.values()).sort(
    (a, b) => a.marketStartTs - b.marketStartTs
  );
}

// Whether a single trade is "bullish for UP".
//   BUY Up    → bullish for UP
//   SELL Down → bullish for UP   (closing/exiting a Down)
//   BUY Down  → bullish for DOWN
//   SELL Up   → bullish for DOWN
export function isBullishUp(trade) {
  if (trade.side === "BUY" && trade.outcome === "Up") return true;
  if (trade.side === "SELL" && trade.outcome === "Down") return true;
  return false;
}

// Net YES (UP-bullish) USD flow for an array of trades.
export function netYesUsd(trades) {
  let net = 0;
  for (const t of trades) {
    net += isBullishUp(t) ? t.usd : -t.usd;
  }
  return net;
}
