import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

async function ownsScript(scriptId: string, ctx: NonNullable<Awaited<ReturnType<typeof getContext>>>) {
  // Name the FK: scripts<->businesses has two relationships, so a bare embed is
  // ambiguous (see /api/scripts). Use the script's owning-business FK.
  const { data } = await supabaseAdmin
    .from("scripts")
    .select("id, business_id, businesses!scripts_business_id_fkey(client_id)")
    .eq("id", scriptId)
    .maybeSingle<{ id: string; business_id: string; businesses: { client_id: string } | null }>();
  if (!data) return null;
  if (!isStaff(ctx.user.role) && data.businesses?.client_id !== ctx.user.id) return null;
  return data;
}

export async function GET(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "scripts")) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsScript(id, ctx))) return Response.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("scripts").select("id, name, content, business_id, updated_at").eq("id", id).single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "scripts")) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsScript(id, ctx))) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const patch: { content?: string; name?: string; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (typeof body?.content === "string") patch.content = body.content;
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();

  const { data, error } = await supabaseAdmin
    .from("scripts").update(patch).eq("id", id).select("id, name, updated_at").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "script.update",
    targetType: "script",
    targetId: id,
    targetLabel: data.name,
  });

  return Response.json(data);
}
