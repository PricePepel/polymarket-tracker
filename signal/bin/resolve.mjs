#!/usr/bin/env node
// Resolve all historical markets present in the scan logs and cache outcomes.

import path from "node:path";
import { parseDir, groupByMarket } from "../src/parse.mjs";
import { resolveAll } from "../src/resolve.mjs";

const DEFAULT_DATA_DIR =
  "C:\\Users\\Asus\\Documents\\Obsidian Vault\\Polymarket-Tracker\\data\\btc-5m";
const dataDir = process.argv[2] || DEFAULT_DATA_DIR;
const cachePath = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""),
  "..",
  "cache",
  "outcomes.json"
);

const { trades } = parseDir(dataDir);
const markets = groupByMarket(trades);
const slugs = markets.map((m) => m.slug);
console.log(`resolving ${slugs.length} markets...`);

const cache = await resolveAll({
  slugs,
  cachePath,
  concurrency: 6,
  onProgress: (done, total) =>
    console.log(`  ${done} / ${total}`),
});

let up = 0,
  down = 0,
  unknown = 0;
for (const slug of slugs) {
  const r = cache[slug];
  if (r?.outcome === "UP") up++;
  else if (r?.outcome === "DOWN") down++;
  else unknown++;
}
console.log(`outcomes:           UP=${up}  DOWN=${down}  unknown=${unknown}`);
console.log(`cache:              ${cachePath}`);
