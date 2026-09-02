import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const user = await getSessionUser();
  if (!can(user?.role, "admin")) return Response.json({ error: "Not found" }, { status: 404 });
  const { data, error } = await supabaseAdmin.from("plans").select("*").order("price_cents");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user || !can(user.role, "admin")) return Response.json({ error: "Not found" }, { status: 404 });

  const b = await request.json();
  const name = String(b?.name ?? "").trim();
  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("plans")
    .insert({
      name,
      max_ig_accounts: Number(b?.max_ig_accounts ?? 1),
      // null means unlimited — that's how the schema expresses "no cap".
      max_messages_per_month:
        b?.max_messages_per_month === null || b?.max_messages_per_month === ""
          ? null
          : Number(b.max_messages_per_month),
      price_cents: Number(b?.price_cents ?? 0),
      stripe_price_id: b?.stripe_price_id || null,
    })
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(user, {
    action: "plan.create",
    targetType: "plan",
    targetId: data.id,
    targetLabel: name,
  });

  return Response.json(data, { status: 201 });
}
