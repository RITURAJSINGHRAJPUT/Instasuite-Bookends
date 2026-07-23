import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext, getOwnedConversation } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendInstagramMessage } from "@/lib/instagram";

// Confirm an order: mark it confirmed AND DM the customer a confirmation. Reuses the same
// path the manual-send route uses — getOwnedConversation for ownership + the igsid, then
// resolveAccountByIgId for the account's token to send FROM.

function confirmationText(kind: string, details: string): string {
  const d = details?.trim() ? ` ${details.trim()}.` : "";
  return kind === "reservation"
    ? `✅ Your reservation is confirmed!${d} We look forward to welcoming you — see you soon!`
    : `✅ Your order is confirmed!${d} We'll have it ready — see you at pickup!`;
}

export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, kind, details, status, conversation_id")
    .eq("id", id)
    .maybeSingle<{ id: string; kind: string; details: string; status: string; conversation_id: string }>();
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  // Ownership + the conversation (igsid + account) in one call.
  const conversation = await getOwnedConversation(order.conversation_id, ctx);
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

  // Idempotent: already confirmed → don't re-send the DM.
  if (order.status === "confirmed") {
    return Response.json({ id: order.id, status: "confirmed", already: true });
  }

  // Resolve the account this conversation belongs to, to send the reply FROM it.
  const { data: acc } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", conversation.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();
  const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
  if (!resolved) {
    return Response.json({ error: "Instagram account unavailable" }, { status: 502 });
  }

  const message = confirmationText(order.kind, order.details);
  await sendInstagramMessage(conversation.igsid, message, resolved.accessToken);

  // Record the confirmation in the transcript so it shows in the Inbox.
  await supabaseAdmin.from("instagram_messages").insert({
    conversation_id: order.conversation_id,
    role: "assistant",
    content: message,
  });
  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", order.conversation_id);

  const { data: updated, error } = await supabaseAdmin
    .from("orders")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, status, confirmed_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(updated);
}
