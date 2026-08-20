import { supabaseAdmin } from "@/lib/supabase";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendInstagramMessage } from "@/lib/instagram";

// Shared by /api/orders/[id]/cancel (a direct staff click) and
// /api/orders/[id]/confirm (auto-cancelling a superseded order when its
// replacement is confirmed) — one place for the cancel-and-notify logic so
// the two callers can't drift apart.

export type OrderForCancel = {
  id: string;
  kind: string;
  status: string;
  igsid: string | null;
  instagram_account_id: string | null;
  conversation_id: string | null;
};

export type CancelOrderResult =
  | { ok: true; id: string; status: "cancelled"; already: boolean }
  | { ok: false; error: string; httpStatus: number };

export function cancellationText(kind: string): string {
  return kind === "reservation"
    ? "We're sorry to see it go — your reservation has been cancelled. Let us know if you'd like to book again anytime!"
    : "Your order has been cancelled. Let us know if you'd like to place a new one anytime!";
}

export async function cancelOrderAndNotify(order: OrderForCancel): Promise<CancelOrderResult> {
  // Idempotent fast-path — the real guard is the atomic claim below.
  if (order.status === "cancelled") {
    return { ok: true, id: order.id, status: "cancelled", already: true };
  }

  if (!order.igsid) {
    return { ok: false, error: "This order has no saved recipient to message.", httpStatus: 422 };
  }
  if (!order.instagram_account_id) {
    return { ok: false, error: "Instagram account unavailable", httpStatus: 502 };
  }

  const { data: acc } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", order.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();
  const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
  if (!resolved) {
    return { ok: false, error: "Instagram account unavailable", httpStatus: 502 };
  }

  // Atomic claim BEFORE sending anything — only whichever request's write lands
  // first gets to send the cancellation DM.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("orders")
    .update({ status: "cancelled" })
    .eq("id", order.id)
    .eq("status", order.status)
    .select("id, status")
    .maybeSingle<{ id: string; status: string }>();
  if (claimError) return { ok: false, error: claimError.message, httpStatus: 500 };
  if (!claimed) {
    return { ok: true, id: order.id, status: "cancelled", already: true };
  }

  const message = cancellationText(order.kind);
  await sendInstagramMessage(order.igsid, message, resolved.accessToken);

  if (order.conversation_id) {
    await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: order.conversation_id,
      role: "assistant",
      content: message,
    });
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", order.conversation_id);

    // Any pending cancellation-request review item for this conversation is now
    // actioned — mark it done so it stops showing as open in /review too.
    await supabaseAdmin
      .from("review_items")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("conversation_id", order.conversation_id)
      .eq("category", "cancellation")
      .eq("status", "pending");
  }

  return { ok: true, id: claimed.id, status: "cancelled", already: false };
}
