import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";

// The single outbound path: send to Instagram, then mirror what was ACTUALLY
// delivered into the transcript.
//
// Every call site used to inline "send, then insert a row with
// `sendResult?.message_id ?? null`". That swallowed failures — a rejected send
// still produced a row, so the Inbox showed a message the guest never got, and
// the AI's own history counted it as said (so it would never repeat it).
// Storing is now conditional on delivery, in one place.

export type SendAndStoreResult = {
  ok: boolean;
  error?: { message: string; code?: number };
  /**
   * created_at of the LAST stored part, straight from the database. Callers use it
   * as the context_reset_at boundary; taking it from the DB rather than the app
   * clock keeps that cut exact regardless of app-vs-DB skew.
   */
  lastCreatedAt: string | null;
  /** Parts Meta accepted — greater than 1 when a long reply was split. */
  sentParts: number;
};

export async function sendAndStore({
  conversationId,
  igsid,
  text,
  accessToken,
}: {
  /** Null when there is no transcript to mirror into (e.g. the chat was deleted). */
  conversationId: string | null;
  igsid: string;
  text: string;
  accessToken: string;
}): Promise<SendAndStoreResult> {
  const result = await sendInstagramMessage(igsid, text, accessToken);

  let lastCreatedAt: string | null = null;

  if (conversationId) {
    // One row per delivered part, each carrying its own mid so the webhook's later
    // echo of it is recognized as ours and deduped (see processEcho). Inserted one
    // at a time on purpose: a single multi-row insert stamps every row with the same
    // now(), leaving the parts' order ambiguous to the history query, which sorts by
    // created_at. Parts are almost always 1, so this is a single round trip in practice.
    for (const part of result.parts) {
      const { data } = await supabaseAdmin
        .from("instagram_messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: part.text,
          instagram_msg_id: part.messageId,
        })
        .select("created_at")
        .single<{ created_at: string }>();
      if (data?.created_at) lastCreatedAt = data.created_at;
    }

    if (result.parts.length) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    }
  }

  return {
    ok: result.ok,
    error: result.error,
    lastCreatedAt,
    sentParts: result.parts.length,
  };
}
