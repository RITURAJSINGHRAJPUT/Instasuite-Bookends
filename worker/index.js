// Instasuite WhatsApp worker.
//
// The web app (Instagram webhook) detects a captured takeaway order or a shared
// TableCheck reservation link and inserts a row into the `whatsapp_outbox` Supabase
// table. This process polls that table and delivers each confirmation over
// whatsapp-web.js to the reservation-team WhatsApp GROUP and/or staff numbers.
//
// Why it runs here and not on Render: whatsapp-web.js drives a headless Chrome via
// Puppeteer, which Render's Node runtime can't launch without a Docker image. On a
// normal machine (your PC, a Raspberry Pi, a small VPS) Chrome runs natively — no
// Docker. This process makes only OUTBOUND connections (Supabase + WhatsApp), so it
// needs no public URL and works behind NAT.
//
// ⚠ whatsapp-web.js is unofficial and against WhatsApp's ToS — use a DEDICATED SIM,
// not the restaurant's public number. See README.md.

require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WA_GROUP_ID = "",
  WA_STAFF_NUMBERS = "",
  POLL_MS = "5000",
  MAX_ATTEMPTS = "3",
  SESSION_PATH = "./.wwebjs_auth",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const groupId = WA_GROUP_ID.trim();
const staffNumbers = WA_STAFF_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean);
const pollMs = Number(POLL_MS) || 5000;
const maxAttempts = Number(MAX_ATTEMPTS) || 3;

if (!groupId && staffNumbers.length === 0) {
  console.warn(
    "⚠ Neither WA_GROUP_ID nor WA_STAFF_NUMBERS is set — messages will have nowhere to go.\n" +
      "  Set WA_GROUP_ID (printed below once ready) and/or WA_STAFF_NUMBERS, then restart."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    // --no-sandbox is required when running as root (common on a VPS/Pi).
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

client.on("qr", (qr) => {
  console.log("\nScan this QR with the SENDING WhatsApp account (a dedicated SIM is strongly recommended):\n");
  qrcode.generate(qr, { small: true });
});
client.on("authenticated", () => console.log("✓ authenticated"));
client.on("auth_failure", (m) => console.error("✗ auth failure:", m));
client.on("disconnected", (r) => console.warn("⚠ disconnected:", r, "— restart to re-pair if needed"));

client.on("ready", async () => {
  console.log("✓ WhatsApp client ready");
  await logGroups();
  startPolling();
});

// One-time helper: print every group this account is in with its id, so you can copy
// the reservation-team group's id into WA_GROUP_ID (a raw 1203...@g.us is unguessable).
async function logGroups() {
  try {
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (groups.length) {
      console.log("\nGroups this account is in — copy your reservation-team group's id into WA_GROUP_ID:");
      for (const g of groups) console.log(`  ${g.id._serialized}  —  ${g.name}`);
      console.log("");
    } else {
      console.log("(this account is in no groups yet — add it to the reservation-team group, then restart)");
    }
  } catch (e) {
    console.warn("could not list groups:", e.message);
  }
}

function formatMessage(row) {
  const header =
    row.kind === "takeaway"
      ? `🧾 New takeaway order — @${row.account_username || "account"}`
      : `📅 Reservation link shared — @${row.account_username || "account"}`;
  return `${header}\nGuest: ${row.customer_name || "Guest"}\n\n${row.body}`;
}

// Resolve the configured destinations to whatsapp-web.js chat ids each send: the group
// id verbatim, and each staff number resolved via getNumberId (skips numbers not on
// WhatsApp instead of throwing).
async function resolveDestinations() {
  const targets = [];
  if (groupId) targets.push(groupId);
  for (const num of staffNumbers) {
    try {
      const id = await client.getNumberId(num);
      if (id) targets.push(id._serialized);
      else console.warn(`  number not on WhatsApp, skipping: ${num}`);
    } catch (e) {
      console.warn(`  getNumberId failed for ${num}:`, e.message);
    }
  }
  return targets;
}

async function deliver(row) {
  const text = formatMessage(row);
  const targets = await resolveDestinations();
  if (targets.length === 0) throw new Error("no reachable destinations configured");
  for (const chatId of targets) {
    await client.sendMessage(chatId, text);
    // Gentle pacing + jitter between recipients (crude ban-avoidance).
    await sleep(600 + Math.floor(Math.random() * 700));
  }
}

let ticking = false;

async function tick() {
  if (ticking) return; // never let two polls overlap
  ticking = true;
  try {
    const { data, error } = await supabase
      .from("whatsapp_outbox")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(10);
    if (error) {
      console.warn("poll query failed:", error.message);
      return;
    }
    for (const row of data || []) {
      try {
        await deliver(row);
        await supabase
          .from("whatsapp_outbox")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
        console.log(`✓ sent ${row.kind} ${row.id}`);
      } catch (e) {
        const attempts = (row.attempts || 0) + 1;
        // Stay 'pending' to retry on the next tick until we exhaust MAX_ATTEMPTS.
        const status = attempts >= maxAttempts ? "failed" : "pending";
        await supabase
          .from("whatsapp_outbox")
          .update({ attempts, last_error: String(e.message).slice(0, 500), status })
          .eq("id", row.id);
        console.warn(`✗ ${row.kind} ${row.id} attempt ${attempts}/${maxAttempts}: ${e.message}`);
      }
    }
  } finally {
    ticking = false;
  }
}

function startPolling() {
  console.log(`polling whatsapp_outbox every ${pollMs}ms → group:${groupId ? "yes" : "no"}, numbers:${staffNumbers.length}`);
  tick();
  setInterval(tick, pollMs);
}

process.on("SIGINT", async () => {
  console.log("\nshutting down…");
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

client.initialize();
