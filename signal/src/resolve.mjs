// Fetch and cache the true outcome for each historical btc-updown-5m-* market
// from Polymarket's gamma events endpoint. Cache stored as JSON for repeatable
// backtests.
//
// Endpoint: https://gamma-api.polymarket.com/events?slug=<slug>
// Resolution lives at: response[0].markets[0].outcomePrices, a JSON string like
//   "[\"1\", \"0\"]" → outcomes[0]="Up" won
//   "[\"0\", \"1\"]" → outcomes[1]="Down" won

import fs from "node:fs";
import path from "node:path";

const GAMMA_BASE = "https://gamma-api.polymarket.com/events";

export async function fetchOutcome(slug) {
  const res = await fetch(`${GAMMA_BASE}?slug=${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`gamma ${slug} → ${res.status} ${res.statusText}`);
  }
  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) return { slug, outcome: null, reason: "no event" };
  const ev = list[0];
  const m = ev.markets?.[0];
  if (!m) return { slug, outcome: null, reason: "no market" };
  if (!m.closed) return { slug, outcome: null, reason: "not closed" };
  let outcomes, prices;
  try {
    outcomes = JSON.parse(m.outcomes);
    prices = JSON.parse(m.outcomePrices).map(Number);
  } catch {
    return { slug, outcome: null, reason: "bad outcomes json" };
  }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== 2)
    return { slug, outcome: null, reason: "shape" };
  // Find the index where price === 1
  const winnerIdx = prices.findIndex((p) => p >= 0.99);
  if (winnerIdx < 0) return { slug, outcome: null, reason: "no winner price" };
  const winner = outcomes[winnerIdx]; // "Up" or "Down"
  return {
    slug,
    outcome: winner === "Up" ? "UP" : winner === "Down" ? "DOWN" : null,
    closedTime: m.closedTime || null,
    volume: Number(m.volume) || 0,
  };
}

// Resolve a list of slugs with limited concurrency, merging into a cache file.
export async function resolveAll({ slugs, cachePath, concurrency = 6, onProgress }) {
  let cache = {};
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      cache = {};
    }
  }
  const todo = slugs.filter((s) => !cache[s] || cache[s].outcome == null);
  let done = 0;
  let i = 0;
  const results = [];
  const workers = Array.from(
    { length: Math.min(concurrency, todo.length) },
    async () => {
      while (i < todo.length) {
        const idx = i++;
        const slug = todo[idx];
        try {
          const r = await fetchOutcome(slug);
          cache[slug] = r;
          results.push(r);
        } catch (err) {
          cache[slug] = { slug, outcome: null, reason: `error: ${err.message}` };
        }
        done++;
        if (onProgress && done % 10 === 0) onProgress(done, todo.length);
      }
    }
  );
  await Promise.all(workers);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return cache;
}
