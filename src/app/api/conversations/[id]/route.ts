import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext, getOwnedConversation } from "@/lib/ownership";
import { can } from "@/lib/permissions";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  if (body.mode && !["agent", "human"].includes(body.mode)) {
    return Response.json({ error: "Invalid mode" }, { status: 400 });
  }

  // 404 rather than 403: don't confirm that someone else's id exists.
  const owned = await getOwnedConversation(id, ctx);
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

  // Switching back to AI closes out whatever human episode was open, so the stale
  // reason doesn't linger. `dismiss_handoff_notice` lets staff clear the Inbox's
  // "log this order" nudge without leaving human mode (e.g. it wasn't an order).
  const updates: Record<string, unknown> = {};
  if (body.mode) {
    updates.mode = body.mode;
    if (body.mode === "agent") updates.human_handoff_reason = null;
  }
  if (body.dismiss_handoff_notice) updates.human_handoff_reason = null;
  if (!Object.keys(updates).length) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .update(updates)
    .eq("id", id)
    .in("instagram_account_id", ctx.accountIds)
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox")) return Response.json({ error: "Not found" }, { status: 404 });

  const owned = await getOwnedConversation(id, ctx);
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

  // Messages are removed via the ON DELETE CASCADE foreign key.
  const { error } = await supabaseAdmin
    .from("instagram_conversations")
    .delete()
    .eq("id", id)
    .in("instagram_account_id", ctx.accountIds);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}
