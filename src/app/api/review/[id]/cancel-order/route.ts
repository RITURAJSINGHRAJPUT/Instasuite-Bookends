import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { cancelOrderAndNotify, type OrderForCancel } from "@/lib/orders";

// Act on a cancellation request straight from the Review page: cancel the booking AND DM
// the guest, in one click — the mirror image of Confirm on the Orders page.
//
// Before this, Review's only send button was the standing collaboration decline, and it
// rendered on EVERY category — so the one action offered on a cancellation request would
// have sent the guest a collab rejection. Actually cancelling meant leaving Review, finding
// the order on the Orders page, and pressing Cancel there.
//
// Ownership comes from the review item's OWN snapshotted instagram_account_id rather than
// the conversation's, matching respond/route.ts and orders/[id]/confirm — the row outlives
// the chat it came from.

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "review")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: item } = await supabaseAdmin
    .from("review_items")
    .select("id, status, category, instagram_account_id, conversation_id, customer_name")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      status: string;
      category: string;
      instagram_account_id: string | null;
      conversation_id: string | null;
      customer_name: string | null;
    }>();
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });

  if (!item.instagram_account_id || !ctx.accountIds.includes(item.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Refuse on any other category. The UI only shows this button for cancellations, but the
  // UI can only hide a button — a hand-made request is the threat model, and cancelling
  // someone's booking off the back of a complaint would be a real harm.
  if (item.category !== "cancellation") {
    return Response.json(
      { error: "This is only for cancellation requests." },
      { status: 400 }
    );
  }

  // Idempotent, and load-bearing rather than merely tidy. The order lookup below picks the
  // newest NON-cancelled order on the chat — so if this item were already actioned and the
  // guest had since rebooked, a second click would cancel the NEW booking. Anything already
  // terminal stops here.
  if (item.status !== "pending") {
    return Response.json({ id: item.id, status: item.status, already: true });
  }

  if (!item.conversation_id) {
    return Response.json(
      { error: "This request has no chat attached, so there's no booking to cancel." },
      { status: 422 }
    );
  }

  // The most recent order on the chat that isn't already cancelled — the one the guest is
  // most likely referring to. Same "newest first, skip cancelled" reasoning the Orders page
  // uses when it pins a cancellation request to an order.
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, kind, status, igsid, instagram_account_id, conversation_id")
    .eq("conversation_id", item.conversation_id)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<OrderForCancel>();

  // A guest can ask to cancel something that was never captured as an order — one of the
  // real requests in the data has no order at all. Saying "your reservation has been
  // cancelled" when we hold no such booking would be a lie, so this reports honestly and
  // sends staff to the Inbox instead of inventing a cancellation.
  if (!order) {
    return Response.json(
      { error: "No open booking on this chat to cancel — reply from the Inbox instead." },
      { status: 422 }
    );
  }

  // acknowledgeConfirmed is required here and is the correct call. That guard exists to stop
  // staff blindsiding a guest who was just told "confirmed" — but here the guest is the one
  // asking to cancel, so their own request IS the acknowledgement. orders/[id]/confirm passes
  // it for the same reason when auto-cancelling a superseded booking.
  //
  // cancelOrderAndNotify does the rest: the atomic status claim (so a double-click can't
  // double-send), the cancellation DM, mirroring it into the transcript, handing the chat
  // back to the AI, and completing any open cancellation review item on this conversation —
  // which is what closes THIS item.
  const result = await cancelOrderAndNotify(order, { acknowledgeConfirmed: true });
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.httpStatus });
  }

  await logAudit(ctx.user, {
    action: "order.cancel_from_review",
    targetType: "order",
    targetId: result.id,
    targetLabel: item.customer_name ?? order.kind,
  });

  return Response.json({ id: result.id, status: result.status, already: result.already });
}
