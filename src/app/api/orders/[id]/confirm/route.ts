import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendInstagramMessage } from "@/lib/instagram";
import { cancelOrderAndNotify, type OrderForCancel } from "@/lib/orders";

// Confirm an order: mark it confirmed AND DM the customer a confirmation. Uses the order's OWN snapshotted
// igsid + instagram_account_id (not the conversation), so it still works if the chat was deleted — the
// confirmation DM goes out either way, and we only mirror it into the transcript if the chat still exists.

function confirmationText(kind: string, details: string): string {
  // details is the ` · `-joined summary from order-detect.ts — split it back into one bulleted
  // line per field, with a blank line above/below the block. Empty details → a single space so
  // the header and closing line still read as one sentence.
  const parts = details?.trim()
    ? details.trim().split(" · ").map((s) => `· ${s.trim()}`).join("\n")
    : "";
  const block = parts ? `\n\n${parts}\n\n` : " ";
  return kind === "reservation"
    ? `✅ Your reservation is confirmed!${block}We look forward to welcoming you — see you soon!`
    : `✅ Your order is confirmed!${block}We'll have it ready — see you at pickup!`;
}

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, kind, details, status, igsid, instagram_account_id, conversation_id")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      kind: string;
      details: string;
      status: string;
      igsid: string | null;
      instagram_account_id: string | null;
      conversation_id: string | null;
    }>();
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  // Ownership: the order's own account must be one the caller can act on (works even if the chat is gone).
  if (!order.instagram_account_id || !ctx.accountIds.includes(order.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotent: already confirmed → don't re-send the DM. (Fast-path only — the
  // real guard against a double-send is the atomic claim below, since two
  // requests can both read "pending" here before either has written back.)
  if (order.status === "confirmed") {
    return Response.json({ id: order.id, status: "confirmed", already: true });
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

  // Atomic claim BEFORE sending anything: a double-click, or two staff members
  // confirming at once, must not both pass the check above and both send the
  // DM. The conditional `eq("status", order.status)` only succeeds for
  // whichever request's write lands first — the loser affects zero rows and
  // never sends a duplicate message.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("orders")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", order.status)
    .select("id, status, confirmed_at")
    .maybeSingle();
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  if (!claimed) {
    // Someone else's request already claimed it between our read and this write.
    return Response.json({ id: order.id, status: "confirmed", already: true });
  }

  const message = confirmationText(order.kind, order.details);
  const sendResult = await sendInstagramMessage(order.igsid, message, resolved.accessToken);

  // Mirror the confirmation into the transcript — only if the chat still exists (it may have been deleted).
  if (order.conversation_id) {
    await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: order.conversation_id,
      role: "assistant",
      content: message,
      // Recorded so the webhook's later echo of this same send is recognized as
      // ours and deduped, instead of appearing as a duplicate message AND being
      // mistaken for a manual phone reply (which would wrongly flip the
      // conversation to human mode and silently stop the AI from replying).
      instagram_msg_id: sendResult?.message_id ?? null,
    });
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", order.conversation_id);
  }

  // A guest who cancelled a reservation and then booked this instead never gets
  // a separate "please also click Cancel" step — confirming the replacement
  // auto-cancels whatever it superseded. Only fires when there's an actual open
  // cancellation request for this conversation (never speculatively); the AI
  // still never finalizes anything on its own — this is triggered by the same
  // human Confirm click as always.
  let supersededOrder: { id: string; status: string } | null = null;
  if (order.conversation_id) {
    const { data: pendingCancellation } = await supabaseAdmin
      .from("review_items")
      .select("id")
      .eq("conversation_id", order.conversation_id)
      .eq("category", "cancellation")
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();

    if (pendingCancellation) {
      const { data: otherOrder } = await supabaseAdmin
        .from("orders")
        .select("id, kind, status, igsid, instagram_account_id, conversation_id")
        .eq("conversation_id", order.conversation_id)
        .neq("id", order.id)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<OrderForCancel>();

      if (otherOrder) {
        const cancelResult = await cancelOrderAndNotify(otherOrder);
        if (cancelResult.ok) supersededOrder = { id: cancelResult.id, status: cancelResult.status };
      }
    }
  }

  return Response.json({ ...claimed, supersededOrder });
}
