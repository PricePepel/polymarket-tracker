// Position sizing under fractional Kelly with hard caps.
//
// Kelly fraction for a binary bet at price p, with estimated win probability w:
//   payout per $1 win = (1 - p) / p  (decimal odds b)
//   f* = (w * b - (1 - w)) / b
//   f_used = max(0, min(maxFractionPerTicket, kellyFraction * f*))
//
// We never recommend f* if it's negative — that means estimated edge is gone.

export const DEFAULTS = {
  kellyFraction: 0.25, // quarter Kelly — prudent default
  maxFractionPerTicket: 0.10, // 10% of bankroll cap (matches risk rules)
  maxOpenExposure: 0.30, // 30% of bankroll across all open tickets
  dailyStopLoss: -0.20, // halt if down 20% of starting bankroll today
  consecutiveLossLockout: 3, // 3 in a row → paper for next 10 scans
  paperLockoutScans: 10,
};

// Kelly fraction (raw). Caller is responsible for caps.
export function kellyFraction({ winProb, price }) {
  if (winProb <= 0 || winProb >= 1) return 0;
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price;
  const f = (winProb * b - (1 - winProb)) / b;
  return f;
}

// Compute the recommended USD size for a ticket given current bankroll
// and risk state.
export function sizeTicket({
  ticket,
  winProb,
  bankroll,
  openExposure, // sum of stake of current open tickets, in $
  cfg = {},
}) {
  if (ticket.side === "FLAT") return { sizeUsd: 0, reason: "flat" };
  const c = { ...DEFAULTS, ...cfg };
  const fStar = kellyFraction({ winProb, price: ticket.price });
  if (fStar <= 0) return { sizeUsd: 0, reason: "negative kelly", fStar, fUsed: 0 };

  let fUsed = c.kellyFraction * fStar;
  fUsed = Math.min(fUsed, c.maxFractionPerTicket);

  // Reduce if it would breach max open exposure
  const remainingExposureBudget = Math.max(
    0,
    c.maxOpenExposure - openExposure / Math.max(1e-9, bankroll)
  );
  fUsed = Math.min(fUsed, remainingExposureBudget);

  const sizeUsd = Math.max(0, Math.floor(bankroll * fUsed * 100) / 100);
  return { sizeUsd, fStar, fUsed };
}

// Decide whether risk state forces the system into paper mode.
export function riskCheck({ state, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  const reasons = [];
  if (state.halted) reasons.push("manually halted");
  const dailyPnlFrac =
    state.dailyStartBankroll > 0
      ? (state.bankroll - state.dailyStartBankroll) / state.dailyStartBankroll
      : 0;
  if (dailyPnlFrac <= c.dailyStopLoss)
    reasons.push(`daily stop hit (${(dailyPnlFrac * 100).toFixed(1)}%)`);
  if (state.consecutiveLosses >= c.consecutiveLossLockout)
    reasons.push(`${state.consecutiveLosses} consecutive losses → paper lockout`);
  if (state.paperRemainingScans > 0)
    reasons.push(`paper scans remaining: ${state.paperRemainingScans}`);
  if (state.mode === "PAPER")
    reasons.push("mode=PAPER");
  return { canGoLive: reasons.length === 0, reasons };
}
