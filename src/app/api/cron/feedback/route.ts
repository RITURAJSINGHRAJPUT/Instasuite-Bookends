import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendAndStore } from "@/lib/outbound";
import { feedbackSendAt, feedbackMessage } from "@/lib/feedback";

// Post-dining feedback DMs. Sends the thank-you to CONFIRMED reservations whose send time (reservation
// + 2h, capped at 11:55pm IST — see src/lib/feedback.ts) has passed. Best-effort: each row is attempted
// once and stamped `feedback_sent_at` so it never re-sends. Instagram rejects DMs outside the guest's
// 24h window, and sendAndStore REPORTS that error rather than throwing — a permanent no-send, so
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
  // Look back a week, not 12 hours. With a 12h floor, any outage longer than that dropped due
  // bookings out of the window permanently — feedback_sent_at stayed null but they could never
  // be selected again. A wider floor plus the STALE_AFTER_MS stamp below drains them instead.
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Instagram refuses DMs outside the guest's 24h window, so a send due more than a day ago can
  // never succeed. Stamp those done rather than re-evaluating them on every run forever.
  const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  // One thank-you per guest, not per row. Duplicate order rows for the same conversation used to
  // each earn their own DM, so a guest could be thanked three times for one booking. Capture at
  // source is fixed too (see captureOrder), but this stays as the belt to that braces.
  const messagedConversations = new Set<string>();

  for (const row of (data ?? []) as unknown as Row[]) {
    const dueAt = feedbackSendAt(row.scheduled_at).getTime();
    if (now < dueAt) continue; // not due yet

    try {
      if (!row.igsid || !row.instagram_account_id) {
        results.push({ order: row.id, ok: false, detail: "no recipient snapshot" });
        continue;
      }

      // Too late to ever send — close it out so it stops being a candidate.
      if (now - dueAt > STALE_AFTER_MS) {
        await supabaseAdmin
          .from("orders")
          .update({ feedback_sent_at: new Date().toISOString() })
          .eq("id", row.id);
        results.push({ order: row.id, ok: false, detail: "skipped: past the 24h window" });
        continue;
      }

      // A sibling row for this same chat already got the thank-you in this run.
      if (row.conversation_id && messagedConversations.has(row.conversation_id)) {
        await supabaseAdmin
          .from("orders")
          .update({ feedback_sent_at: new Date().toISOString() })
          .eq("id", row.id);
        results.push({ order: row.id, ok: false, detail: "skipped: duplicate of same conversation" });
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
      // Mirrors into the transcript only what was delivered, and only if the chat
      // still exists (it may have been deleted).
      const sent = await sendAndStore({
        conversationId: row.conversation_id,
        igsid: row.igsid,
        text: message,
        accessToken: resolved.accessToken,
      });
      const rejected = sent.error;
      // Claim the conversation even on a Meta rejection: the guest may still have received it,
      // and a sibling row retrying would risk a second copy.
      if (row.conversation_id) messagedConversations.add(row.conversation_id);

      // Stamp even on a Meta rejection (e.g. the 24h window) — the window won't reopen for a past
      // dine time, so retrying is pointless. A network throw skips this (caught below) and retries.
      await supabaseAdmin
        .from("orders")
        .update({ feedback_sent_at: new Date().toISOString() })
        .eq("id", row.id);

      results.push({
        order: row.id,
        ok: sent.ok,
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
