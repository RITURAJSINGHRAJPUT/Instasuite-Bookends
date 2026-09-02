import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

// Verify the caller owns the business (or is staff). Mirrors ownsScript in the
// [id] route — the ownership predicate for anything under a business.
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

// Collection route for the /scripts page. Only /api/scripts/[id] existed, so
// there was no way to list what a client owns — the schema has always allowed
// many scripts per business (instagram_accounts.script_id ?? default_script_id),
// but exactly one is ever created, at business creation.
//
// Scoped through businesses.client_id, the same chain ownsScript() walks in the
// sibling [id] route. Content is not selected: the list only needs headers, and
// a script can be tens of KB.
export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "scripts")) return Response.json({ error: "Not found" }, { status: 404 });

  // Disambiguate the embed: there are TWO FKs between scripts and businesses
  // (scripts.business_id -> businesses, and businesses.default_script_id ->
  // scripts), so a bare `businesses(...)` embed is ambiguous and 500s. Name the
  // FK we want — the script's owning business.
  let query = supabaseAdmin
    .from("scripts")
    .select(
      "id, name, business_id, updated_at, businesses!scripts_business_id_fkey!inner(name, client_id, default_script_id)"
    )
    .order("updated_at", { ascending: false });

  if (!isStaff(ctx.user.role)) query = query.eq("businesses.client_id", ctx.user.id);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  type Joined = {
    id: string;
    name: string;
    business_id: string;
    updated_at: string;
    businesses: { name: string; client_id: string; default_script_id: string | null } | null;
  };

  // client_id is dropped rather than passed through — the caller already proved
  // ownership to get here, and it has no use in the UI.
  return Response.json(
    ((data ?? []) as unknown as Joined[]).map((s) => ({
      id: s.id,
      name: s.name,
      business_id: s.business_id,
      business_name: s.businesses?.name ?? null,
      is_default: s.businesses?.default_script_id === s.id,
      updated_at: s.updated_at,
    }))
  );
}

// Create an additional script under a business the caller owns. A business may
// hold many scripts (an account can point at its own via instagram_accounts
// .script_id, else it inherits businesses.default_script_id). Making it live is a
// separate step (assign it to an account, or Make default via businesses PATCH).
export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "scripts")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const businessId = String(body?.business_id ?? "");
  const name = String(body?.name ?? "").trim();
  const content = typeof body?.content === "string" ? body.content : "";

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "A script name is required" }, { status: 400 });
  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("scripts")
    .insert({ business_id: businessId, name, content })
    .select("id, name, business_id, updated_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "script.create",
    targetType: "script",
    targetId: data.id,
    targetLabel: data.name,
  });

  return Response.json(data, { status: 201 });
}
