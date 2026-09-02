import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/supabase-server";
import { can } from "@/lib/permissions";

// The Activity page's data source — the audit_log ledger, newest first.
//
// super_admin only, via the `audit` capability. 404 rather than 403, the same
// convention /api/admin/pending uses: a role without the feature shouldn't even be
// able to confirm the endpoint exists.
//
// NOT outlet-scoped. Every other list route filters by ctx.accountIds; a super admin
// is auditing the whole operator account, so scoping it would hide exactly the rows
// this page exists to show — hence getSessionUser() here rather than getContext().

const PAGE_SIZE = 50;

type Row = {
  id: string;
  actor_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user || !can(user.role, "audit")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const params = request.nextUrl.searchParams;
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const actor = params.get("actor");
  const action = params.get("action");

  let query = supabaseAdmin
    .from("audit_log")
    .select(
      "id, actor_id, actor_email, actor_role, action, target_type, target_id, target_label, created_at",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (actor) query = query.eq("actor_email", actor);
  // Prefix match, so "order" catches order.confirm / order.cancel / order.update —
  // the reason actions are named "<resource>.<verb>" in the first place.
  if (action) query = query.like("action", `${action}%`);

  const { data, error, count } = await query.returns<Row[]>();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    rows: data ?? [],
    total: count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
}
