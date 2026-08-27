import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";

// Verify the caller owns the business (or is staff). Mirrors ownsBusiness in
// /api/scripts and /api/unavailable.
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

type JoinedRow = {
  id: string;
  business_id: string;
  title: string;
  message: string;
  created_at: string;
  businesses: { name: string; client_id: string } | null;
};

// Read access is deliberately broader than manage access: an Agent has "inbox"
// but not "quick_replies", and still needs to fetch the list to use it while
// chatting — only adding/removing requires "quick_replies" (see POST below and
// [id]/route.ts's DELETE).
export async function GET(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox") && !can(ctx.user.role, "quick_replies")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const businessId = request.nextUrl.searchParams.get("business_id");

  let query = supabaseAdmin
    .from("quick_replies")
    .select("id, business_id, title, message, created_at, businesses!inner(name, client_id)")
    .order("created_at", { ascending: false });

  if (businessId) query = query.eq("business_id", businessId);
  // Staff see every business's entries; a client only their own.
  if (!isStaff(ctx.user.role)) query = query.eq("businesses.client_id", ctx.user.id);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = ((data ?? []) as unknown as JoinedRow[]).map((r) => ({
    id: r.id,
    business_id: r.business_id,
    business_name: r.businesses?.name ?? null,
    title: r.title,
    message: r.message,
    created_at: r.created_at,
  }));

  return Response.json(rows);
}

export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "quick_replies")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const businessId = String(body?.business_id ?? "");
  const title = String(body?.title ?? "").trim();
  const message = String(body?.message ?? "").trim();

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });
  if (!title) return Response.json({ error: "A title is required" }, { status: 400 });
  if (!message) return Response.json({ error: "A message is required" }, { status: 400 });
  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("quick_replies")
    .insert({ business_id: businessId, title, message })
    .select("id, business_id, title, message, created_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data, { status: 201 });
}
