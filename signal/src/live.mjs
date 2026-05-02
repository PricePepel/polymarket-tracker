// Live signal loop. Runs once per invocation; meant to be called every 5 min
// via cron, right after the polymarket-tracker scan has updated the .md file.
//
// Per call:
//   1. Load state.
//   2. Settle open tickets whose market has now resolved.
//   3. Identify the currently-open btc-updown-5m market.
//   4. Compute features at decision time = max(now, marketEndTs - decBuf).
//   5. Decide ticket; size it under fractional Kelly + risk caps.
//   6. Append a paper ticket entry to tickets/YYYY-MM-DD.md.
//   7. Persist state.
//
// "Live" trading is intentionally NOT implemented — the system never sends
// orders or signs transactions. It writes a recommendation; you click manually.

import fs from "node:fs";
import path from "node:path";
import { parseDir, groupByMarket } from "./parse.mjs";
import { featuresAtDecision } from "./features.mjs";
import { decideTicket, pnlPerDollar } from "./backtest.mjs";
import { sizeTicket, riskCheck, DEFAULTS } from "./sizing.mjs";
import { loadState, saveState, rollDayIfNeeded } from "./state.mjs";
import { fetchOutcome } from "./resolve.mjs";
import { notifyEmit, updateNotionStatus } from "./notify.mjs";

// Locked config from walk-forward validation (see cache/walkforward.json).
export const LOCKED_PARAMS = {
  thresh: 25,
  pMin: 0.5,
  pMax: 0.95,
  minLateTrades: 2,
  decisionBufferSec: 90,
  slippageCents: 2,
  feeBps: 100,
};

export const LOCKED_WIN_PROB = 0.882; // OOS hit rate from walk-forward

const TODAY_UTC = () => new Date().toISOString().slice(0, 10);

// Settle any open tickets whose markets have closed. Updates state in place.
export async function settleOpenTickets(state, outcomesCache, nowMs) {
  const stillOpen = [];
  for (const tk of state.openTickets) {
    if (tk.marketEndTs > nowMs - 30_000) {
      // not yet ended (give 30s buffer)
      stillOpen.push(tk);
      continue;
    }
    let outcome = outcomesCache[tk.slug]?.outcome;
    if (!outcome) {
      try {
        const r = await fetchOutcome(tk.slug);
        outcome = r.outcome;
        if (outcome) outcomesCache[tk.slug] = r;
      } catch {
        // fetch failed — leave open, retry next cycle
        stillOpen.push(tk);
        continue;
      }
    }
    if (!outcome) {
      stillOpen.push(tk);
      continue;
    }
    const pnlPerDollarVal = pnlPerDollar(
      { side: tk.side, price: tk.entryPrice },
      outcome,
      LOCKED_PARAMS.feeBps
    );
    const pnlUsd = pnlPerDollarVal * tk.sizeUsd;
    const won = pnlUsd > 0;
    if (state.mode === "PAPER" || tk.mode === "PAPER") {
      state.paperPnl += pnlUsd;
      if (won) state.paperWins++;
      else state.paperLosses++;
      state.bankroll += pnlUsd; // bankroll tracks paper too, so the user sees what would have happened
    } else {
      state.livePnl += pnlUsd;
      state.bankroll += pnlUsd;
    }
    state.consecutiveLosses = won ? 0 : state.consecutiveLosses + 1;
    state.closedTickets.push({
      ...tk,
      outcome,
      pnlUsd: Number(pnlUsd.toFixed(4)),
      won,
      settledAt: new Date(nowMs).toISOString(),
    });
    // Best-effort settle-update in Notion. Never throws.
    if (tk.notionPageId) {
      try {
        await updateNotionStatus({
          pageId: tk.notionPageId,
          outcome,
          won,
          pnlUsd,
        });
      } catch {
        /* ignore */
      }
    }
  }
  state.openTickets = stillOpen;
  return state;
}

// Find the currently-open market: the latest slug present in trade data
// whose marketEndTs is in the future.
export function findOpenMarket(markets, nowMs) {
  // Open market = any whose marketEndTs > now and tradeStart <= now
  const candidates = markets.filter(
    (m) => m.marketEndTs > nowMs && m.marketStartTs <= nowMs
  );
  if (candidates.length === 0) return null;
  // Prefer the one closest to ending (most signal-rich)
  candidates.sort((a, b) => a.marketEndTs - b.marketEndTs);
  return candidates[0];
}

// Recovery for cron drift: cron-job.org + GitHub Actions queueing means we
// often don't fire inside any given market's 90s decision window. For each
// market that closed within the last RETRO_LOOKBACK_MS but never got a ticket
// (or a "we looked, said FLAT" record), compute features at the market's
// calibrated decision moment and emit a retroactive PAPER ticket if criteria
// fire. Always paper-only — we can't actually place a bet on a closed market.
const RETRO_LOOKBACK_MS = 10 * 60 * 1000; // 10 min covers up to 2 missed cron cycles
const EVALUATED_SLUGS_CAP = 200;

export function evaluateRecentlyClosed({ state, markets, nowMs }) {
  const known = new Set([
    ...(state.closedTickets || []).map((t) => t.slug),
    ...(state.openTickets || []).map((t) => t.slug),
    ...(state.evaluatedSlugs || []),
  ]);

  // Closed within lookback, not already known. Sort oldest first so log order
  // matches market chronology.
  const candidates = markets
    .filter(
      (m) =>
        m.marketEndTs <= nowMs &&
        m.marketEndTs > nowMs - RETRO_LOOKBACK_MS &&
        !known.has(m.slug)
    )
    .sort((a, b) => a.marketEndTs - b.marketEndTs);

  const retroTickets = [];

  for (const m of candidates) {
    const decisionTs = m.marketEndTs - LOCKED_PARAMS.decisionBufferSec * 1000;
    const f = featuresAtDecision({
      trades: m.trades,
      marketStartTs: m.marketStartTs,
      marketEndTs: m.marketEndTs,
      decisionTs,
    });
    const t = decideTicket(f, LOCKED_PARAMS);

    // Mark as evaluated either way so we never re-process this slug.
    state.evaluatedSlugs = [...(state.evaluatedSlugs || []), m.slug];
    if (state.evaluatedSlugs.length > EVALUATED_SLUGS_CAP) {
      state.evaluatedSlugs = state.evaluatedSlugs.slice(-EVALUATED_SLUGS_CAP);
    }

    if (t.side === "FLAT") continue;

    const openExposure = state.openTickets.reduce(
      (s, tk) => s + (tk.sizeUsd || 0),
      0
    );
    const sizing = sizeTicket({
      ticket: t,
      winProb: LOCKED_WIN_PROB,
      bankroll: state.bankroll,
      openExposure,
    });
    if (sizing.sizeUsd <= 0) continue;

    const ticket = {
      // Use the decision moment as the emit time so the chronology in the log
      // reflects when the bet *would* have been placed, not when we discovered it.
      emittedAt: new Date(decisionTs).toISOString(),
      retroactive: true,
      discoveredAt: new Date(nowMs).toISOString(),
      slug: m.slug,
      marketStartTs: m.marketStartTs,
      marketEndTs: m.marketEndTs,
      side: t.side,
      entryPrice: t.price,
      observedPrice: t.observedPrice,
      sizeUsd: sizing.sizeUsd,
      winProb: LOCKED_WIN_PROB,
      kellyFStar: sizing.fStar,
      kellyFUsed: sizing.fUsed,
      // Always PAPER — you cannot place a bet on a market that has closed.
      mode: "PAPER",
      riskNotes: ["retroactive (cron drift recovery)"],
      netYesUsdLate: f.netYesUsdLate,
      nTradesLate: f.nTradesLate,
      hhi: f.hhiAll,
    };
    state.openTickets.push(ticket);
    retroTickets.push(ticket);
  }

  return retroTickets;
}

// Generate one tick — returns {state, ticketLine} where ticketLine is the
// markdown line to append to today's tickets file (or null if FLAT).
export async function tick({
  dataDir,
  outcomesPath,
  ticketsDir,
  statePath,
  nowMs = Date.now(),
}) {
  const state = loadState(statePath);
  rollDayIfNeeded(state, nowMs);

  // Load outcomes cache for settlement
  let outcomesCache = {};
  if (fs.existsSync(outcomesPath)) {
    try {
      outcomesCache = JSON.parse(fs.readFileSync(outcomesPath, "utf8"));
    } catch {
      outcomesCache = {};
    }
  }

  await settleOpenTickets(state, outcomesCache, nowMs);

  // Decrement paper-lockout counter
  if (state.consecutiveLosses >= DEFAULTS.consecutiveLossLockout && state.paperRemainingScans === 0) {
    state.paperRemainingScans = DEFAULTS.paperLockoutScans;
  }
  if (state.paperRemainingScans > 0) state.paperRemainingScans--;
  state.paperScanCount++;

  const { trades } = parseDir(dataDir);
  const markets = groupByMarket(trades);
  const open = findOpenMarket(markets, nowMs);

  let ticketLine = null;
  let summary;
  if (!open) {
    summary = {
      verdict: "NO_OPEN_MARKET",
      reason: "no btc-updown-5m market currently active in scan data",
    };
  } else if (state.openTickets.some((tk) => tk.slug === open.slug)) {
    summary = {
      verdict: "ALREADY_TICKETED",
      slug: open.slug,
      reason: "this market already has an open ticket",
    };
  } else {
    // Calibrated decision time: T - decisionBufferSec.
    const calibratedDecisionTs =
      open.marketEndTs - LOCKED_PARAMS.decisionBufferSec * 1000;
    // Refuse to emit before the calibrated moment — features computed earlier
    // would correspond to a different (uncalibrated) part of the market and
    // hit-rate would not match walk-forward expectations.
    const TOO_EARLY_TOLERANCE_MS = 5_000; // allow 5s of clock skew
    if (nowMs < calibratedDecisionTs - TOO_EARLY_TOLERANCE_MS) {
      summary = {
        verdict: "TOO_EARLY",
        slug: open.slug,
        reason: `decision moment in ${Math.round((calibratedDecisionTs - nowMs) / 1000)}s`,
      };
      saveState(statePath, state);
      return { state, summary, ticketLine: null };
    }
    const decisionTs = Math.min(calibratedDecisionTs, nowMs);
    const f = featuresAtDecision({
      trades: open.trades,
      marketStartTs: open.marketStartTs,
      marketEndTs: open.marketEndTs,
      decisionTs,
    });
    const t = decideTicket(f, LOCKED_PARAMS);
    const risk = riskCheck({ state });
    if (t.side === "FLAT") {
      summary = {
        verdict: "FLAT",
        slug: open.slug,
        reason: t.reason,
        features: f,
      };
    } else {
      const openExposure = state.openTickets.reduce(
        (s, tk) => s + (tk.sizeUsd || 0),
        0
      );
      const sizing = sizeTicket({
        ticket: t,
        winProb: LOCKED_WIN_PROB,
        bankroll: state.bankroll,
        openExposure,
      });
      const sizeUsd = sizing.sizeUsd;
      const mode = risk.canGoLive ? state.mode : "PAPER";
      const ticket = {
        emittedAt: new Date(nowMs).toISOString(),
        slug: open.slug,
        marketStartTs: open.marketStartTs,
        marketEndTs: open.marketEndTs,
        side: t.side,
        entryPrice: t.price,
        observedPrice: t.observedPrice,
        sizeUsd,
        winProb: LOCKED_WIN_PROB,
        kellyFStar: sizing.fStar,
        kellyFUsed: sizing.fUsed,
        mode,
        riskNotes: risk.reasons,
        netYesUsdLate: f.netYesUsdLate,
        nTradesLate: f.nTradesLate,
        hhi: f.hhiAll,
      };
      if (sizeUsd > 0) {
        // Push to notification channels and capture the Notion page id so
        // we can update its status when the ticket settles.
        try {
          const notifyResult = await notifyEmit(ticket);
          if (notifyResult.notion?.pageId) {
            ticket.notionPageId = notifyResult.notion.pageId;
          }
          ticket.notifyResult = {
            telegram: !!notifyResult.telegram?.ok,
            notion: !!notifyResult.notion?.ok,
          };
        } catch {
          /* never block emission on notify failure */
        }
        state.openTickets.push(ticket);
      }
      summary = { verdict: ticket.side, ticket };
      ticketLine = formatTicketLine(ticket);
    }
  }

  // Append to tickets log
  if (ticketLine) {
    const today = TODAY_UTC();
    const filePath = path.join(ticketsDir, `${today}.md`);
    fs.mkdirSync(ticketsDir, { recursive: true });
    fs.appendFileSync(filePath, ticketLine + "\n");
  }

  // Cron-drift recovery: catch any market that closed in the lookback window
  // but never got a ticket. These get added to openTickets as PAPER and then
  // settled in the same pass (their outcomes are already known).
  const retroTickets = evaluateRecentlyClosed({ state, markets, nowMs });
  if (retroTickets.length > 0) {
    // Append retro lines to today's tickets file.
    const today = TODAY_UTC();
    const filePath = path.join(ticketsDir, `${today}.md`);
    fs.mkdirSync(ticketsDir, { recursive: true });
    for (const t of retroTickets) {
      fs.appendFileSync(filePath, formatTicketLine(t) + "\n");
    }
    // Settle them in this same tick — their markets are already past close.
    await settleOpenTickets(state, outcomesCache, nowMs);
  }

  // Persist outcomes cache (settle may have fetched new outcomes).
  fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
  fs.writeFileSync(outcomesPath, JSON.stringify(outcomesCache, null, 2));

  saveState(statePath, state);

  return { state, summary, ticketLine, retroTickets };
}

function formatTicketLine(t) {
  const ts = t.emittedAt;
  const close = new Date(t.marketEndTs).toISOString().slice(11, 19) + "Z";
  const thesis = `late top-50 net ${t.netYesUsdLate >= 0 ? "+" : ""}$${t.netYesUsdLate.toFixed(0)} (${t.nTradesLate} trades, HHI ${t.hhi.toFixed(2)})`;
  const tag = t.retroactive
    ? "**PAPER·RETRO**"
    : t.mode === "PAPER"
      ? "**PAPER**"
      : t.sizeUsd > 0
        ? "LIVE"
        : "**FLAT**";
  return `- \`${ts}\` ${tag} **${t.side}** \`${t.slug}\` close=${close} entry=$${t.entryPrice.toFixed(3)} size=$${t.sizeUsd.toFixed(2)} kelly_f*=${t.kellyFStar.toFixed(3)} f_used=${t.kellyFUsed.toFixed(3)} — ${thesis}`;
}
