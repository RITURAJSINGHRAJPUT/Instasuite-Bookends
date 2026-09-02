import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

async function ownsBusiness(
  businessId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof getContext>>>
) {
  const { data } = await supabaseAdmin
    .from("businesses")
    .select("id, client_id")
    .eq("id", businessId)
    .maybeSingle<{ id: string; client_id: string }>();
  if (!data) return false;
  return isStaff(ctx.user.role) || data.client_id === ctx.user.id;
}

// Remove an outlet from a business. Verifies ownership of the parent business AND that the outlet
// belongs to it before deleting — a 404 either way so existence never leaks.
export async function DELETE(
  _r: NextRequest,
  { params }: { params: Promise<{ id: string; outletId: string }> }
) {
  const { id, outletId } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsBusiness(id, ctx))) return Response.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("outlets")
    .delete()
    .eq("id", outletId)
    .eq("business_id", id)
    .select("name")
    .maybeSingle<{ name: string }>();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "outlet.delete",
    targetType: "outlet",
    targetId: outletId,
    targetLabel: data?.name ?? null,
  });

  return Response.json({ success: true });
}
