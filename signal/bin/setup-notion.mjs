#!/usr/bin/env node
// One-time helper. Creates a "Polymarket Tickets" database under a parent
// page that's been shared with your integration.
//
// Setup steps before running:
//   1. https://www.notion.so/profile/integrations  → New integration
//      Name it "Polymarket Signal", workspace = your workspace, save the
//      "Internal Integration Secret" (starts with "secret_" or "ntn_").
//   2. In Notion, pick or create a parent page (e.g. "Polymarket"). Click "..."
//      at top right → "Connections" → add "Polymarket Signal".
//   3. Copy the parent page URL (it has the page id at the end).
//   4. Run:
//        $env:NOTION_TOKEN="ntn_..."; $env:NOTION_PARENT_PAGE_URL="https://notion.so/...";
//        node bin/setup-notion.mjs
//   5. Save the printed NOTION_DATABASE_ID to your .env.

const token = process.env.NOTION_TOKEN;
const parentUrl = process.env.NOTION_PARENT_PAGE_URL;
if (!token || !parentUrl) {
  console.error("Required: NOTION_TOKEN and NOTION_PARENT_PAGE_URL env vars.");
  process.exit(2);
}

// Extract the parent page id from the URL. Notion URLs end with a 32-char
// hex (with or without dashes) after the last dash or slash.
function extractPageId(url) {
  const m = url.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
  if (!m) return null;
  let id = m[1].replace(/-/g, "");
  if (id.length !== 32) return null;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

const parentId = extractPageId(parentUrl);
if (!parentId) {
  console.error(`Could not extract page id from URL: ${parentUrl}`);
  process.exit(2);
}
console.log(`parent page id: ${parentId}`);

const NOTION_VERSION = "2022-06-28";

const dbBody = {
  parent: { type: "page_id", page_id: parentId },
  title: [{ type: "text", text: { content: "Polymarket Tickets" } }],
  properties: {
    Name:           { title: {} },
    Side:           { select: { options: [
      { name: "YES",  color: "green" },
      { name: "NO",   color: "red" },
    ]}},
    Mode:           { select: { options: [
      { name: "PAPER", color: "gray" },
      { name: "LIVE",  color: "yellow" },
    ]}},
    Status:         { select: { options: [
      { name: "Open",  color: "blue" },
      { name: "Won",   color: "green" },
      { name: "Lost",  color: "red" },
    ]}},
    Outcome:        { select: { options: [
      { name: "UP",   color: "green" },
      { name: "DOWN", color: "red" },
    ]}},
    "Entry price":  { number: { format: "dollar" } },
    "Size USD":     { number: { format: "dollar" } },
    "PnL USD":      { number: { format: "dollar" } },
    "Net flow USD": { number: { format: "dollar" } },
    HHI:            { number: { format: "number" } },
    Slug:           { rich_text: {} },
    Link:           { url: {} },
    "Emitted at":   { date: {} },
    "Closes at":    { date: {} },
  },
};

const res = await fetch("https://api.notion.com/v1/databases", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(dbBody),
});

if (!res.ok) {
  const t = await res.text().catch(() => "");
  console.error(`Notion API error ${res.status}: ${t.slice(0, 500)}`);
  console.error("");
  console.error("Common causes:");
  console.error("  - parent page not shared with the integration (do step 2)");
  console.error("  - token is wrong or revoked");
  process.exit(1);
}

const db = await res.json();
console.log("");
console.log("✓ database created");
console.log(`  title:  ${db.title?.[0]?.plain_text || "Polymarket Tickets"}`);
console.log(`  url:    ${db.url}`);
console.log(`  id:     ${db.id}`);
console.log("");
console.log("Save this in your .env:");
console.log(`  NOTION_DATABASE_ID=${db.id}`);
