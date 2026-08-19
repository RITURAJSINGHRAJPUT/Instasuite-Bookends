import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendInstagramMessage } from "@/lib/instagram";

// Cancel an order: mark it cancelled AND DM the customer. Mirrors confirm/route.ts exactly,
// including the atomic-claim race guard (two staff members clicking Cancel at once must not
// both send the DM) — see that file for the full rationale.

function cancellationText(kind: string): string {
  return kind === "reservation"
    ? "We're sorry to see it go — your reservation has been cancelled. Let us know if you'd like to book again anytime!"
    : "Your order has been cancelled. Let us know if you'd like to place a new one anytime!";
}

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, kind, status, igsid, instagram_account_id, conversation_id")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      kind: string;
      status: string;
      igsid: string | null;
      instagram_account_id: string | null;
      conversation_id: string | null;
    }>();
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  if (!order.instagram_account_id || !ctx.accountIds.includes(order.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotent fast-path — the real guard is the atomic claim below.
  if (order.status === "cancelled") {
    return Response.json({ id: order.id, status: "cancelled", already: true });
  }

  if (!order.igsid) {
    return Response.json({ error: "This order has no saved recipient to message." }, { status: 422 });
  }

  const { data: acc } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", order.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();
  const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
  if (!resolved) {
    return Response.json({ error: "Instagram account unavailable" }, { status: 502 });
  }

  // Atomic claim BEFORE sending anything — only whichever request's write lands
  // first gets to send the cancellation DM.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("orders")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", order.status)
    .select("id, status")
    .maybeSingle();
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  if (!claimed) {
    return Response.json({ id: order.id, status: "cancelled", already: true });
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

  return Response.json(claimed);
}
