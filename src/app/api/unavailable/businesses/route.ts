import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can, isStaff } from "@/lib/permissions";

// A narrow, read-only business+outlet list for the Unavailable page's dropdowns.
// Deliberately separate from GET /api/businesses (gated by the "businesses"
// capability, which Manager doesn't have) — that endpoint also returns
// instagram_accounts/scripts/public_handle, exactly the business-management
// detail Manager is meant NOT to see. This one is gated by "unavailable"
// instead, and selects only what the page actually renders: id, name, outlets.

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "unavailable")) return Response.json({ error: "Not found" }, { status: 404 });

  let q = supabaseAdmin
    .from("businesses")
    .select("id, name, outlets(id, name)")
    .order("created_at", { ascending: true });

  // Staff see every business; a client only their own — same scoping as /api/businesses.
  if (!isStaff(ctx.user.role)) q = q.eq("client_id", ctx.user.id);

  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
