import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendAndStore } from "@/lib/outbound";
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

  const sent = await sendAndStore({
    conversationId: id,
    igsid: conversation.igsid,
    text: message.trim(),
    accessToken: resolved.accessToken,
  });

  // Report the failure instead of storing the message: a row here would show staff
  // their reply in the thread as though the guest had received it.
  if (!sent.ok) {
    return Response.json(
      { error: sent.error?.message || "Instagram rejected the message." },
      { status: 502 }
    );
  }

  return Response.json({ ok: true, parts: sent.sentParts });
}
