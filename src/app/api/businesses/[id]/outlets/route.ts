import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

// Per-business outlets — the structured list the Unavailable page turns into a dropdown, managed on
// the Businesses page. Gated by the `businesses` capability + per-business ownership.

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

// GET the outlets for a business (also available inline on /api/businesses; this is the granular read).
export async function GET(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsBusiness(id, ctx))) return Response.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("outlets")
    .select("id, name")
    .eq("business_id", id)
    .order("name", { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data ?? []);
}

// POST add an outlet. Duplicate name for the same business is a no-op (unique constraint → 23505).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsBusiness(id, ctx))) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  if (!name) return Response.json({ error: "An outlet name is required" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("outlets")
    .insert({ business_id: id, name })
    .select("id, name")
    .single();
  if (error) {
    if (error.code === "23505") return Response.json({ error: "That outlet already exists." }, { status: 409 });
    return Response.json({ error: error.message }, { status: 500 });
  }
  await logAudit(ctx.user, {
    action: "outlet.create",
    targetType: "outlet",
    targetId: data.id,
    targetLabel: data.name,
  });

  return Response.json(data, { status: 201 });
}
