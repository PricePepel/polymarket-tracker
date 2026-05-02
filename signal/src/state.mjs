// Bankroll + risk state, persisted to disk.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_STATE = {
  bankroll: 20.0, // current bankroll in USDC, paper or live
  startingBankroll: 20.0,
  mode: "PAPER", // "PAPER" | "LIVE"
  consecutiveLosses: 0,
  paperRemainingScans: 50, // starts at 50, must hit 0 with positive expectancy before going live
  paperScanCount: 0,
  paperWins: 0,
  paperLosses: 0,
  paperPnl: 0,
  livePnl: 0,
  openTickets: [], // tickets emitted but whose market hasn't resolved yet
  closedTickets: [], // resolved tickets, append-only history
  dailyStartBankroll: 20.0,
  dailyDate: null, // YYYY-MM-DD
  halted: false,
};

export function loadState(filePath) {
  if (!fs.existsSync(filePath)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

// Reset daily counters when the UTC day rolls over.
export function rollDayIfNeeded(state, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyStartBankroll = state.bankroll;
  }
  return state;
}
