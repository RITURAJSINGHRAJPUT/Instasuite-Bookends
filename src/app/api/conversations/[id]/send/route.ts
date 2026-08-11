import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";
import { getContext, getOwnedConversation } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { resolveAccountByIgId } from "@/lib/tenant";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox")) return Response.json({ error: "Not found" }, { status: 404 });

  const { message } = await request.json();
  if (!message?.trim()) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  const conversation = await getOwnedConversation(id, ctx);
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

  // Reply FROM the account this conversation belongs to — never a global token.
  const { data: account } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", conversation.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();

  const resolved = account && (await resolveAccountByIgId(account.ig_account_id));
  if (!resolved) {
    return Response.json({ error: "Instagram account unavailable" }, { status: 502 });
  }

  const sendResult = await sendInstagramMessage(conversation.igsid, message.trim(), resolved.accessToken);

  const { data, error } = await supabaseAdmin
    .from("instagram_messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: message.trim(),
      // Recorded so the webhook's later echo of this same send is recognized as
      // ours and deduped instead of appearing as a second message.
      instagram_msg_id: sendResult?.message_id ?? null,
    })
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return Response.json(data);
}
