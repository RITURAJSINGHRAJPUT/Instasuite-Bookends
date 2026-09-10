import { randomInt } from "node:crypto";
import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabase";

// Set a temporary password for an existing user, and require them to replace it.
//
// Why a password and not a link: every recovery/invite link is currently dead. Supabase's
// Redirect URL allowlist doesn't contain /auth/reset, so it silently rewrites `redirect_to`
// to the Site URL — the one-time token gets spent by the redirect and the person lands on
// the marketing page with an unread #access_token in the address bar. Password sign-in
// involves no redirect at all, so it works regardless of that setting.
//
// The trade-off is real and deliberate: this password travels in plaintext over whatever
// channel the admin uses, and it replaces whatever the account had before. That is exactly
// why must_change_password is set alongside it — see the guard in src/proxy.ts. The
// exposure is meant to last one sign-in.

// No look-alikes: O/0, I/l/1 are indistinguishable in most fonts and this gets retyped by
// hand off a WhatsApp message. randomInt is CSPRNG-backed — Math.random must never pick a
// credential.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** e.g. "Kf7m-Qp2R-9tLw" — ~15 chars, groups of 4, readable aloud and quick to type. */
function readablePassword(): string {
  const pick = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}-${pick()}`;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  // 404 on both counts, so this never confirms an account exists to someone who isn't
  // allowed to manage users. Same posture as the sibling PATCH/DELETE.
  if (!session || !can(session.role, "users")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, email")
    .eq("id", id)
    .maybeSingle<{ id: string; email: string | null }>();
  if (!target) return Response.json({ error: "Not found" }, { status: 404 });

  // Read the current metadata and spread it, rather than trusting the admin API to merge.
  // Whether it merges or replaces, writing the full object is correct — and it can't
  // silently drop a key some later feature put there.
  const { data: existing, error: readErr } = await supabaseAdmin.auth.admin.getUserById(id);
  if (readErr || !existing?.user) {
    return Response.json({ error: readErr?.message ?? "That account no longer exists." }, { status: 404 });
  }

  const password = readablePassword();
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(id, {
    password,
    user_metadata: { ...(existing.user.user_metadata ?? {}), must_change_password: true },
  });
  if (updateErr) {
    return Response.json({ error: updateErr.message }, { status: 500 });
  }

  // Not optional: this sets someone else's credential. Who did it, and to whom, is on the
  // record. The password itself is never logged.
  await logAudit(session, {
    action: "user.temp_password",
    targetType: "user",
    targetId: target.id,
    targetLabel: target.email,
  });

  return Response.json({ temp_password: password, email: target.email });
}
