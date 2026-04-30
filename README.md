# Polymarket BTC 5m Tracker

Logs the top 50 Polymarket CRYPTO traders' bets on **BTC up/down 5m** markets, every 15 minutes.

Two ways it can run:

1. **Cloud (GitHub Actions)** — runs every 15 min on GitHub's infrastructure, even when your computer is off. Commits new trades to `data/btc-5m/YYYY-MM-DD.md` in this repo. **This is the default.**
2. **Local (Windows Task Scheduler)** — optional. Runs the same script on your machine and writes via the Obsidian Local REST API directly into your vault. Useful as a fallback or for instant refresh.

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
| `package.json` | Project metadata |
| `state.json` | Last seen timestamp + recent transaction hashes (committed by CI) |
| `data/btc-5m/YYYY-MM-DD.md` | Daily trade log (committed by CI) |
| `.github/workflows/scan.yml` | GitHub Actions cron — every 15 min |
| `run.bat.example` | Template for the local wrapper (copy to `run.bat` and fill in your API key) |

## Cloud mode (GitHub Actions)

Already configured. Runs automatically every 15 min — see the **Actions** tab on GitHub.

To trigger a one-off run: GitHub repo → Actions → "Polymarket BTC 5m scan" → Run workflow.

To pause: disable the workflow on the Actions tab.

## Local mode (manual or scheduled)

```powershell
cd C:\Users\Asus\Desktop\polymarket-tracker

# Dry run — no writes
node track.mjs --dry-run

# Local Obsidian write (requires run.bat with your API key)
.\run.bat

# Or run as the same script GitHub Actions uses (writes to ./data/)
$env:OUTPUT_MODE="file"; node track.mjs
```

### Windows scheduled task

Already registered as **`PolymarketTracker`** (every 15 min, runs `run.bat`). Manage with:

```powershell
Get-ScheduledTask -TaskName PolymarketTracker
Get-ScheduledTaskInfo -TaskName PolymarketTracker

Start-ScheduledTask -TaskName PolymarketTracker        # run now
Disable-ScheduledTask -TaskName PolymarketTracker      # pause
Enable-ScheduledTask -TaskName PolymarketTracker
Unregister-ScheduledTask -TaskName PolymarketTracker -Confirm:$false  # remove
```

If you're using cloud mode, you can disable the local task — it's redundant.

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
