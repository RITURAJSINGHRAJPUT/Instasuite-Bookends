import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();

  // FIELD WHITELIST. Passing the body through would let a client send
  // { status: "approved" } and approve themselves, bypassing the super-admin
  // gate entirely. `name` and `default_script_id` are client-editable; status
  // changes go through /api/admin/* which is super_admin-only.
  const patch: { name?: string; default_script_id?: string; public_handle?: string | null } = {};
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();
  // Public @handle to tag in feedback DMs. An empty string clears it back to null.
  if (typeof body?.public_handle === "string") patch.public_handle = body.public_handle.trim() || null;

  if (typeof body?.default_script_id === "string" && body.default_script_id) {
    // The chosen script must belong to THIS business, or you could point your
    // business's default at a script under someone else's business.
    const { data: script } = await supabaseAdmin
      .from("scripts")
      .select("id")
      .eq("id", body.default_script_id)
      .eq("business_id", id)
      .maybeSingle();
    if (!script) {
      return Response.json({ error: "That script doesn't belong to this business." }, { status: 400 });
    }
    patch.default_script_id = body.default_script_id;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  let q = supabaseAdmin.from("businesses").update(patch).eq("id", id);
  if (!isStaff(ctx.user.role)) q = q.eq("client_id", ctx.user.id); // ownership predicate

  const { data, error } = await q.select("id, name, status, default_script_id, public_handle").maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });

  await logAudit(ctx.user, {
    action: "business.update",
    targetType: "business",
    targetId: id,
    targetLabel: data.name,
  });

  return Response.json(data);
}

// Delete a business and everything under it. The FK graph is `on delete cascade` all the way down
// (scripts, instagram_accounts -> conversations -> messages/orders/reviews, plus outlets and the 86'd
// tables), so one delete removes the whole subtree; usage_events rows are kept with their keys nulled
// (metering history). Ownership is enforced in-query — a client can only delete their own; a foreign id
// returns 404 rather than deleting anything.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });

  let q = supabaseAdmin.from("businesses").delete().eq("id", id);
  if (!isStaff(ctx.user.role)) q = q.eq("client_id", ctx.user.id); // same ownership predicate as PATCH

  const { data, error } = await q.select("id, name").maybeSingle<{ id: string; name: string }>();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });

  // The name comes back from the delete's own RETURNING clause — the row is gone by
  // now, so this is the last chance to record WHICH business was removed. A cascade
  // this wide (scripts, accounts, conversations, orders) deserves a named entry.
  await logAudit(ctx.user, {
    action: "business.delete",
    targetType: "business",
    targetId: id,
    targetLabel: data.name,
  });

  return Response.json({ success: true });
}
