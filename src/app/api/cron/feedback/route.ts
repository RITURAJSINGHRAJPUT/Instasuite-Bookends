import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { runFeedbackSweep } from "@/lib/feedback-run";

// Post-dining feedback DMs. The logic lives in src/lib/feedback-run.ts because it has a
// second caller: the webhook runs the same sweep off real inbound traffic, so a thank-you
// still goes out on time when this cron doesn't fire — which it often didn't (5 of 12 days).
// This route stays as the scheduled path and for manual runs.
//
// Schedule every ~10-15 min with `Authorization: Bearer $CRON_SECRET` (a super_admin session
// is also accepted). Mirrors /api/cron/refresh-tokens; /api/cron/* bypasses the proxy matcher.
//
// No `limit`: the cron drains everything due, unlike the webhook path which caps itself so a
// backlog can't eat the budget a guest's AI reply depends on.

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

  try {
    return Response.json(await runFeedbackSweep());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
