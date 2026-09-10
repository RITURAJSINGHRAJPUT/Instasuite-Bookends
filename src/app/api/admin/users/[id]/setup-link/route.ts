import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabase";

// Mint a fresh password-setup link for an existing user, on demand.
//
// Why this exists: onboarding used to depend entirely on an email arriving and being
// clicked within the hour. Recovery tokens are single-use and short-lived, and mail
// scanners (Gmail/Outlook safe-link prefetch) routinely GET the URL on delivery, which
// SPENDS the token before the human ever clicks — they then see "this link is invalid or
// has expired" and there was no way to recover. The copyable link on the create screen
// only appeared when Supabase *reported* a send failure, so a mail that was accepted and
// then silently lost left the admin with nothing.
//
// generateLink does NOT send mail; it only mints the token. That's the point — the admin
// hands the link over directly, so no mail server and no scanner sits between the person
// and their password.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  // 404 rather than 401/403 on both counts, so this never confirms an account exists to
  // someone who isn't allowed to manage users. Same posture as the sibling PATCH/DELETE.
  if (!session || !can(session.role, "users")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, email")
    .eq("id", id)
    .maybeSingle<{ id: string; email: string | null }>();
  if (!target) return Response.json({ error: "Not found" }, { status: 404 });
  if (!target.email) {
    return Response.json({ error: "That account has no email address to build a link for." }, { status: 422 });
  }

  // Same origin the create route uses, deliberately — NOT NEXT_PUBLIC_APP_URL, which is
  // http://localhost:3000 in .env.local and would hand out a dead link in production.
  // The redirect target must be in Supabase's Redirect URL allowlist or Supabase quietly
  // falls back to the Site URL and drops the user on the site root instead of the form.
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: target.email,
    options: { redirectTo: `${request.nextUrl.origin}/auth/reset` },
  });

  const setupLink = data?.properties?.action_link ?? null;
  if (error || !setupLink) {
    return Response.json(
      { error: error?.message ?? "Could not generate a setup link." },
      { status: 500 }
    );
  }

  // Not optional: this mints a credential that sets someone else's password. Whoever did
  // it, and to whom, has to be on the record.
  await logAudit(session, {
    action: "user.setup_link",
    targetType: "user",
    targetId: target.id,
    targetLabel: target.email,
  });

  return Response.json({ setup_link: setupLink, email: target.email });
}
