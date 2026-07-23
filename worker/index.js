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

const path = require("path");
// Load env from worker/.env first (it wins), then fall back to the repo-root .env.local /
// .env so running from inside the repo "just works" with the app's existing config. Paths
// are resolved from __dirname, not the cwd, so it works from either `cd worker && node
// index.js` or `node worker/index.js`.
require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local"), override: false });
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), override: false });

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode"); // image (data-URL) generator, for the dashboard
const { createClient } = require("@supabase/supabase-js");

// The app defines the URL as NEXT_PUBLIC_SUPABASE_URL; accept that too.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const {
  SUPABASE_SERVICE_ROLE_KEY,
  WA_GROUP_ID = "",
  WA_STAFF_NUMBERS = "",
  POLL_MS = "5000",
  MAX_ATTEMPTS = "3",
  SESSION_PATH = "./.wwebjs_auth",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "✗ Missing Supabase config. Looked in worker/.env and the repo-root .env / .env.local.\n" +
      "  Need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY."
  );
  process.exit(1);
}

// Env destinations are now a FALLBACK. Per-business destinations set in the dashboard
// (the whatsapp_settings table) take precedence; env still covers any business with no
// row configured, so existing setups keep working.
const envGroupId = WA_GROUP_ID.trim();
const envStaffNumbers = WA_STAFF_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean);
const pollMs = Number(POLL_MS) || 5000;
const maxAttempts = Number(MAX_ATTEMPTS) || 3;

if (!envGroupId && envStaffNumbers.length === 0) {
  console.warn(
    "⚠ No WA_GROUP_ID / WA_STAFF_NUMBERS env fallback set. Fine IF every business has a\n" +
      "  destination configured on the dashboard's WhatsApp page; otherwise those messages\n" +
      "  have nowhere to go. Group ids are printed below once ready."
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

// --- Connection status → the dashboard ---
// Report the whatsapp-web.js state to the singleton `whatsapp_session` row so the
// WhatsApp page can show "scan this QR" / "connected" / offline. `updated_at` doubles as a
// heartbeat: the dashboard treats a stale row as the worker being offline. Wrapped so a DB
// hiccup never affects delivery.
const SESSION_ID = "default";
let sessionState = "initializing";
let sessionQr = null;
let sessionPhone = null;

async function writeSession() {
  try {
    await supabase.from("whatsapp_session").upsert(
      {
        id: SESSION_ID,
        status: sessionState,
        qr: sessionQr,
        phone: sessionPhone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  } catch (e) {
    console.warn("whatsapp_session write failed:", e.message);
  }
}

client.on("qr", async (qr) => {
  console.log("\nScan this QR with the SENDING WhatsApp account (a dedicated SIM is strongly recommended):\n");
  qrcode.generate(qr, { small: true }); // terminal fallback
  sessionState = "qr";
  sessionPhone = null;
  try {
    sessionQr = await QRCode.toDataURL(qr); // shown on the dashboard
  } catch {
    sessionQr = null;
  }
  await writeSession();
});
client.on("authenticated", () => {
  console.log("✓ authenticated");
  sessionState = "authenticated";
  sessionQr = null;
  writeSession();
});
client.on("auth_failure", (m) => {
  console.error("✗ auth failure:", m);
  sessionState = "auth_failure";
  sessionQr = null;
  writeSession();
});
client.on("disconnected", (r) => {
  console.warn("⚠ disconnected:", r, "— restart to re-pair if needed");
  sessionState = "disconnected";
  sessionQr = null;
  sessionPhone = null;
  writeSession();
});

client.on("ready", async () => {
  console.log("✓ WhatsApp client ready");
  sessionState = "connected";
  sessionQr = null;
  try {
    sessionPhone = client.info?.wid?.user || null;
  } catch {
    sessionPhone = null;
  }
  await writeSession();
  await logGroups();
  startPolling();
});

// Heartbeat: keep updated_at fresh so the dashboard can detect an offline worker.
setInterval(writeSession, 15_000);

// One-time helper: print every group this account is in with its id, so you can copy
// the reservation-team group's id into WA_GROUP_ID (a raw 1203...@g.us is unguessable).
async function logGroups() {
  try {
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (groups.length) {
      console.log("\nGroups this account is in — paste your reservation-team group's id into the\ndashboard's WhatsApp page (or WA_GROUP_ID as a fallback):");
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

// Per-business destination config from the dashboard, cached briefly so edits there
// propagate within a poll or two without a DB hit on every send.
const SETTINGS_TTL_MS = 30_000;
const settingsCache = new Map(); // business_id -> { at, group_id, staff_numbers }

async function destinationsFor(businessId) {
  const cached = settingsCache.get(businessId);
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached;
  let group_id = null;
  let staff_numbers = [];
  try {
    const { data } = await supabase
      .from("whatsapp_settings")
      .select("group_id, staff_numbers")
      .eq("business_id", businessId)
      .maybeSingle();
    if (data) {
      group_id = data.group_id || null;
      staff_numbers = Array.isArray(data.staff_numbers) ? data.staff_numbers : [];
    }
  } catch (e) {
    console.warn("whatsapp_settings lookup failed:", e.message);
  }
  const entry = { at: Date.now(), group_id, staff_numbers };
  settingsCache.set(businessId, entry);
  return entry;
}

// Resolve a row to whatsapp-web.js chat ids: DB config for the row's business wins, env
// is the fallback. The group id is used verbatim; each staff number is resolved via
// getNumberId (skips numbers not on WhatsApp instead of throwing).
async function resolveDestinations(row) {
  const cfg = await destinationsFor(row.business_id);
  const group = cfg.group_id || envGroupId;
  const numbers = cfg.staff_numbers.length ? cfg.staff_numbers : envStaffNumbers;

  const targets = [];
  if (group) targets.push(group);
  for (const num of numbers) {
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
  const targets = await resolveDestinations(row);
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
  console.log(
    `polling whatsapp_outbox every ${pollMs}ms (destinations per business from the dashboard; ` +
      `env fallback → group:${envGroupId ? "yes" : "no"}, numbers:${envStaffNumbers.length})`
  );
  tick();
  setInterval(tick, pollMs);
}

process.on("SIGINT", async () => {
  console.log("\nshutting down…");
  sessionState = "disconnected";
  sessionQr = null;
  try {
    await writeSession();
  } catch {
    /* ignore */
  }
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

// Seed the status row so the dashboard shows "connecting" before the first event fires.
writeSession();
client.initialize();
