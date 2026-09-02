import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabase";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user || !can(user.role, "admin")) return Response.json({ error: "Not found" }, { status: 404 });

  const b = await request.json();
  const patch: Record<string, unknown> = {};
  if (typeof b?.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if (b?.max_ig_accounts !== undefined) patch.max_ig_accounts = Number(b.max_ig_accounts);
  if (b?.max_messages_per_month !== undefined)
    patch.max_messages_per_month =
      b.max_messages_per_month === null || b.max_messages_per_month === ""
        ? null
        : Number(b.max_messages_per_month);
  if (b?.price_cents !== undefined) patch.price_cents = Number(b.price_cents);
  if (b?.stripe_price_id !== undefined) patch.stripe_price_id = b.stripe_price_id || null;
  if (Object.keys(patch).length === 0) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const { data, error } = await supabaseAdmin.from("plans").update(patch).eq("id", id).select().maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });

  await logAudit(user, {
    action: "plan.update",
    targetType: "plan",
    targetId: id,
    targetLabel: (data as { name?: string }).name ?? null,
  });

  return Response.json(data);
}
