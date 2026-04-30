#!/usr/bin/env node
// Polymarket BTC up/down 5m tracker.
// Pulls top 50 CRYPTO traders (weekly volume), checks their recent trades,
// keeps only btc-updown-5m-* trades since the last run, and appends the
// new trades to today's note.
//
// Two output modes:
//   OUTPUT_MODE=obsidian (default) — POST to Obsidian Local REST API
//   OUTPUT_MODE=file              — append to a markdown file under DATA_DIR
//                                    (used by GitHub Actions CI)
//
// Usage:
//   node track.mjs            # normal run (Obsidian mode by default)
//   node track.mjs --dry-run  # fetches, prints; no writes, no state update
//   OUTPUT_MODE=file node track.mjs   # CI/cloud mode

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────

const STATE_PATH = path.join(__dirname, "state.json");
const DRY_RUN = process.argv.includes("--dry-run");

const OUTPUT_MODE = (process.env.OUTPUT_MODE || "obsidian").toLowerCase();
const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data", "btc-5m");

const OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY;
const OBSIDIAN_HOST = process.env.OBSIDIAN_HOST || "https://127.0.0.1:27124";

if (!DRY_RUN && OUTPUT_MODE === "obsidian" && !OBSIDIAN_API_KEY) {
  console.error(
    "ERROR: OBSIDIAN_API_KEY env var is required for OUTPUT_MODE=obsidian (or pass --dry-run, or set OUTPUT_MODE=file)."
  );
  process.exit(2);
}

if (!["obsidian", "file"].includes(OUTPUT_MODE)) {
  console.error(`ERROR: unknown OUTPUT_MODE='${OUTPUT_MODE}'. Use 'obsidian' or 'file'.`);
  process.exit(2);
}

const LEADERBOARD_URL =
  "https://data-api.polymarket.com/v1/leaderboard?category=CRYPTO&timePeriod=WEEK&orderBy=VOL&limit=50";

const TRADES_PER_USER = 100; // upper bound — Polymarket /trades supports up to 10000
const SLUG_PREFIX = "btc-updown-5m-";
const SEEN_HASH_CAP = 5000; // bound state file size

// ─── State ────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastTimestamp: Number(parsed.lastTimestamp) || 0,
      seenHashes: Array.isArray(parsed.seenHashes) ? parsed.seenHashes : [],
    };
  } catch {
    return { lastTimestamp: 0, seenHashes: [] };
  }
}

function saveState(state) {
  // Keep the last N hashes only, dedup
  const trimmed = Array.from(new Set(state.seenHashes)).slice(-SEEN_HASH_CAP);
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ lastTimestamp: state.lastTimestamp, seenHashes: trimmed }, null, 2)
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function obsidianAppend(vaultPath, body) {
  // Per Local REST API docs: POST /vault/{filepath} appends the request body
  // to the file (creating the file and parent dirs if missing).
  const url = `${OBSIDIAN_HOST}/vault/${encodeURI(vaultPath)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Obsidian POST ${vaultPath} → ${res.status} ${res.statusText}: ${text}`);
  }
}

function appendToDiskFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Ensure trailing newline separates appends cleanly.
  const exists = fs.existsSync(filePath);
  const sep = exists ? "" : "";
  fs.appendFileSync(filePath, sep + body, "utf8");
}

// ─── Polymarket fetchers ──────────────────────────────────────────────────

async function fetchTopTraders() {
  const list = await getJson(LEADERBOARD_URL);
  return list.map((t) => ({
    rank: Number(t.rank),
    wallet: String(t.proxyWallet).toLowerCase(),
    userName: t.userName || t.proxyWallet,
    vol: Number(t.vol) || 0,
    pnl: Number(t.pnl) || 0,
  }));
}

async function fetchUserTrades(wallet) {
  const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=${TRADES_PER_USER}&takerOnly=true`;
  try {
    const list = await getJson(url);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error(`  failed for ${wallet}: ${err.message}`);
    return [];
  }
}

// Run a list of async tasks with limited concurrency.
async function runWithLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Filtering / formatting ───────────────────────────────────────────────

function isBtcUpDown5m(trade) {
  const slug = trade.eventSlug || trade.slug || "";
  return typeof slug === "string" && slug.startsWith(SLUG_PREFIX);
}

function formatTrade(trader, trade) {
  const ts = Number(trade.timestamp) || 0; // Polymarket trades are unix seconds
  const date = new Date(ts * 1000);
  const time = date.toISOString().slice(11, 19) + "Z";

  const side = (trade.side || "?").toUpperCase();
  const outcome = trade.outcome || "?";
  const size = Number(trade.size) || 0;
  const price = Number(trade.price) || 0;
  const usd = size * price;
  const eventSlug = trade.eventSlug || trade.slug || "";
  const eventTitle = trade.title || eventSlug;
  const profileUrl = `https://polymarket.com/profile/${trader.wallet}`;
  const eventUrl = eventSlug ? `https://polymarket.com/event/${eventSlug}` : "";

  const traderLabel = trader.userName?.startsWith("0x")
    ? `\`${trader.wallet.slice(0, 10)}…\``
    : `**${trader.userName}**`;

  const eventLink = eventUrl ? `[${eventTitle}](${eventUrl})` : eventTitle;
  const usdStr = usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;

  return `- \`${time}\` [#${trader.rank}] ${traderLabel} [profile](${profileUrl}) — **${side} ${outcome}** ${size.toFixed(2)} @ $${price.toFixed(3)} (${usdStr}) → ${eventLink}`;
}

function todaysDateString() {
  // YYYY-MM-DD in UTC (so cloud + local agree)
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

const FIRST_RUN_LOOKBACK_SEC = 30 * 60; // 30 min on a fresh state file

async function main() {
  const startedAt = Date.now();
  const state = loadState();
  const seenHashes = new Set(state.seenHashes);
  // On first run (no prior state), only look back FIRST_RUN_LOOKBACK_SEC
  // to avoid dumping the full /trades history (up to ~5000 trades) into Obsidian.
  const since =
    state.lastTimestamp > 0
      ? state.lastTimestamp
      : Math.floor(startedAt / 1000) - FIRST_RUN_LOOKBACK_SEC;

  console.log(`[${new Date().toISOString()}] tracker run — since=${since} dryRun=${DRY_RUN}`);

  const traders = await fetchTopTraders();
  console.log(`fetched ${traders.length} top CRYPTO traders`);

  const traderByWallet = new Map(traders.map((t) => [t.wallet, t]));

  // Fetch trades with limited concurrency to be polite
  const allTradesByWallet = await runWithLimit(traders, 8, async (trader) => {
    const trades = await fetchUserTrades(trader.wallet);
    return { wallet: trader.wallet, trades };
  });

  // Filter to btc-updown-5m + new since last run + not in seenHashes
  let maxTs = since;
  const newEntries = [];
  for (const { wallet, trades } of allTradesByWallet) {
    const trader = traderByWallet.get(wallet);
    for (const trade of trades) {
      const ts = Number(trade.timestamp) || 0;
      if (ts <= since) continue;
      if (!isBtcUpDown5m(trade)) continue;
      const hash = trade.transactionHash || `${wallet}:${ts}:${trade.asset}`;
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      if (ts > maxTs) maxTs = ts;
      newEntries.push({ trader, trade, ts, hash });
    }
  }

  newEntries.sort((a, b) => a.ts - b.ts);
  console.log(`new btc-updown-5m trades since last run: ${newEntries.length}`);

  if (newEntries.length === 0) {
    if (!DRY_RUN) {
      // Still update lastTimestamp so we don't keep scanning the same window
      state.lastTimestamp = Math.max(state.lastTimestamp, Math.floor(startedAt / 1000) - 60);
      state.seenHashes = Array.from(seenHashes);
      saveState(state);
    }
    console.log("nothing to log; exiting");
    return;
  }

  // Build the markdown block
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const lines = [
    "",
    `### scan @ ${stamp} — ${newEntries.length} new trade${newEntries.length === 1 ? "" : "s"}`,
    "",
    ...newEntries.map((e) => formatTrade(e.trader, e.trade)),
    "",
  ];
  const block = lines.join("\n");

  if (DRY_RUN) {
    console.log("--- DRY RUN OUTPUT ---");
    console.log(block);
    console.log("--- END DRY RUN ---");
    return;
  }

  // Write the block — either to Obsidian REST or to a file on disk.
  const yyyymmdd = todaysDateString();
  const fileName = `${yyyymmdd}.md`;
  let writtenTo = "";

  if (OUTPUT_MODE === "obsidian") {
    const vaultPath = `Polymarket/btc-5m/${fileName}`;
    // Self-signed cert on Obsidian REST.
    const prevTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await obsidianAppend(vaultPath, block);
    } finally {
      if (prevTLS === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTLS;
    }
    writtenTo = `obsidian://${vaultPath}`;
  } else {
    const filePath = path.join(DATA_DIR, fileName);
    appendToDiskFile(filePath, block);
    writtenTo = filePath;
  }

  state.lastTimestamp = maxTs;
  state.seenHashes = Array.from(seenHashes);
  saveState(state);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`appended ${newEntries.length} entries to ${writtenTo} in ${elapsed}s`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
