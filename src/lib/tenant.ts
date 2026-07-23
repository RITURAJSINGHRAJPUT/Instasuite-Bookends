import { supabaseAdmin } from "@/lib/supabase";
import { decryptSecret } from "@/lib/crypto";
import { getUnavailableBlock } from "@/lib/availability";

// Resolves an inbound webhook to the tenant that owns it.
// Server-only: it decrypts an access token, which must never reach the browser.

export type ResolvedAccount = {
  accountId: string;
  businessId: string;
  clientId: string;
  igAccountId: string;
  username: string | null;
  /** Decrypted — never return this to a client response. */
  accessToken: string;
  /** instagram_accounts.script_id ?? businesses.default_script_id */
  systemPrompt: string;
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
      "id, business_id, ig_account_id, username, access_token, status, script_id, businesses(id, client_id, status, default_script_id)"
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

  // Append the business's currently-86'd items so the agent stops offering them.
  // getUnavailableBlock returns "" on empty or any error, so this never breaks a reply
  // and appends AFTER the menu (the block states it overrides the menu above it).
  const unavailable = await getUnavailableBlock(data.business_id);

  return {
    accountId: data.id,
    businessId: data.business_id,
    clientId: business.client_id,
    igAccountId: data.ig_account_id,
    username: data.username,
    accessToken: decryptSecret(data.access_token),
    systemPrompt: unavailable ? `${script.content}\n\n${unavailable}` : script.content,
  };
}
