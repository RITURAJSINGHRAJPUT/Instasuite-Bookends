import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { supabaseAdmin } from "@/lib/supabase";

// Per-account totals for the Overview "By account" cards.
//
// All-time totals, scoped by ctx.accountIds — the same set getContext resolves for
// every user-driven route, so this can only ever return the caller's own accounts.
//
// Reservations and takeaway orders come from the `orders` ledger (captured from the AI's
// handoff line — see src/lib/order-detect.ts), attributed to an account via each order's
// conversation. Same source the /orders page uses, so these counts match it.

type Stat = {
  conversations: number;
  human_handled: number;
  ai_replies: number;
  cost_cents: number;
  last_activity: string | null;
  takeaway_orders: number;
  reservations: number;
  orders: { customer: string; summary: string; at: string }[];
  reservation_list: { customer: string; detail: string; at: string }[];
};

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "overview")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (ctx.accountIds.length === 0) return Response.json([]);

  const ids = ctx.accountIds;

  const [accountsRes, convRes, usageRes, ordersRes] = await Promise.all([
    supabaseAdmin.from("instagram_accounts").select("id, username, name, status").in("id", ids),
    supabaseAdmin
      .from("instagram_conversations")
      .select("instagram_account_id, mode, updated_at")
      .in("instagram_account_id", ids),
    supabaseAdmin
      .from("usage_events")
      .select("instagram_account_id, cost_cents")
      .eq("kind", "ai_reply")
      .in("instagram_account_id", ids),
    // Captured orders/reservations for these accounts, via each order's conversation.
    // !inner turns the embed into a real join so the account filter actually restricts.
    supabaseAdmin
      .from("orders")
      .select("kind, customer_name, details, created_at, instagram_conversations!inner(instagram_account_id)")
      .in("instagram_conversations.instagram_account_id", ids),
  ]);

  if (accountsRes.error) {
    return Response.json({ error: accountsRes.error.message }, { status: 500 });
  }

  const stats = new Map<string, Stat>();
  for (const id of ids) {
    stats.set(id, {
      conversations: 0,
      human_handled: 0,
      ai_replies: 0,
      cost_cents: 0,
      last_activity: null,
      takeaway_orders: 0,
      reservations: 0,
      orders: [],
      reservation_list: [],
    });
  }

  for (const c of convRes.data ?? []) {
    const s = stats.get(c.instagram_account_id as string);
    if (!s) continue;
    s.conversations++;
    if (c.mode === "human") s.human_handled++;
    const ts = c.updated_at as string;
    if (ts && (!s.last_activity || ts > s.last_activity)) s.last_activity = ts;
  }

  for (const e of usageRes.data ?? []) {
    const s = stats.get(e.instagram_account_id as string);
    if (!s) continue;
    s.ai_replies++;
    s.cost_cents += Number(e.cost_cents ?? 0);
  }

  // Tally captured orders per account (already deduped at capture time by orders.dedupe_key).
  // Supabase types an !inner embed as array-or-object, so read the conversation defensively.
  type OrderRow = {
    kind: string;
    customer_name: string | null;
    details: string;
    created_at: string;
    instagram_conversations:
      | { instagram_account_id: string }
      | { instagram_account_id: string }[];
  };

  for (const o of (ordersRes.data ?? []) as OrderRow[]) {
    const conv = Array.isArray(o.instagram_conversations)
      ? o.instagram_conversations[0]
      : o.instagram_conversations;
    if (!conv) continue;
    const s = stats.get(conv.instagram_account_id);
    if (!s) continue;
    const customer = o.customer_name || "Guest";
    if (o.kind === "takeaway") {
      s.takeaway_orders++;
      s.orders.push({ customer, summary: o.details, at: o.created_at });
    } else if (o.kind === "reservation") {
      s.reservations++;
      s.reservation_list.push({ customer, detail: o.details, at: o.created_at });
    }
  }

  type Account = { id: string; username: string | null; name: string | null; status: string };
  return Response.json(
    ((accountsRes.data ?? []) as Account[])
      .map((a) => {
        const s = stats.get(a.id)!;
        return {
          account_id: a.id,
          username: a.username,
          name: a.name,
          status: a.status,
          ...s,
        };
      })
      // Busiest first, matching the sibling analytics routes' ordering.
      .sort((a, b) => b.conversations - a.conversations)
  );
}
