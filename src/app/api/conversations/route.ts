import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox")) return Response.json({ error: "Not found" }, { status: 404 });

  // The two response shapes differ, so every early return has to honour the mode
  // or a caller asking for a count gets an array and reads `undefined`.
  const wantCount = request.nextUrl.searchParams.get("count") === "1";
  const empty = () => Response.json(wantCount ? { count: 0 } : []);

  if (ctx.accountIds.length === 0) return empty();

  // Optional account filter for the dashboard switcher. It can only NARROW
  // within the caller's own accounts — a foreign id intersects to nothing
  // rather than widening the scope.
  const requested = request.nextUrl.searchParams.get("account_id");
  const scope = requested
    ? ctx.accountIds.filter((id) => id === requested)
    : ctx.accountIds;
  if (scope.length === 0) return empty();

  // ?count=1 returns just the total. The dashboard needs a single integer for a
  // stat card, and without this it pulled every conversation row AND ran the
  // per-conversation last-message query below for each one — N+1 round trips to
  // render one number.
  if (wantCount) {
    const { count, error: countError } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id", { count: "exact", head: true })
      .in("instagram_account_id", scope);

    if (countError) return Response.json({ error: countError.message }, { status: 500 });
    return Response.json({ count: count ?? 0 });
  }

  // Scoped to the caller's Instagram accounts — previously this returned EVERY
  // conversation in the database.
  const { data: conversations, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select("*")
    .in("instagram_account_id", scope)
    .order("updated_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Latest order per conversation, for the Inbox's Ongoing/Completed split. One query for
  // all conversations (not N+1); orders is service-role only, read here via supabaseAdmin.
  const convoIds = (conversations || []).map((c) => c.id);
  const latestOrder = new Map<string, { kind: string; scheduled_at: string | null; status: string }>();
  if (convoIds.length) {
    const { data: orders } = await supabaseAdmin
      .from("orders")
      .select("conversation_id, kind, scheduled_at, status, created_at")
      .in("conversation_id", convoIds)
      .order("created_at", { ascending: false });
    for (const o of orders ?? []) {
      // First seen per conversation = the most recent (query is created_at desc).
      const id = o.conversation_id as string;
      if (!latestOrder.has(id)) {
        latestOrder.set(id, { kind: o.kind, scheduled_at: o.scheduled_at, status: o.status });
      }
    }
  }

  // Last message per conversation, in ONE query — same shape as the latestOrder map above.
  // This used to run a query per conversation inside Promise.all: an Inbox with 23 chats fired
  // 24 round trips, and it re-ran on every Realtime event. Newest-first, so the first row seen
  // for a conversation is its latest.
  const lastMessage = new Map<string, string>();
  if (convoIds.length) {
    const { data: messages } = await supabaseAdmin
      .from("instagram_messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", convoIds)
      .order("created_at", { ascending: false });
    for (const m of messages ?? []) {
      const id = m.conversation_id as string;
      if (!lastMessage.has(id)) lastMessage.set(id, m.content as string);
    }
  }

  const withLastMessage = (conversations || []).map((convo) => ({
    ...convo,
    last_message: lastMessage.get(convo.id) ?? null,
    order: latestOrder.get(convo.id) ?? null,
  }));

  return Response.json(withLastMessage);
}
