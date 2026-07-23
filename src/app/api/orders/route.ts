import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";

// The Orders page's data source — real captured reservations/takeaways (the `orders`
// ledger), scoped to the caller's accounts. Reads via the service-role client (orders has
// RLS-on/no-policy), so scoping is enforced in-query by the conversation's account.

type Joined = {
  id: string;
  kind: string;
  customer_name: string | null;
  details: string;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  instagram_conversations:
    | { instagram_account_id: string; instagram_accounts: { username: string | null } | { username: string | null }[] | null }
    | { instagram_account_id: string; instagram_accounts: { username: string | null } | { username: string | null }[] | null }[]
    | null;
};

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });
  if (ctx.accountIds.length === 0) return Response.json([]);

  // Scope to the caller's accounts via the order's conversation (staff = all, client = own)
  // — the same predicate getOwnedConversation uses. The nested embed also gives the account
  // username for the page's per-account filter.
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id, kind, customer_name, details, status, created_at, confirmed_at, instagram_conversations!inner(instagram_account_id, instagram_accounts(username))"
    )
    .in("instagram_conversations.instagram_account_id", ctx.accountIds)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = ((data ?? []) as unknown as Joined[]).map((r) => {
    const conv = Array.isArray(r.instagram_conversations)
      ? r.instagram_conversations[0]
      : r.instagram_conversations;
    const acc = conv?.instagram_accounts;
    const accObj = Array.isArray(acc) ? acc[0] : acc;
    return {
      id: r.id,
      kind: r.kind,
      customer_name: r.customer_name,
      details: r.details,
      status: r.status,
      created_at: r.created_at,
      confirmed_at: r.confirmed_at,
      account_id: conv?.instagram_account_id ?? null,
      account_username: accObj?.username ?? null,
    };
  });

  return Response.json(rows);
}
