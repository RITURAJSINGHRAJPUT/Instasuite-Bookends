import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

// Mark a captured order done — the guest ate, or collected. Unlike confirm/cancel this sends
// NOTHING to the customer: it's a bookkeeping flip that clears a finished booking off the
// Orders board. That's also why it has an undo (DELETE) and the other two don't — there's no
// DM to un-send, so a misclick costs nothing and shouldn't need a support request to fix.

type OrderRow = { id: string; kind: string; status: string; confirmed_at: string | null };

const SELECT = "id, kind, status, confirmed_at";

async function loadOwned(id: string, accountIds: string[]) {
  const { data } = await supabaseAdmin
    .from("orders")
    .select(`${SELECT}, instagram_account_id`)
    .eq("id", id)
    .maybeSingle<OrderRow & { instagram_account_id: string | null }>();
  if (!data) return null;
  // Same ownership rule as confirm/cancel: scope by the order's OWN snapshotted account, so
  // it still resolves when the originating chat has been deleted.
  if (!data.instagram_account_id || !accountIds.includes(data.instagram_account_id)) return null;
  return data;
}

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const order = await loadOwned(id, ctx.accountIds);
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  if (order.status === "cancelled") {
    return Response.json(
      { error: "This order was cancelled — it can't be marked done." },
      { status: 409 }
    );
  }
  if (order.status === "completed") {
    return Response.json({ id: order.id, status: "completed", already: true });
  }

  // Conditional on the status we read, mirroring confirm's atomic claim: two staff marking
  // the same order done at once must not both log an audit entry for it.
  const { data: claimed, error } = await supabaseAdmin
    .from("orders")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", order.status)
    .select("id, status, completed_at")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!claimed) return Response.json({ id: order.id, status: "completed", already: true });

  await logAudit(ctx.user, {
    action: "order.complete",
    targetType: "order",
    targetId: order.id,
    targetLabel: order.kind,
  });

  return Response.json({ ...claimed, already: false });
}

// Undo. Reverts to whatever the order was before it was closed out: 'confirmed' if the guest
// was actually messaged (confirmed_at is stamped), otherwise back to 'pending' so it returns
// to the queue still needing a real confirmation.
export async function DELETE(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const order = await loadOwned(id, ctx.accountIds);
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });
  if (order.status !== "completed") {
    return Response.json({ id: order.id, status: order.status, already: true });
  }

  const restored = order.confirmed_at ? "confirmed" : "pending";
  const { data: updated, error } = await supabaseAdmin
    .from("orders")
    .update({ status: restored, completed_at: null })
    .eq("id", id)
    .eq("status", "completed")
    .select("id, status, completed_at")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!updated) return Response.json({ id: order.id, status: restored, already: true });

  await logAudit(ctx.user, {
    action: "order.reopen",
    targetType: "order",
    targetId: order.id,
    targetLabel: order.kind,
  });

  return Response.json({ ...updated, already: false });
}
