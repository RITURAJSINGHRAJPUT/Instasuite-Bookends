import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/supabase-server";

// Hand every parked conversation back to the AI once a day, at midnight IST.
//
// Chats reach human mode from five places — an AI outage, a flagged review, an undelivered
// reply, an order awaiting confirmation, and (with no reason recorded) any time staff answer
// from the Instagram phone app, which processEcho catches. Without a sweep they accumulate
// until someone presses "All back to AI" by hand.
//
// EXCEPT a flagged review. A complaint or collab that a person is part-way through answering
// must not be taken over by the AI overnight — that is the one handoff reason where the
// human is mid-conversation rather than merely owed an action.
//
// It DOES re-arm threads parked as awaiting_confirmation, and that is a quiet improvement:
// two guests once sat silenced for 25 hours, past their own reservation times, because
// nobody pressed Confirm. Their order stays pending either way — only the silence lifts.
//
// Schedule daily at 18:30 UTC (= 00:00 IST) with `Authorization: Bearer $CRON_SECRET`; a
// super_admin session is also accepted for manual runs. Unlike the feedback sweep this stays
// purely scheduled: a missed night costs nothing and the Inbox button is still there, whereas
// a missed feedback DM expires with Instagram's 24h window.

function authorized(request: NextRequest, isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail CLOSED: no secret configured => no anonymous access
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser().catch(() => null);
  if (!authorized(request, user?.role === "super_admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // `or` rather than a plain neq: a NULL reason is the phone-reply case, and in SQL
  // `human_handoff_reason <> 'review'` is NULL — not true — for those rows, so a bare neq
  // would silently skip exactly the chats most in need of handing back.
  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .update({ mode: "agent", human_handoff_reason: null })
    .eq("mode", "human")
    .or("human_handoff_reason.is.null,human_handoff_reason.neq.review")
    .select("id");

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const handedBack = data?.length ?? 0;
  if (handedBack > 0) console.log(`Nightly handback: ${handedBack} conversation(s) returned to the AI.`);

  return Response.json({ handedBack });
}
