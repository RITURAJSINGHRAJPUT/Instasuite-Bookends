import { NextResponse } from "next/server";

// Liveness ping — for the external keep-alive scheduler (cron-job.org) and Render's
// own health check.
//
// Why this exists rather than pinging /login: /login is a statically PRERENDERED page,
// served with `Cache-Control: s-maxage=31536000`. The CDN in front of the app can
// therefore answer it for a year without the request ever reaching this instance —
// exactly what a keep-alive must not do, since Render spins the instance down on
// inactivity and a sleeping instance drops Instagram webhooks.
//
// force-dynamic + no-store means every ping is executed HERE, on the instance, so it
// genuinely resets the idle timer.
//
// Deliberately does NOT touch Supabase. A keep-alive that 500s because the database
// blipped would fail the job and alert about the wrong thing while the app is fine;
// this answers one question only — "is this process up?".
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ok", time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
  );
}
