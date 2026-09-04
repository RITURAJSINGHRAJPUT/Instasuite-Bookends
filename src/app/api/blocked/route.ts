import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { normalizeHandle, invalidateBlocklistCache } from "@/lib/blocklist";

// The global do-not-reply list. Unlike /api/quick-replies and /api/unavailable there is
// no ownsBusiness check here — the list isn't scoped to a business, so there is nothing
// to own. The gate is the capability alone, which EVERY role has (see permissions.ts).

type JoinedRow = {
  id: string;
  username: string;
  reason: string | null;
  created_at: string;
  profiles: { email: string | null } | { email: string | null }[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? v[0] ?? null : v;
}

export async function GET() {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "blocked")) return Response.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("blocked_users")
    .select("id, username, reason, created_at, profiles(email)")
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = ((data ?? []) as unknown as JoinedRow[]).map((r) => ({
    id: r.id,
    username: r.username,
    reason: r.reason,
    created_at: r.created_at,
    // Anyone can add here, so showing WHO did matters more than it does elsewhere.
    created_by_email: one(r.profiles)?.email ?? null,
  }));

  return Response.json(rows);
}

export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "blocked")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  // Same normalization the webhook's lookup uses — this is the whole reason it lives in
  // one exported function rather than being re-implemented per call site.
  const username = normalizeHandle(String(body?.username ?? ""));
  const reason = String(body?.reason ?? "").trim();

  if (!username) return Response.json({ error: "A username is required" }, { status: 400 });
  // Instagram handles: letters, digits, underscores and periods, max 30.
  if (!/^[a-z0-9._]{1,30}$/.test(username)) {
    return Response.json({ error: "That doesn't look like an Instagram username." }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("blocked_users")
    .insert({ username, reason: reason || null, created_by: ctx.user.id })
    .select("id, username, reason, created_at")
    .single();

  if (error) {
    // Already blocked is the desired end state, not a failure — the operator asked for
    // this handle to be silenced and it is. Return the existing row so the UI just shows it.
    if (error.code === "23505") {
      const { data: existing } = await supabaseAdmin
        .from("blocked_users")
        .select("id, username, reason, created_at")
        .eq("username", username)
        .maybeSingle();
      return Response.json(existing, { status: 200 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Take effect now rather than whenever the 60s TTL happens to lapse.
  invalidateBlocklistCache();

  await logAudit(ctx.user, {
    action: "blocked_user.create",
    targetType: "blocked_user",
    targetId: data.id,
    targetLabel: `@${data.username}`,
  });

  return Response.json(data, { status: 201 });
}
