import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { can, needsSubscription, ROLE_CAPABILITIES } from "@/lib/permissions";
import { supabaseAdmin } from "@/lib/supabase";
import { periodStart } from "@/lib/usage";

// User management — the strictest gate in the app (super_admin only, the `users`
// capability). Admins run the rest of /api/admin/* but cannot manage teammates.
//
// This is the first (and only) place in the codebase that creates an account —
// there is no signup, and users were previously hand-provisioned in the Supabase
// dashboard. Everything here goes through the service-role client, which is also
// what grants auth.admin.*.

const ROLES = Object.keys(ROLE_CAPABILITIES);

type ProfileRow = {
  id: string;
  email: string | null;
  role: string;
  created_at: string;
  subscriptions:
    | { status: string; current_period_end: string | null; plans: { name: string } | null }
    | null;
  businesses: {
    id: string;
    name: string;
    status: string;
    instagram_accounts: { id: string; username: string | null; status: string; token_expires_at: string | null }[];
  }[];
};

export async function GET() {
  const user = await getSessionUser();
  if (!user || !can(user.role, "users")) return Response.json({ error: "Not found" }, { status: 404 });

  // access_token is never selected — it's a tenant credential and has no business
  // reaching the browser, super-admin or not.
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select(
      "id, email, role, created_at, " +
        "subscriptions(status, current_period_end, plans(name)), " +
        "businesses(id, name, status, instagram_accounts(id, username, status, token_expires_at))"
    )
    .order("created_at", { ascending: true })
    .returns<ProfileRow[]>();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // last_sign_in_at / email_confirmed_at live on auth.users, not profiles, so they
  // only come from the admin API. Paginated — the default page is 50.
  const authById = new Map<string, { last_sign_in_at: string | null; email_confirmed_at: string | null }>();
  try {
    for (let page = 1; page <= 20; page++) {
      const { data: au, error: ae } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (ae || !au?.users?.length) break;
      for (const u of au.users) {
        authById.set(u.id, {
          last_sign_in_at: u.last_sign_in_at ?? null,
          email_confirmed_at: u.email_confirmed_at ?? null,
        });
      }
      if (au.users.length < 200) break;
    }
  } catch {
    // A listUsers failure shouldn't blank the page — the profile data is the
    // substance; sign-in metadata is a nice-to-have.
  }

  // One grouped query rather than getMonthlyUsage() per row (that would be N+1).
  const usage = new Map<string, { messages: number; costCents: number }>();
  const { data: events } = await supabaseAdmin
    .from("usage_events")
    .select("client_id, cost_cents")
    .gte("created_at", periodStart().toISOString());
  for (const e of events ?? []) {
    const id = e.client_id as string | null;
    if (!id) continue; // orphaned by ON DELETE SET NULL — belongs to a deleted user
    const row = usage.get(id) ?? { messages: 0, costCents: 0 };
    row.messages++;
    row.costCents += Number(e.cost_cents ?? 0);
    usage.set(id, row);
  }

  return Response.json(
    (data ?? []).map((p) => {
      const accounts = (p.businesses ?? []).flatMap((b) => b.instagram_accounts ?? []);
      const u = usage.get(p.id) ?? { messages: 0, costCents: 0 };
      return {
        id: p.id,
        email: p.email,
        role: p.role,
        // Saves the client a second round-trip to work out which row is its own —
        // the session is already resolved here. The guards don't depend on this;
        // they re-check server-side.
        is_self: p.id === user.id,
        created_at: p.created_at,
        last_sign_in_at: authById.get(p.id)?.last_sign_in_at ?? null,
        email_confirmed_at: authById.get(p.id)?.email_confirmed_at ?? null,
        subscription: p.subscriptions
          ? {
              status: p.subscriptions.status,
              current_period_end: p.subscriptions.current_period_end,
              plan_name: p.subscriptions.plans?.name ?? null,
            }
          : null,
        businesses: (p.businesses ?? []).map((b) => ({
          id: b.id,
          name: b.name,
          status: b.status,
          accounts: (b.instagram_accounts ?? []).map((a) => ({
            id: a.id,
            username: a.username,
            status: a.status,
            token_expires_at: a.token_expires_at,
          })),
        })),
        counts: { businesses: (p.businesses ?? []).length, accounts: accounts.length },
        usage: u,
      };
    })
  );
}

export async function POST(request: NextRequest) {
  const session = await getSessionUser();
  if (!session || !can(session.role, "users")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? "").trim().toLowerCase();
  const role = String(body?.role ?? "client");
  const planId = String(body?.plan_id ?? "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return Response.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (!ROLES.includes(role)) {
    return Response.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 400 });
  }
  // super_admin is bootstrapped directly in the database (see README), never
  // through this endpoint — there's only meant to be one at a time.
  if (role === "super_admin") {
    return Response.json(
      { error: "Super admin can't be assigned here — it's provisioned directly in the database." },
      { status: 400 }
    );
  }

  // A subscription (plan) is only meaningful for a `client` tenant — metering keys
  // off the account owner, and staff run the operator's account, not their own.
  // So a plan is required only for `client`, and skipped entirely for staff.
  const wantsSubscription = needsSubscription(role);
  if (wantsSubscription) {
    if (!planId) return Response.json({ error: "A plan is required." }, { status: 400 });
    const { data: plan } = await supabaseAdmin.from("plans").select("id").eq("id", planId).maybeSingle();
    if (!plan) return Response.json({ error: "That plan doesn't exist." }, { status: 400 });
  }

  // THREE writes, and there is no auth.users trigger to create the profile for us.
  // A half-finished create is worse than a failed one: getSessionUser() defaults a
  // profile-less account to role "client" (supabase-server.ts:58), so the ghost
  // would get a working session instead of an error. Every failure below therefore
  // deletes the auth user again before returning.
  const password = randomBytes(32).toString("base64url"); // discarded; never returned or logged
  const { data: created, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authErr || !created?.user) {
    const msg = authErr?.message ?? "Could not create the account.";
    const dupe = /already|exists|registered/i.test(msg);
    return Response.json({ error: dupe ? "That email already has an account." : msg }, { status: dupe ? 409 : 500 });
  }

  const userId = created.user.id;

  async function rollback(reason: string, status = 500) {
    await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
    return Response.json({ error: reason }, { status });
  }

  const { error: profileErr } = await supabaseAdmin
    .from("profiles")
    .insert({ id: userId, email, role });
  if (profileErr) return rollback(`Could not create the profile: ${profileErr.message}`);

  // client_id is UNIQUE — one subscription per client, so this is an insert, never
  // a second row. Without it checkMessageQuota fails closed and the agent would
  // silently never reply. Staff have no subscription (their replies are metered on
  // the operator's account), so this is skipped for them.
  if (wantsSubscription) {
    const { error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .insert({ client_id: userId, plan_id: planId, status: "active" });
    if (subErr) return rollback(`Could not create the subscription: ${subErr.message}`);
  }

  // A recovery link rather than a password: nothing secret is ever shown to the
  // super-admin or typed into a form. Same shape as "Forgot password?" on /login.
  //
  // Send it by email, and only fall back to displaying a copyable link if that
  // fails. These two calls CANNOT both run: each mints a recovery token and the
  // newer one invalidates the older, so doing both would either show a dead link
  // or email a token the displayed link just killed. One token per path.
  //
  // The fallback is load-bearing, not decorative: Supabase enforces a per-user
  // send interval (60s) and an hourly cap, so a throttled send must still leave
  // the admin a way to onboard someone.
  const origin = request.nextUrl.origin;
  let setupLink: string | null = null;
  let emailed = false;
  let emailError: string | null = null;

  const { error: sendErr } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/reset`,
  });

  if (!sendErr) {
    emailed = true;
  } else {
    emailError = sendErr.message;
    const { data: link, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: `${origin}/auth/reset` },
    });
    if (!linkErr) setupLink = link?.properties?.action_link ?? null;
  }

  // 201 even if the email and the link both failed — the account is real at this
  // point, and rolling back a valid user over a delivery problem is worse. Say
  // what happened instead.
  return Response.json(
    {
      id: userId,
      email,
      role,
      emailed,
      setup_link: setupLink,
      note: emailed
        ? null
        : setupLink
          ? `Couldn't email them (${emailError}). Send this link instead.`
          : "Account created, but neither the email nor a setup link could be generated. Ask them to use “Forgot password?” on the sign-in page.",
    },
    { status: 201 }
  );
}
