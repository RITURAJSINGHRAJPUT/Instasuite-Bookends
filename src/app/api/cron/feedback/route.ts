import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendInstagramMessage } from "@/lib/instagram";
import { feedbackSendAt, feedbackMessage } from "@/lib/feedback";

// Post-dining feedback DMs. Sends the thank-you to CONFIRMED reservations whose send time (reservation
// + 2h, capped at 11:55pm IST — see src/lib/feedback.ts) has passed. Best-effort: each row is attempted
// once and stamped `feedback_sent_at` so it never re-sends. Instagram rejects DMs outside the guest's
// 24h window, and sendInstagramMessage RETURNS that error rather than throwing — a permanent no-send, so
// we still stamp it done. A transient network throw is NOT stamped, so it retries next run.
//
// Schedule every ~10-15 min with `Authorization: Bearer $CRON_SECRET` (a super_admin session is also
// accepted, for manual runs). Mirrors /api/cron/refresh-tokens; /api/cron/* bypasses the proxy matcher.

function authorized(request: NextRequest, isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail CLOSED: no secret configured => no anonymous access
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

type Row = {
  id: string;
  scheduled_at: string;
  conversation_id: string | null;
  igsid: string | null;
  instagram_account_id: string | null;
  businesses: { public_handle: string | null } | { public_handle: string | null }[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? v[0] ?? null : v;
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser().catch(() => null);
  if (!authorized(request, user?.role === "super_admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const now = Date.now();
  // Only look at recent bookings so the first run doesn't backfill weeks of history.
  const since = new Date(now - 12 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id, scheduled_at, conversation_id, igsid, instagram_account_id, businesses(public_handle)"
    )
    .eq("kind", "reservation")
    .eq("status", "confirmed")
    .is("feedback_sent_at", null)
    .not("scheduled_at", "is", null)
    .gte("scheduled_at", since);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: { order: string; ok: boolean; detail: string }[] = [];

  for (const row of (data ?? []) as unknown as Row[]) {
    if (now < feedbackSendAt(row.scheduled_at).getTime()) continue; // not due yet

    try {
      if (!row.igsid || !row.instagram_account_id) {
        results.push({ order: row.id, ok: false, detail: "no recipient snapshot" });
        continue;
      }

      const { data: acc } = await supabaseAdmin
        .from("instagram_accounts")
        .select("ig_account_id")
        .eq("id", row.instagram_account_id)
        .maybeSingle<{ ig_account_id: string }>();
      const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
      if (!resolved) {
        // Leave feedback_sent_at null so it retries once the account is back/approved.
        results.push({ order: row.id, ok: false, detail: "account unavailable" });
        continue;
      }

      const handle = one(row.businesses)?.public_handle ?? null;
      const message = feedbackMessage(handle);
      const sendRes = await sendInstagramMessage(row.igsid, message, resolved.accessToken);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rejected: any = sendRes?.error;

      // Mirror into the transcript only if the chat still exists (it may have been deleted).
      if (!rejected && row.conversation_id) {
        await supabaseAdmin.from("instagram_messages").insert({
          conversation_id: row.conversation_id,
          role: "assistant",
          content: message,
          // Recorded so the webhook's later echo of this send is recognized as
          // ours and deduped, instead of appearing twice and being mistaken for
          // a manual phone reply (which would wrongly flip mode to human).
          instagram_msg_id: sendRes?.message_id ?? null,
        });
        await supabaseAdmin
          .from("instagram_conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", row.conversation_id);
      }

      // Stamp even on a Meta rejection (e.g. the 24h window) — the window won't reopen for a past
      // dine time, so retrying is pointless. A network throw skips this (caught below) and retries.
      await supabaseAdmin
        .from("orders")
        .update({ feedback_sent_at: new Date().toISOString() })
        .eq("id", row.id);

      results.push({
        order: row.id,
        ok: !rejected,
        detail: rejected ? `rejected: ${rejected.message || rejected.code || "policy"}` : "sent",
      });
    } catch (err) {
      console.error(`Feedback send failed for order ${row.id}:`, (err as Error).message);
      results.push({ order: row.id, ok: false, detail: (err as Error).message });
    }
  }

  return Response.json({
    candidates: data?.length ?? 0,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
