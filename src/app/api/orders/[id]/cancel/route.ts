import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { cancelOrderAndNotify, type OrderForCancel } from "@/lib/orders";

// Cancel an order: mark it cancelled AND DM the customer. The actual cancel-and-notify
// logic (including the atomic-claim race guard) lives in src/lib/orders.ts, shared with
// the confirm route's auto-cancel-superseded-order path.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  // Set by the UI only after staff acknowledge the guest was already told the order
  // is confirmed — see the guard in cancelOrderAndNotify.
  const body = await request.json().catch(() => null);
  const acknowledgeConfirmed = body?.acknowledge_confirmed === true;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, kind, status, igsid, instagram_account_id, conversation_id")
    .eq("id", id)
    .maybeSingle<OrderForCancel>();
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  if (!order.instagram_account_id || !ctx.accountIds.includes(order.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const result = await cancelOrderAndNotify(order, { acknowledgeConfirmed });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.httpStatus });
  return Response.json({ id: result.id, status: result.status, already: result.already });
}
