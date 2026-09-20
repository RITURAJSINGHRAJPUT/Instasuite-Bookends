import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { getAiStatus } from "@/lib/ai";

// Is the agent actually able to reply right now, and if not, what did the API say?
//
// This exists because on 20 Sep replies stopped for over an hour and the reason — "You have
// reached your specified API usage limits. You will regain access on 2026-10-01" — was sitting
// in a console.warn on the server where nobody could see it. Staff answered 62 messages by hand
// without knowing why the agent had gone quiet. The Inbox polls this and shows a banner.
//
// Gated on "inbox" rather than "admin": the people who need to know are the ones watching the
// conversations. Read-only, and reports in-process state, so it costs nothing.

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "inbox")) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json(getAiStatus());
}
