import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { invalidateBlocklistCache } from "@/lib/blocklist";

// Unblock. Auto-replies resume on this handle's NEXT inbound message — unless the
// thread was separately flipped to mode "human" for another reason (outage, review, a
// staff reply from the phone app), which stays sticky exactly as it does today.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "blocked")) return Response.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;

  // Read first, so the audit entry can name the handle rather than a bare uuid.
  const { data: row } = await supabaseAdmin
    .from("blocked_users")
    .select("id, username")
    .eq("id", id)
    .maybeSingle<{ id: string; username: string }>();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabaseAdmin.from("blocked_users").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  invalidateBlocklistCache();

  await logAudit(ctx.user, {
    action: "blocked_user.delete",
    targetType: "blocked_user",
    targetId: row.id,
    targetLabel: `@${row.username}`,
  });

  return Response.json({ ok: true });
}
