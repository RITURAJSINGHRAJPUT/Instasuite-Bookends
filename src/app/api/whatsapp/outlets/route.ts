import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";
import { normalizeOutlet } from "@/lib/triggers";

// Manage per-OUTLET WhatsApp destinations (whatsapp_outlet_routes). One Instagram account
// can serve several outlets; each outlet may point at its own WhatsApp group / staff numbers.
// Reads happen in the sibling /api/whatsapp GET; this route owns writes (upsert + delete).
// Same gating as the parent route: authed, can(role,"whatsapp"), and business ownership.

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

// Accepts a comma-separated string or an array; keeps digits only, drops empties, dedupes.
function normalizeNumbers(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? "").split(",");
  const cleaned = parts.map((p) => p.replace(/\D/g, "")).filter(Boolean);
  return [...new Set(cleaned)];
}

// Create or update the route for one (business, outlet).
export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "whatsapp")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const businessId = String(body?.business_id ?? "");
  const label = String(body?.label ?? "").trim();
  // Normalize the outlet the same way the webhook does, so keys match on exact equality.
  // Fall back to the label if no explicit outlet field was sent.
  const outlet = normalizeOutlet(String(body?.outlet ?? label));
  const groupId = String(body?.group_id ?? "").trim() || null;
  const staffNumbers = normalizeNumbers(body?.staff_numbers);

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });
  if (!outlet) return Response.json({ error: "outlet is required" }, { status: 400 });
  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("whatsapp_outlet_routes")
    .upsert(
      {
        business_id: businessId,
        outlet,
        label: label || null,
        group_id: groupId,
        staff_numbers: staffNumbers,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "business_id,outlet" }
    )
    .select("id, business_id, outlet, label, group_id, staff_numbers")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

// Remove a route by id (ownership verified via its business).
export async function DELETE(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "whatsapp")) return Response.json({ error: "Not found" }, { status: 404 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const { data: route } = await supabaseAdmin
    .from("whatsapp_outlet_routes")
    .select("id, business_id")
    .eq("id", id)
    .maybeSingle<{ id: string; business_id: string }>();
  if (!route) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await ownsBusiness(route.business_id, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { error } = await supabaseAdmin.from("whatsapp_outlet_routes").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
