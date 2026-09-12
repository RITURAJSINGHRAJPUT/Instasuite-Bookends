import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { WEEKDAY_NAMES } from "@/lib/ist";

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

// Drop a closed-day rule. Verifies the row's business belongs to the caller before deleting — a 404
// either way (missing or not yours) so existence never leaks. Mirrors the outlet/dish routes.
export async function DELETE(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: row } = await supabaseAdmin
    .from("closed_days")
    .select("id, business_id")
    .eq("id", id)
    .maybeSingle<{ id: string; business_id: string }>();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsBusiness(row.business_id, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("closed_days").delete().eq("id", id)
    .select("outlet, weekday, on_date")
    .maybeSingle<{ outlet: string | null; weekday: number | null; on_date: string | null }>();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const where = data?.outlet ?? "All outlets";
  await logAudit(ctx.user, {
    action: "unavailable.closed_day_remove",
    targetType: "closed_day",
    targetId: id,
    targetLabel:
      data?.weekday != null ? `${where} · every ${WEEKDAY_NAMES[data.weekday]}` : `${where} · ${data?.on_date ?? ""}`,
  });

  return Response.json({ success: true });
}
