#!/usr/bin/env node
// One-time helper. Hits getUpdates on your bot and prints the chat ids it
// has seen. Workflow:
//   1. Talk to @BotFather → /newbot → copy token
//   2. Open your bot in Telegram, send any message (e.g. "hi")
//   3. TELEGRAM_BOT_TOKEN=<token> node bin/setup-telegram.mjs
//   4. Copy the chat_id printed and store it in your .env

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN env var first.");
  console.error('  PowerShell:  $env:TELEGRAM_BOT_TOKEN="123:abc"; node bin/setup-telegram.mjs');
  console.error('  bash:        TELEGRAM_BOT_TOKEN="123:abc" node bin/setup-telegram.mjs');
  process.exit(2);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
if (!res.ok) {
  console.error(`getUpdates failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const data = await res.json();
if (!data.ok) {
  console.error("Telegram error:", data);
  process.exit(1);
}
if (data.result.length === 0) {
  console.log("No updates yet. Open your bot in Telegram and send any message,");
  console.log("then re-run this script.");
  process.exit(0);
}

const seen = new Map();
for (const u of data.result) {
  const m = u.message || u.edited_message || u.channel_post;
  if (!m) continue;
  const chat = m.chat;
  if (!seen.has(chat.id)) {
    seen.set(chat.id, {
      id: chat.id,
      type: chat.type,
      title: chat.title || `${chat.first_name || ""} ${chat.last_name || ""}`.trim() || chat.username || "(unknown)",
      lastText: m.text || "(non-text)",
    });
  }
}

console.log("Chats this bot has seen:");
for (const c of seen.values()) {
  console.log(`  chat_id=${c.id}  type=${c.type}  ${c.title}`);
  console.log(`    last message: ${c.lastText.slice(0, 60)}`);
}
console.log("");
console.log("Pick the chat_id you want to receive signals on, save it as TELEGRAM_CHAT_ID.");

// Also send a smoke-test message to the most recent chat
const latest = Array.from(seen.values()).pop();
if (latest) {
  const send = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: latest.id,
      text: "polymarket-signal: smoke test ✓",
    }),
  });
  if (send.ok) console.log(`Smoke-test message sent to chat ${latest.id}.`);
  else console.log(`Smoke-test send failed: ${send.status}`);
}
