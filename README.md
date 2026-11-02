# polymarket-tracker

[![CI](https://github.com/PricePepel/polymarket-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/PricePepel/polymarket-tracker/actions/workflows/ci.yml)

A research agent for Polymarket's BTC up/down 5-minute markets. It logs the top 50 CRYPTO traders' bets and feeds a signal layer that issues paper tickets. Scanning has been paused since October 28, 2026.

**Paper-traded only. Never deployed with real capital, and nothing here is financial advice.**

## Results

| Measure | Result |
|---|---|
| Settled paper trades | 1,493 (1,053 wins, 440 losses), all in May 2026 |
| Hit rate | 70.5% (95% CI about 68% to 73%) |
| Break-even hit rate at the prices paid | about 70.4%, size-weighted |
| Win probability the strategy assumed | 88.2% |
| Paper bankroll | $20.00 start, $202.84 peak on May 5, $0.10 final (-99.51%) |

The signal was right far more often than chance, but the market prices already reflected it, so there was no edge. Sizing at up to 10% of bankroll then turned no edge into a near-total loss. Live numbers are in [`signal/PAPER-TRADER-LOG.md`](signal/PAPER-TRADER-LOG.md), and the [case study](https://github.com/PricePepel/kan-case-studies/blob/main/polymarket.md) explains what happened.

## How it stayed up

- **Two triggers:** an external cron-job.org ping and the GitHub Actions schedule both start the same scan, so one failing doesn't stop the run.
- **Races resolve themselves:** cron-vs-cron collisions go through an auto-resolving rebase instead of failing the job.
- **Missed markets get recovered:** a 10-minute lookback over recently closed slugs catches markets that cron drift skipped.
- **State is idempotent:** `signal/PAPER-TRADER-LOG.md` regenerates entirely from `signal/state.json`, which makes recovery safe to rerun.
- **Strategy stays locked:** parameters were set by walk-forward validation and aren't re-tuned after deployment, to avoid look-back overfitting.

## Try it

Needs Node 20 or newer, and there's nothing to install. The repo holds about 1.4 GB of scan logs, so cloning takes a few minutes.

```bash
npm test                     # tests, including one that checks the results above against the data
node track.mjs --dry-run     # one real scan of Polymarket, without writing anything
node signal/bin/stats.mjs data/btc-5m/2026-05-01.md    # stats for one day of logs
```

The analysis scripts load trades into memory, so point them at a day or a small folder. The full log set is too large for Node's default heap.

## Running it

1. **Cloud (GitHub Actions).** Runs on GitHub's infrastructure and commits new trades to `data/btc-5m/YYYY-MM-DD.md`.
2. **Local, optional.** Runs the same script on your machine and writes through the Obsidian Local REST API.

## How the data reaches Obsidian

The cloud commits markdown files to this repo. To see them in Obsidian, install the [**Obsidian Git**](https://github.com/Vinzent03/obsidian-git) plugin and either:

- **Recommended**: in Obsidian Git settings, set the repo URL to this repo and check it out into a folder of your vault (e.g. `Polymarket-Tracker/`). Enable "Pull on startup" and "Auto-pull every N minutes".
- Or `git clone` this repo into a folder inside your vault manually.

Either way, when GitHub Actions commits new entries, your vault syncs them down on the next pull.

## Output format

Each scan adds a section like this to today's file:

```
### scan @ 2026-05-01 00:09:49 UTC — 12 new trades

- `19:09:48Z` [#22] **xuanxuan008** [profile](https://polymarket.com/profile/0xcfb1...) — **BUY Up** 192.40 @ $0.508 ($97.72) → [Bitcoin Up or Down - April 30, 2:40PM-2:45PM ET](https://polymarket.com/event/btc-updown-5m-1777574400)
- ...
```

## Files

| File | Purpose |
|------|---------|
| `track.mjs` | Main script — Node.js 20+ (no deps; uses built-in fetch) |
| `signal/src/` | Features, sizing and paper-ticket logic |
| `signal/bin/` | Stats, backtest and walk-forward scripts |
| `signal/tests/` | Tests for sizing, features, parsing and the published results |
| `signal/state.json` | Paper-trading state, the source of `PAPER-TRADER-LOG.md` |
| `package.json` | Project metadata |
| `state.json` | Last seen timestamp + recent transaction hashes (committed by CI) |
| `data/btc-5m/YYYY-MM-DD.md` | Daily trade log (committed by CI) |
| `.github/workflows/scan.yml` | GitHub Actions cron, every 5 min |
| `run.bat.example` | Template for the local wrapper (copy to `run.bat` and fill in your API key) |

## Cloud mode (GitHub Actions)

The schedule is in `scan.yml`. The workflow is currently disabled on the **Actions** tab, so nothing runs until it's enabled again.

To trigger a one-off run once it's enabled: GitHub repo → Actions → "Polymarket BTC 5m scan" → Run workflow.

## Local mode (manual or scheduled)

```powershell
cd polymarket-tracker

# Dry run — no writes
node track.mjs --dry-run

# Local Obsidian write (requires run.bat with your API key)
.\run.bat

# Or run as the same script GitHub Actions uses (writes to ./data/)
$env:OUTPUT_MODE="file"; node track.mjs
```

## Tuning

Edit constants in `track.mjs`:

- `TRADES_PER_USER` (default 100) — how many recent trades per trader to scan
- `FIRST_RUN_LOOKBACK_SEC` (default 1800 = 30 min) — how far back the *first* run looks (when `state.json` is empty)
- `SLUG_PREFIX` — change to track a different family of markets (e.g. `eth-updown-5m-`)
- `LEADERBOARD_URL` — change category (`CRYPTO`, `OVERALL`, etc.) or order (`PNL` vs `VOL`)

## Caveats

- **Obsidian Git pulls when Obsidian is open** — if you want fresh data immediately when you open Obsidian, enable "Pull on startup" in the plugin settings.
- **GitHub Actions cron has slack** — runs may be delayed up to ~10 min during platform load. The script dedupes by `transactionHash`, so delays just compress into the next scan.
- The Polymarket leaderboard refreshes its top-50 list each run, so traders rotating in/out of the top 50 are picked up automatically.
- Polymarket's data API is currently unauthenticated — this could change. If runs start returning 401/403, switch to the authenticated CLOB endpoints.
- `state.json` keeps the last 5000 transaction hashes for dedup, bounding repo size.
