import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

// Hand EVERY human-mode conversation on one account back to the AI in a single click.
//
// Chats land in human mode from five places — an AI outage, a flagged review, an
// undelivered reply, an order awaiting confirmation, and (with no reason recorded at all)
// any time staff answer from the Instagram phone app, which processEcho catches. Clearing
// them one at a time through the header's per-chat "Back to AI" was the only way out.
//
// DELIBERATELY UNCONDITIONAL: this re-arms the AI even on threads parked for an open
// complaint or an unconfirmed order, which is exactly what the confirm route refuses to do
// (its `.eq("human_handoff_reason", "awaiting_confirmation")` guard exists so confirming an
// order can't silently re-arm a thread handed over for some other reason). That override is
// the requested behaviour, not an oversight. The response returns a count so the blast
// radius is at least visible to whoever pressed it.
//
// Gated on "inbox", not "businesses": this is the bulk form of the per-conversation toggle
// in /api/conversations/[id], and the button lives in the Inbox — which agents and managers
// can open. Gating on "businesses" would show them a control that 404s.

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox")) return Response.json({ error: "Not found" }, { status: 404 });

  // Never trust the UUID in the URL — the account must be one this caller can act on.
  // 404 rather than 403, so a wrong id can't confirm that someone else's account exists.
  if (!ctx.accountIds.includes(id)) return Response.json({ error: "Not found" }, { status: 404 });

  // One statement, no read-then-write. `eq("mode", "human")` both scopes the write to the
  // rows that need it and makes the returned row count an exact answer to "how many did
  // this actually change" — an unfiltered update would report every conversation.
  //
  // human_handoff_reason is cleared alongside, mirroring the single-chat toggle: a stale
  // reason must not outlive the human episode it described.
  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .update({ mode: "agent", human_handoff_reason: null })
    .eq("instagram_account_id", id)
    .eq("mode", "human")
    .select("id");

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const count = data?.length ?? 0;

  // Nothing to hand back is a success, not an error — but it isn't worth an audit row.
  if (count === 0) return Response.json({ count: 0 });

  const { data: account } = await supabaseAdmin
    .from("instagram_accounts")
    .select("username")
    .eq("id", id)
    .maybeSingle<{ username: string | null }>();

  // ONE row for the whole batch, not one per conversation — a bulk click that buried the
  // Activity log under 40 identical entries would make the log useless for finding
  // anything else that happened that minute.
  await logAudit(ctx.user, {
    action: "conversation.mode_agent_bulk",
    targetType: "instagram_account",
    targetId: id,
    targetLabel: account?.username ?? null,
  });

  return Response.json({ count });
}
