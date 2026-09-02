import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

async function ownsAccount(accountId: string, ctx: NonNullable<Awaited<ReturnType<typeof getContext>>>) {
  if (isStaff(ctx.user.role)) {
    const { data } = await supabaseAdmin.from("instagram_accounts").select("id, business_id").eq("id", accountId).maybeSingle();
    return data;
  }
  if (!ctx.accountIds.includes(accountId)) return null;
  const { data } = await supabaseAdmin.from("instagram_accounts").select("id, business_id").eq("id", accountId).maybeSingle();
  return data;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });
  const owned = await ownsAccount(id, ctx);
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();

  // WHITELIST: only script_id. `status` is super-admin-only (see /api/admin/*),
  // and ig_account_id / access_token are never client-editable.
  if (!("script_id" in body)) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }
  const scriptId: string | null = body.script_id ?? null;

  // A null script_id means "inherit the business default". A non-null one must
  // belong to the SAME business — otherwise a client could point their account
  // at another tenant's script.
  if (scriptId) {
    const { data: script } = await supabaseAdmin
      .from("scripts").select("id").eq("id", scriptId).eq("business_id", owned.business_id).maybeSingle();
    if (!script) return Response.json({ error: "Script not found for this business" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("instagram_accounts").update({ script_id: scriptId }).eq("id", id)
    .select("id, username, status, script_id").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "account.update",
    targetType: "instagram_account",
    targetId: id,
    targetLabel: data.username,
  });

  return Response.json(data);
}

export async function DELETE(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsAccount(id, ctx))) return Response.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("instagram_accounts").delete().eq("id", id)
    .select("username").maybeSingle<{ username: string | null }>();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "account.disconnect",
    targetType: "instagram_account",
    targetId: id,
    targetLabel: data?.username ?? null,
  });

  return Response.json({ success: true });
}
