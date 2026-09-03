import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendAndStore } from "@/lib/outbound";
import { logAudit } from "@/lib/audit";
import { COLLAB_DECLINE } from "@/lib/review-responses";

// Send the standing collaboration decline to a review item's guest, then close the
// item. Driven by the "Send collab decline" button on the Review page.
//
// Mirrors orders/[id]/confirm: ownership comes from the row's OWN snapshotted
// instagram_account_id (not the conversation), and the sending token is resolved
// from that same account — so it keeps working regardless of which chat it came from.

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "review")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: item } = await supabaseAdmin
    .from("review_items")
    .select("id, status, category, igsid, instagram_account_id, conversation_id, customer_name")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      status: string;
      category: string;
      igsid: string | null;
      instagram_account_id: string | null;
      conversation_id: string | null;
      customer_name: string | null;
    }>();
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });

  if (!item.instagram_account_id || !ctx.accountIds.includes(item.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotent: two staff clicking at once (or a double-click) must not DM the guest
  // twice. Anything already terminal returns without sending.
  if (item.status !== "pending") {
    return Response.json({ id: item.id, status: item.status, already: true });
  }

  if (!item.igsid) {
    return Response.json({ error: "This item has no saved recipient to message." }, { status: 422 });
  }

  const { data: acc } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", item.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();
  const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
  if (!resolved) {
    return Response.json({ error: "Instagram account unavailable" }, { status: 502 });
  }

  const sent = await sendAndStore({
    conversationId: item.conversation_id,
    igsid: item.igsid,
    text: COLLAB_DECLINE,
    accessToken: resolved.accessToken,
  });

  // Leave the item PENDING on failure. Marking it done when the guest never received
  // anything is the same silent-failure class as a message stored but never delivered
  // — staff would see a handled item and the sender would still be waiting.
  if (!sent.ok) {
    return Response.json(
      { error: sent.error?.message || "Instagram rejected the message." },
      { status: 502 }
    );
  }

  const { data: updated, error } = await supabaseAdmin
    .from("review_items")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, status, completed_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(ctx.user, {
    action: "review.respond",
    targetType: "review_item",
    targetId: id,
    targetLabel: item.customer_name
      ? `${item.category} — ${item.customer_name}`
      : item.category,
  });

  return Response.json(updated);
}
