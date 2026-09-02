import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/supabase-server";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { fetchConnectedAccount, refreshInstagramToken } from "@/lib/instagram";

// Refresh Instagram tokens before they expire (they last ~60 days).
//
// Run on a schedule (Vercel Cron / any external scheduler) with
//   Authorization: Bearer $CRON_SECRET
// A super_admin session is also accepted so it can be triggered by hand.
//
// Meta requires a token to be >24h old and still valid to refresh, so running
// this daily is the intended cadence — well inside the 60-day window.

const REFRESH_WITHIN_DAYS = 10;

function authorized(request: NextRequest, isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail CLOSED: no secret configured => no anonymous access
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser().catch(() => null);
  if (!authorized(request, user?.role === "super_admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Housekeeping, piggybacked on the daily run: drop audit rows older than a year.
  // Deliberately not on the 10-minute feedback cron — pruning year-old rows has no
  // business running 144 times a day. Best-effort: a failure here must not stop the
  // token refresh, which is the job that actually matters.
  const { error: pruneError } = await supabaseAdmin
    .from("audit_log")
    .delete()
    .lt("created_at", new Date(Date.now() - 365 * 86400_000).toISOString());
  if (pruneError) console.warn("audit_log prune failed:", pruneError.message);

  const cutoff = new Date(Date.now() + REFRESH_WITHIN_DAYS * 86400_000).toISOString();

  // Unknown expiry (null) counts as due — that's how accounts connected before
  // expiry tracking existed get picked up.
  const { data: accounts, error } = await supabaseAdmin
    .from("instagram_accounts")
    .select("id, username, access_token, token_expires_at, status")
    .neq("status", "disabled")
    .or(`token_expires_at.is.null,token_expires_at.lt.${cutoff}`);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: { account: string; ok: boolean; detail: string }[] = [];

  for (const account of accounts ?? []) {
    const label = account.username ? `@${account.username}` : account.id;
    try {
      const current = decryptSecret(account.access_token);
      const { access_token: fresh, expires_in } = await refreshInstagramToken(current);

      // Verify the NEW token actually works before persisting it. Storing an
      // unverified token would brick the account with no way back — the old one
      // is gone from our side the moment we overwrite it.
      await fetchConnectedAccount(fresh);

      const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
      const { error: saveError } = await supabaseAdmin
        .from("instagram_accounts")
        .update({ access_token: encryptSecret(fresh), token_expires_at: expiresAt })
        .eq("id", account.id);

      if (saveError) throw new Error(`Refreshed but failed to save: ${saveError.message}`);

      results.push({
        account: label,
        ok: true,
        detail: `renewed, expires ${expiresAt.slice(0, 10)} (${Math.round(expires_in / 86400)}d)`,
      });
    } catch (err) {
      // Leave the old token in place; a failure here is recoverable, an
      // overwrite with a broken token is not.
      console.error(`Token refresh failed for ${label}:`, (err as Error).message);
      results.push({ account: label, ok: false, detail: (err as Error).message });
    }
  }

  return Response.json({
    checked: accounts?.length ?? 0,
    refreshed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results, // never includes token material
  });
}
