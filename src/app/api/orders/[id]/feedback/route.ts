import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendInstagramMessage } from "@/lib/instagram";
import { feedbackMessage } from "@/lib/feedback";

// Manual "send feedback now" — the operator's fallback when the time-based cron (/api/cron/feedback)
// didn't fire, or they just want to send the thank-you on demand. Mirrors one iteration of the cron:
// resolve the token from the order's OWN snapshotted account, DM `order.igsid`, mirror into the
// transcript only if the chat still exists. UNLIKE the cron, we stamp `feedback_sent_at` ONLY on a
// successful send, so a rejected send (e.g. Meta's 24h window) stays retryable and never falsely
// reads as sent. Reservations only in the UI, but the route is kind-agnostic.

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? v[0] ?? null : v;
}

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, igsid, instagram_account_id, conversation_id, feedback_sent_at, businesses(public_handle)")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      igsid: string | null;
      instagram_account_id: string | null;
      conversation_id: string | null;
      feedback_sent_at: string | null;
      businesses: { public_handle: string | null } | { public_handle: string | null }[] | null;
    }>();
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  // Ownership: the order's own account must be one the caller can act on (works even if the chat is gone).
  if (!order.instagram_account_id || !ctx.accountIds.includes(order.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotent: already sent → report it, don't re-send.
  if (order.feedback_sent_at) {
    return Response.json({ sent: true, feedback_sent_at: order.feedback_sent_at, already: true });
  }

  if (!order.igsid) {
    return Response.json({ error: "This order has no saved recipient to message." }, { status: 422 });
  }

  // Resolve the sending token from the order's OWN account (not the conversation).
  const { data: acc } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", order.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();
  const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
  if (!resolved) {
    return Response.json({ error: "Instagram account unavailable" }, { status: 502 });
  }

  const handle = one(order.businesses)?.public_handle ?? null;
  const message = feedbackMessage(handle);
  const sendRes = await sendInstagramMessage(order.igsid, message, resolved.accessToken);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rejected: any = sendRes?.error;

  if (rejected) {
    // Do NOT stamp — leave it retryable (e.g. guest's 24h window is closed right now).
    return Response.json(
      { sent: false, detail: rejected.message || rejected.code || "policy" },
      { status: 502 }
    );
  }

  // Mirror into the transcript only if the chat still exists (it may have been deleted).
  if (order.conversation_id) {
    await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: order.conversation_id,
      role: "assistant",
      content: message,
      // Recorded so the webhook's later echo of this send is recognized as ours
      // and deduped, instead of appearing twice and being mistaken for a manual
      // phone reply (which would wrongly flip the conversation to human mode).
      instagram_msg_id: sendRes?.message_id ?? null,
    });
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", order.conversation_id);
  }

  const sentAt = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("orders")
    .update({ feedback_sent_at: sentAt })
    .eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ sent: true, feedback_sent_at: sentAt });
}
