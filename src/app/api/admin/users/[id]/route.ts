import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { can, ROLE_CAPABILITIES } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabase";

const ROLES = Object.keys(ROLE_CAPABILITIES);
const SUB_STATUSES = ["trialing", "active", "past_due", "canceled"];

// Every guard here is enforced in the route, not the UI. The UI can only hide a
// button; a hand-crafted request is the threat model.

async function superAdminCount(): Promise<number> {
  const { count } = await supabaseAdmin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "super_admin");
  return count ?? 0;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session || !can(session.role, "users")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, email, role")
    .eq("id", id)
    .maybeSingle<{ id: string; email: string | null; role: string }>();
  if (!target) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);

  // ---- role -------------------------------------------------------------
  if (body?.role !== undefined) {
    const role = String(body.role);
    if (!ROLES.includes(role)) {
      return Response.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 400 });
    }
    // super_admin is bootstrapped directly in the database, never granted through
    // this endpoint — there's only meant to be one at a time. (Demoting the last
    // remaining one is still blocked below, separately.)
    if (role === "super_admin" && target.role !== "super_admin") {
      return Response.json(
        { error: "Super admin can't be granted here — it's provisioned directly in the database." },
        { status: 400 }
      );
    }
    if (target.id === session.id && role !== target.role) {
      return Response.json(
        { error: "You can't change your own role. Ask another super admin." },
        { status: 409 }
      );
    }
    // Losing the last super admin permanently bricks approvals: nothing in the app
    // can create one, so recovery would need direct SQL.
    if (target.role === "super_admin" && role !== "super_admin" && (await superAdminCount()) <= 1) {
      return Response.json(
        { error: "This is the only super admin. Promote someone else first." },
        { status: 409 }
      );
    }
    const { error } = await supabaseAdmin.from("profiles").update({ role }).eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
  }

  // ---- email ------------------------------------------------------------
  if (body?.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return Response.json({ error: "A valid email is required." }, { status: 400 });
    }
    // profiles.email is a denormalised copy of auth.users.email with nothing
    // syncing them, so both sides must be written or the two silently diverge.
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email });
    if (authErr) return Response.json({ error: authErr.message }, { status: 500 });
    const { error } = await supabaseAdmin.from("profiles").update({ email }).eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
  }

  // ---- plan / subscription status ---------------------------------------
  const subPatch: Record<string, unknown> = {};
  if (body?.plan_id !== undefined) {
    const planId = String(body.plan_id);
    const { data: plan } = await supabaseAdmin.from("plans").select("id").eq("id", planId).maybeSingle();
    if (!plan) return Response.json({ error: "That plan doesn't exist." }, { status: 400 });
    subPatch.plan_id = planId;
  }
  if (body?.subscription_status !== undefined) {
    const status = String(body.subscription_status);
    if (!SUB_STATUSES.includes(status)) {
      return Response.json(
        { error: `subscription_status must be one of ${SUB_STATUSES.join(", ")}` },
        { status: 400 }
      );
    }
    // "canceled" IS the suspend switch: checkMessageQuota (usage.ts:60) fails
    // closed on anything outside active/trialing, so replies stop immediately.
    subPatch.status = status;
  }
  if (Object.keys(subPatch).length > 0) {
    const { data: existing } = await supabaseAdmin
      .from("subscriptions")
      .select("id")
      .eq("client_id", id)
      .maybeSingle();
    if (existing) {
      const { error } = await supabaseAdmin.from("subscriptions").update(subPatch).eq("client_id", id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
    } else {
      if (!subPatch.plan_id) {
        return Response.json(
          { error: "This user has no subscription yet — assign a plan first." },
          { status: 400 }
        );
      }
      const { error } = await supabaseAdmin
        .from("subscriptions")
        .insert({ client_id: id, status: "active", ...subPatch });
      if (error) return Response.json({ error: error.message }, { status: 500 });
    }
  }

  if (body?.role === undefined && body?.email === undefined && Object.keys(subPatch).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: fresh } = await supabaseAdmin
    .from("profiles")
    .select("id, email, role")
    .eq("id", id)
    .maybeSingle<{ id: string; email: string | null; role: string }>();

  // A role change is the single most sensitive action in the app, so it gets its own
  // entry naming both roles rather than a generic "user.update".
  if (body?.role !== undefined && fresh && fresh.role !== target.role) {
    await logAudit(session, {
      action: "user.role_change",
      targetType: "user",
      targetId: id,
      targetLabel: `${target.email ?? id}: ${target.role} -> ${fresh.role}`,
    });
  } else {
    await logAudit(session, {
      action: "user.update",
      targetType: "user",
      targetId: id,
      targetLabel: fresh?.email ?? target.email,
    });
  }

  return Response.json(fresh);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session || !can(session.role, "users")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, email, role")
    .eq("id", id)
    .maybeSingle<{ id: string; email: string | null; role: string }>();
  if (!target) return Response.json({ error: "Not found" }, { status: 404 });

  if (target.id === session.id) {
    return Response.json({ error: "You can't delete your own account." }, { status: 409 });
  }
  if (target.role === "super_admin" && (await superAdminCount()) <= 1) {
    return Response.json(
      { error: "This is the only super admin. Promote someone else first." },
      { status: 409 }
    );
  }

  // Typed confirmation is enforced server-side too, so the dialog isn't the only
  // thing standing between a stray request and a destroyed tenant.
  const confirm = request.nextUrl.searchParams.get("confirm");
  if (!confirm || confirm.trim().toLowerCase() !== (target.email ?? "").toLowerCase()) {
    return Response.json(
      { error: "Confirmation does not match this user's email." },
      { status: 400 }
    );
  }

  // Count what's about to go, so the response can state it plainly.
  const { data: businesses } = await supabaseAdmin
    .from("businesses")
    .select("id, instagram_accounts(id)")
    .eq("client_id", id)
    .returns<{ id: string; instagram_accounts: { id: string }[] }[]>();
  const accountIds = (businesses ?? []).flatMap((b) => (b.instagram_accounts ?? []).map((a) => a.id));
  let conversations = 0;
  if (accountIds.length) {
    const { count } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id", { count: "exact", head: true })
      .in("instagram_account_id", accountIds);
    conversations = count ?? 0;
  }

  // Deleting the auth user is the ONLY correct delete: the FK runs
  // profiles.id -> auth.users(id) on delete cascade, one-way. Deleting the
  // profile row instead would leave a live, login-capable auth account.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // The deleted user's OWN audit rows survive this — actor_id is `on delete set
  // null` and the email/role are snapshotted per row, so their trail stays readable.
  // This entry records who removed them.
  await logAudit(session, {
    action: "user.delete",
    targetType: "user",
    targetId: id,
    targetLabel: target.email,
  });

  return Response.json({
    id,
    deleted: {
      businesses: (businesses ?? []).length,
      accounts: accountIds.length,
      conversations,
    },
  });
}
