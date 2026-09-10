import { supabaseAdmin } from "@/lib/supabase";
import { decryptSecret } from "@/lib/crypto";
import { getUnavailableBlock } from "@/lib/availability";

// Resolves an inbound webhook to the tenant that owns it.
// Server-only: it decrypts an access token, which must never reach the browser.

export type ResolvedAccount = {
  accountId: string;
  businessId: string;
  businessName: string;
  clientId: string;
  igAccountId: string;
  username: string | null;
  /** Decrypted — never return this to a client response. */
  accessToken: string;
  /** instagram_accounts.script_id ?? businesses.default_script_id */
  systemPrompt: string;
  /**
   * Does this brand take takeaway at all? Beshak is dine-in reservations only. The webhook
   * refuses to capture a takeaway order when this is false — the script states the rule,
   * this is what makes it true.
   */
  takeawayEnabled: boolean;
};

type AccountRow = {
  id: string;
  business_id: string;
  ig_account_id: string;
  username: string | null;
  access_token: string;
  status: string;
  script_id: string | null;
  businesses: {
    id: string;
    name: string;
    client_id: string;
    status: string;
    default_script_id: string | null;
  } | null;
};

/**
 * Look up the tenant for a webhook's `entry[0].id` (the destination Instagram
 * business account). Returns null when the account is unknown, not approved, or
 * its business isn't approved — the caller must then ignore the event rather
 * than fall back to any other tenant.
 */
export async function resolveAccountByIgId(
  igAccountId: string
): Promise<ResolvedAccount | null> {
  const { data, error } = await supabaseAdmin
    .from("instagram_accounts")
    .select(
      "id, business_id, ig_account_id, username, access_token, status, script_id, businesses(id, name, client_id, status, default_script_id)"
    )
    .eq("ig_account_id", igAccountId)
    .maybeSingle<AccountRow>();

  if (error || !data) {
    console.warn(`Webhook for unknown Instagram account ${igAccountId} — ignoring.`);
    return null;
  }

  const business = data.businesses;
  if (data.status !== "approved" || business?.status !== "approved") {
    console.warn(
      `Webhook for ${igAccountId}: account=${data.status}, business=${business?.status} — not approved, ignoring.`
    );
    return null;
  }

  // Script resolution: the account's own script wins; otherwise inherit the
  // business default. This is what gives "one script for all accounts" and
  // "individual script per account" from the same schema.
  const scriptId = data.script_id ?? business.default_script_id;
  if (!scriptId) {
    console.warn(`Webhook for ${igAccountId}: no script configured — ignoring.`);
    return null;
  }

  const { data: script } = await supabaseAdmin
    .from("scripts")
    .select("content")
    .eq("id", scriptId)
    .maybeSingle<{ content: string }>();

  if (!script?.content) {
    console.warn(`Webhook for ${igAccountId}: script ${scriptId} missing — ignoring.`);
    return null;
  }

  // A token that won't decrypt (wrong/rotated TOKEN_ENCRYPTION_KEY, a legacy plaintext row,
  // a truncated payload) must resolve to "no account", NOT an exception. Every caller already
  // handles null correctly — the webhook ignores the event, the send route returns its 502 —
  // whereas a throw escaped as a generic "Webhook processing error" or an unhandled 500.
  let accessToken: string;
  try {
    accessToken = decryptSecret(data.access_token);
  } catch (err) {
    console.error(
      `Webhook for ${igAccountId}: access token failed to decrypt (${(err as Error).message}) — ignoring. Reconnect this account.`
    );
    return null;
  }

  // Append the business's currently-86'd items so the agent stops offering them.
  // getUnavailableBlock returns "" on empty or any error, so this never breaks a reply
  // and appends AFTER the menu (the block states it overrides the menu above it).
  //
  // takeaway_enabled is read HERE rather than joined into the query above, deliberately.
  // That query is the critical path for every inbound message: if the column were in its
  // select and the code shipped before migration 0027, PostgREST would 400 on it, this
  // function would return null, and EVERY account would go silent. On its own side path it
  // degrades to "takeaway allowed" instead — the pre-migration status quo. Runs in parallel,
  // so it costs no extra latency.
  const [unavailable, takeawayEnabled] = await Promise.all([
    getUnavailableBlock(data.business_id),
    getTakeawayEnabled(data.business_id),
  ]);

  const dineInOnly = takeawayEnabled ? "" : DINE_IN_ONLY_BLOCK;
  const prompt = [script.content, unavailable, dineInOnly].filter(Boolean).join("\n\n");

  return {
    accountId: data.id,
    businessId: data.business_id,
    businessName: business.name,
    clientId: business.client_id,
    igAccountId: data.ig_account_id,
    username: data.username,
    accessToken,
    systemPrompt: prompt,
    takeawayEnabled,
  };
}

// Stated positively and last, so it outranks anything earlier in the script that talks about
// pickups. The webhook enforces this independently — the model is told, not trusted.
const DINE_IN_ONLY_BLOCK = [
  "## Dine-in only (overrides everything above)",
  "This brand takes DINE-IN TABLE RESERVATIONS ONLY. It does not do takeaway, pickup, delivery or parcels — not now, not later today, not by arrangement.",
  "Never offer one, never ask whether the guest wants one, and never note, accept or confirm one. Never emit a TAKEAWAY hand-off line.",
  "If a guest asks for takeaway or delivery, say warmly that we're dine-in only at the moment and offer to book them a table instead.",
].join("\n");

/**
 * Whether this business takes takeaway. Defaults to TRUE on any error — including the
 * column not existing yet — because that is the behaviour every brand had before the flag,
 * and a lookup failure must never silently stop a working brand from taking orders.
 */
async function getTakeawayEnabled(businessId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("businesses")
      .select("takeaway_enabled")
      .eq("id", businessId)
      .maybeSingle<{ takeaway_enabled: boolean | null }>();
    if (error) {
      console.warn(`takeaway_enabled unreadable (${error.message}) — assuming takeaway is on.`);
      return true;
    }
    return data?.takeaway_enabled ?? true;
  } catch (err) {
    console.warn(`takeaway_enabled threw (${(err as Error).message}) — assuming takeaway is on.`);
    return true;
  }
}
