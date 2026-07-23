import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";

// Manages the reservation-team WhatsApp destinations (per business) and surfaces the
// delivery log (whatsapp_outbox). Reads/writes via the service-role client; scoping is
// enforced in-query (whatsapp_outbox has RLS-on/no-policy, so it MUST be scoped here).

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

type BizRow = { id: string; name: string; client_id: string };
type SettingsRow = { business_id: string; group_id: string | null; staff_numbers: string[] | null };
type OutboxJoined = {
  id: string;
  kind: string;
  customer_name: string | null;
  account_username: string | null;
  body: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  businesses: { name: string; client_id: string } | null;
};

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "whatsapp")) return Response.json({ error: "Not found" }, { status: 404 });

  // Businesses the caller can manage (staff = all, client = own).
  let bizQuery = supabaseAdmin.from("businesses").select("id, name, client_id").order("name");
  if (!isStaff(ctx.user.role)) bizQuery = bizQuery.eq("client_id", ctx.user.id);
  const { data: bizData, error: bizErr } = await bizQuery;
  if (bizErr) return Response.json({ error: bizErr.message }, { status: 500 });

  const bizIds = (bizData ?? []).map((b) => (b as BizRow).id);

  // Their saved destinations, merged in by business_id.
  const settingsById = new Map<string, SettingsRow>();
  if (bizIds.length) {
    const { data: sData } = await supabaseAdmin
      .from("whatsapp_settings")
      .select("business_id, group_id, staff_numbers")
      .in("business_id", bizIds);
    for (const s of (sData ?? []) as SettingsRow[]) settingsById.set(s.business_id, s);
  }

  const businesses = (bizData ?? []).map((b) => {
    const row = b as BizRow;
    const s = settingsById.get(row.id);
    return {
      id: row.id,
      name: row.name,
      group_id: s?.group_id ?? "",
      staff_numbers: s?.staff_numbers ?? [],
    };
  });

  // Delivery log — newest first, scoped to the caller's businesses.
  let logQuery = supabaseAdmin
    .from("whatsapp_outbox")
    .select(
      "id, kind, customer_name, account_username, body, status, attempts, last_error, created_at, sent_at, businesses!inner(name, client_id)"
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (!isStaff(ctx.user.role)) logQuery = logQuery.eq("businesses.client_id", ctx.user.id);
  const { data: logData, error: logErr } = await logQuery;
  if (logErr) return Response.json({ error: logErr.message }, { status: 500 });

  const outbox = ((logData ?? []) as unknown as OutboxJoined[]).map((r) => ({
    id: r.id,
    business_name: r.businesses?.name ?? null,
    kind: r.kind,
    customer_name: r.customer_name,
    account_username: r.account_username,
    body: r.body,
    status: r.status,
    attempts: r.attempts,
    last_error: r.last_error,
    created_at: r.created_at,
    sent_at: r.sent_at,
  }));

  // Worker connection status (the singleton the worker heartbeats to). `online` is true
  // only if the row was updated recently — a stale row means the worker isn't running.
  const { data: sess } = await supabaseAdmin
    .from("whatsapp_session")
    .select("status, qr, phone, updated_at")
    .eq("id", "default")
    .maybeSingle<{ status: string; qr: string | null; phone: string | null; updated_at: string }>();

  const online = sess ? Date.now() - new Date(sess.updated_at).getTime() < 60_000 : false;
  const session = {
    status: sess?.status ?? "unknown",
    qr: sess?.qr ?? null,
    phone: sess?.phone ?? null,
    updated_at: sess?.updated_at ?? null,
    online,
  };

  return Response.json({ businesses, outbox, session });
}

// Accepts a comma-separated string or an array; keeps digits only, drops empties, dedupes.
function normalizeNumbers(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? "").split(",");
  const cleaned = parts.map((p) => p.replace(/\D/g, "")).filter(Boolean);
  return [...new Set(cleaned)];
}

export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "whatsapp")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const businessId = String(body?.business_id ?? "");
  const groupId = String(body?.group_id ?? "").trim() || null;
  const staffNumbers = normalizeNumbers(body?.staff_numbers);

  if (!businessId) return Response.json({ error: "business_id is required" }, { status: 400 });
  if (!(await ownsBusiness(businessId, ctx))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("whatsapp_settings")
    .upsert(
      {
        business_id: businessId,
        group_id: groupId,
        staff_numbers: staffNumbers,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "business_id" }
    )
    .select("business_id, group_id, staff_numbers")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
