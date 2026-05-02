// Notification dispatchers. Each is opt-in via env. Failures are logged but
// never throw — a notification problem must NEVER block the trading signal.
//
// TELEGRAM (recommended for the 90s decision window):
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — your numeric chat id (use bin/setup-telegram.mjs)
//
// NOTION (recommended as a searchable history log, not for time-critical):
//   NOTION_TOKEN        — internal integration secret (notion.so/profile/integrations)
//   NOTION_DATABASE_ID  — id of the "Polymarket Tickets" DB (bin/setup-notion.mjs)

const NOTION_VERSION = "2022-06-28";

function polymarketUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

// ─── Telegram ────────────────────────────────────────────────────────────

export async function pushToTelegram(ticket) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { skipped: "no telegram env" };

  const closeStr = new Date(ticket.marketEndTs).toISOString().slice(11, 19) + "Z";
  const tag = ticket.mode === "PAPER" ? "📝 PAPER" : "💸 LIVE";
  const arrow = ticket.side === "YES" ? "🟢 UP" : "🔴 DOWN";

  // HTML mode for bold + clickable URL via inline keyboard
  const text = [
    `${tag}  ${arrow}`,
    `<b>${ticket.side}</b>  size <b>$${ticket.sizeUsd.toFixed(2)}</b>  @ $${ticket.entryPrice.toFixed(3)}`,
    `closes in ~90s (${closeStr})`,
    `flow: $${ticket.netYesUsdLate.toFixed(0)} (${ticket.nTradesLate} trades, HHI ${ticket.hhi.toFixed(2)})`,
  ].join("\n");

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "Open Polymarket", url: polymarketUrl(ticket.slug) }],
      ],
    },
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `telegram ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { error: `telegram fetch: ${err.message}` };
  }
}

// ─── Notion ──────────────────────────────────────────────────────────────

export async function pushToNotion(ticket) {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!token || !dbId) return { skipped: "no notion env" };

  const properties = {
    Name: {
      title: [
        {
          text: {
            content: `${ticket.side} ${ticket.slug.split("-").pop()}`,
          },
        },
      ],
    },
    Side: { select: { name: ticket.side } },
    Mode: { select: { name: ticket.mode } },
    "Entry price": { number: Number(ticket.entryPrice.toFixed(4)) },
    "Size USD": { number: Number(ticket.sizeUsd.toFixed(2)) },
    "Net flow USD": { number: Number(ticket.netYesUsdLate.toFixed(2)) },
    "HHI": { number: Number(ticket.hhi.toFixed(3)) },
    Slug: { rich_text: [{ text: { content: ticket.slug } }] },
    Link: { url: polymarketUrl(ticket.slug) },
    "Emitted at": { date: { start: ticket.emittedAt } },
    "Closes at": { date: { start: new Date(ticket.marketEndTs).toISOString() } },
    Status: { select: { name: "Open" } },
  };

  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `notion ${res.status}: ${t.slice(0, 200)}` };
    }
    const data = await res.json();
    return { ok: true, pageId: data.id };
  } catch (err) {
    return { error: `notion fetch: ${err.message}` };
  }
}

// Also update the Notion row when a ticket is settled.
export async function updateNotionStatus({ pageId, outcome, won, pnlUsd }) {
  const token = process.env.NOTION_TOKEN;
  if (!token || !pageId) return { skipped: "no notion env or pageId" };
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          Status: { select: { name: won ? "Won" : "Lost" } },
          Outcome: { select: { name: outcome } },
          "PnL USD": { number: Number(pnlUsd.toFixed(2)) },
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `notion patch ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { error: `notion patch fetch: ${err.message}` };
  }
}

// Fan-out: call all configured notifiers in parallel; return aggregated status.
export async function notifyEmit(ticket) {
  const [tg, nt] = await Promise.all([
    pushToTelegram(ticket),
    pushToNotion(ticket),
  ]);
  return { telegram: tg, notion: nt };
}
