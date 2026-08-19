import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";

// The Orders page's data source — real captured reservations/takeaways (the `orders` ledger), scoped to
// the caller's accounts. Reads via the service-role client (orders has RLS-on/no-policy); scoping is by
// the order's own `instagram_account_id` (snapshotted at capture) so records survive a deleted chat.

type Joined = {
  id: string;
  kind: string;
  customer_name: string | null;
  details: string;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  scheduled_at: string | null;
  feedback_sent_at: string | null;
  conversation_id: string | null;
  instagram_account_id: string | null;
  instagram_accounts: { username: string | null } | { username: string | null }[] | null;
};

export async function GET(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  // ?count=1 returns just the number of PENDING orders — what the sidebar badge shows ("new" = not yet
  // confirmed). Same account scoping as the list; head:true so it never ships rows.
  const wantCount = request.nextUrl.searchParams.get("count") === "1";
  if (ctx.accountIds.length === 0) return Response.json(wantCount ? { count: 0 } : []);

  if (wantCount) {
    const { count, error } = await supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .in("instagram_account_id", ctx.accountIds);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ count: count ?? 0 });
  }

  // Scope by the order's own account (staff = all, client = own). The account embed gives the username
  // for the page's per-account filter; conversation_id is kept for the "open chat" link (null if the
  // chat was deleted).
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id, kind, customer_name, details, status, created_at, confirmed_at, scheduled_at, feedback_sent_at, conversation_id, instagram_account_id, instagram_accounts(username)"
    )
    .in("instagram_account_id", ctx.accountIds)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = ((data ?? []) as unknown as Joined[]).map((r) => {
    const acc = Array.isArray(r.instagram_accounts) ? r.instagram_accounts[0] : r.instagram_accounts;
    return {
      id: r.id,
      kind: r.kind,
      customer_name: r.customer_name,
      details: r.details,
      status: r.status,
      created_at: r.created_at,
      confirmed_at: r.confirmed_at,
      scheduled_at: r.scheduled_at,
      feedback_sent_at: r.feedback_sent_at,
      conversation_id: r.conversation_id,
      account_id: r.instagram_account_id ?? null,
      account_username: acc?.username ?? null,
      cancellationRequested: false,
    };
  });

  // Surface open cancellation requests (captured via the Review pipeline, see
  // src/lib/order-detect.ts's "cancellation" category) directly on the order
  // they refer to, so staff see it in Orders without a separate trip to Review.
  const { data: cancellationRequests } = await supabaseAdmin
    .from("review_items")
    .select("conversation_id")
    .eq("category", "cancellation")
    .eq("status", "pending")
    .in("instagram_account_id", ctx.accountIds);

  const requestedConversations = new Set(
    (cancellationRequests ?? []).map((r) => r.conversation_id).filter(Boolean)
  );
  if (requestedConversations.size > 0) {
    // `rows` is already ordered newest-first, so the first non-cancelled order
    // per conversation is the one the request most likely refers to.
    const flagged = new Set<string>();
    for (const row of rows) {
      if (
        row.conversation_id &&
        requestedConversations.has(row.conversation_id) &&
        row.status !== "cancelled" &&
        !flagged.has(row.conversation_id)
      ) {
        row.cancellationRequested = true;
        flagged.add(row.conversation_id);
      }
    }
  }

  return Response.json(rows);
}
