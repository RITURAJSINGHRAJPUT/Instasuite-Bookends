import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";

// Verify the caller owns the business (or is staff) — the ownership predicate for
// anything hanging off a business. Mirrors ownsBusiness in /api/scripts.
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

// End of the current IST day as a UTC instant. IST = UTC+5:30; the rest of the codebase
// is UTC-only, so "unavailable for today" needs this explicit conversion (a dish 86'd
// at 3pm should clear at IST midnight, not UTC midnight).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function endOfIstDay(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const nextMidnightIst =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + 24 * 60 * 60 * 1000;
  return new Date(nextMidnightIst - IST_OFFSET_MS);
}

type JoinedRow = {
  id: string;
  business_id: string;
  dish: string;
  outlet: string | null;
  note: string | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  businesses: { name: string; client_id: string } | null;
};

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  let query = supabaseAdmin
    .from("unavailable_dishes")
    .select(
      "id, business_id, dish, outlet, note, starts_at, ends_at, created_at, businesses!inner(name, client_id)"
    )
    .order("created_at", { ascending: false });

  // Staff see every business's entries; a client only their own.
  if (!isStaff(ctx.user.role)) query = query.eq("businesses.client_id", ctx.user.id);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Hide already-ended rows: the page shows only what's live or upcoming. (The AI block
  // in availability.ts applies the same active-window filter independently.)
  const now = Date.now();
  const rows = ((data ?? []) as unknown as JoinedRow[])
    .filter((r) => r.ends_at == null || new Date(r.ends_at).getTime() > now)
    .map((r) => ({
      id: r.id,
      business_id: r.business_id,
      business_name: r.businesses?.name ?? null,
      dish: r.dish,
      outlet: r.outlet,
      note: r.note,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      created_at: r.created_at,
    }));

  return Response.json(rows);
}

export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const businessId = String(body?.business_id ?? "");
  const dish = String(body?.dish ?? "").trim();
  const outlet = String(body?.outlet ?? "").trim() || null;
  const note = String(body?.note ?? "").trim() || null;
  const scope = String(body?.scope ?? "today"); // "today" | "custom" | "open"
  const until = body?.until ? String(body.until) : null;

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });
  if (!dish) return Response.json({ error: "A dish name is required" }, { status: 400 });
  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let endsAt: string | null;
  if (scope === "open") {
    endsAt = null;
  } else if (scope === "custom") {
    if (!until) return Response.json({ error: "A custom end time is required" }, { status: 400 });
    const d = new Date(until);
    if (isNaN(d.getTime())) return Response.json({ error: "Invalid end time" }, { status: 400 });
    endsAt = d.toISOString();
  } else {
    endsAt = endOfIstDay().toISOString(); // "today"
  }

  const { data, error } = await supabaseAdmin
    .from("unavailable_dishes")
    .insert({ business_id: businessId, dish, outlet, note, ends_at: endsAt })
    .select("id, business_id, dish, outlet, note, starts_at, ends_at, created_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data, { status: 201 });
}
