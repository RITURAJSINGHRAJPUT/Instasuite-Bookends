import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });

  let q = supabaseAdmin
    .from("businesses")
    .select("id, name, status, default_script_id, public_handle, created_at, instagram_accounts(id, ig_account_id, username, name, status, script_id), outlets(id, name)")
    .order("created_at", { ascending: true });

  // Staff see every business; a client only their own.
  if (!isStaff(ctx.user.role)) q = q.eq("client_id", ctx.user.id);

  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "businesses")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const name = String(body?.name ?? "").trim();
  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });

  // status is NEVER taken from the request: a client must not be able to
  // self-approve and bypass the super-admin gate. Staff-created businesses are
  // auto-approved — they run the operator's own account, so there is no separate
  // approver.
  const status = isStaff(ctx.user.role) ? "approved" : "pending";

  const { data, error } = await supabaseAdmin
    .from("businesses")
    .insert({ client_id: ctx.user.id, name, status })
    .select("id, name, status")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Every business needs a script to fall back on.
  const { data: script } = await supabaseAdmin
    .from("scripts")
    .insert({ business_id: data.id, name: "Default script", content: `# ${name}\n\nYou are the Instagram DM assistant for ${name}. Be warm, concise and helpful.` })
    .select("id")
    .single();

  if (script) {
    await supabaseAdmin.from("businesses").update({ default_script_id: script.id }).eq("id", data.id);
  }

  await logAudit(ctx.user, {
    action: "business.create",
    targetType: "business",
    targetId: data.id,
    targetLabel: data.name,
  });

  return Response.json(data, { status: 201 });
}
