"use client";

import { useCallback, useEffect, useState } from "react";
import {
  UserPlus,
  ShieldCheck,
  User as UserIcon,
  Copy,
  Check,
  Loader2,
  Trash2,
  PauseCircle,
  PlayCircle,
  X,
  AlertTriangle,
} from "lucide-react";
import { tokenAge } from "@/lib/token-age";
import { ROLE_OPTIONS, needsSubscription, isStaff } from "@/lib/permissions";

type Account = { id: string; username: string | null; status: string; token_expires_at: string | null };
type Business = { id: string; name: string; status: string; accounts: Account[] };

type ManagedUser = {
  id: string;
  email: string | null;
  role: string;
  is_self: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  subscription: { status: string; current_period_end: string | null; plan_name: string | null } | null;
  businesses: Business[];
  counts: { businesses: number; accounts: number };
  usage: { messages: number; costCents: number };
};

type Plan = { id: string; name: string };

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

// Super admin isn't offered here — there's only ever meant to be one, hand-
// provisioned directly in the database (see README/ONBOARDING), not granted
// through this UI. ROLE_OPTIONS itself is untouched so the existing super
// admin's row still labels/describes correctly.
const ASSIGNABLE_ROLE_OPTIONS = ROLE_OPTIONS.filter((o) => o.role !== "super_admin");

export default function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("client");
  const [newPlan, setNewPlan] = useState("");
  const [created, setCreated] = useState<{
    email: string;
    emailed: boolean;
    setup_link: string | null;
    note: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const load = useCallback(async () => {
    // Fired together, not chained: plans never depended on the users response —
    // it was only awaited second because of statement order. /api/admin/users is
    // the slowest route in the app (it pages through auth.admin.listUsers), so
    // sequencing a second request behind it doubled this page's load for nothing.
    const [res, p] = await Promise.all([
      fetch("/api/admin/users"),
      fetch("/api/admin/plans"),
    ]);

    if (res.status === 404) {
      setDenied(true);
      setLoading(false);
      return;
    }
    if (res.ok) setUsers(await res.json());
    if (p.ok) {
      const list: Plan[] = await p.json();
      setPlans(list);
      setNewPlan((cur) => cur || list[0]?.id || "");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mutate(id: string, patch: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setBusy(false);
    // /admin's mutations ignore the response and just refetch; a silently-failed
    // role change or suspend is not acceptable here, so surface it.
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d?.error || "That change didn't go through.");
      return false;
    }
    await load();
    return true;
  }

  async function createUser() {
    if (!newEmail.trim() || busy) return;
    // A plan is only meaningful for a `client` tenant; staff aren't metered.
    const planRequired = needsSubscription(newRole);
    if (planRequired && !newPlan) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: newEmail.trim(),
        role: newRole,
        ...(planRequired ? { plan_id: newPlan } : {}),
      }),
    });
    setBusy(false);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d?.error || "Couldn't create that user.");
      return;
    }
    setCreated({
      email: d.email,
      emailed: !!d.emailed,
      setup_link: d.setup_link ?? null,
      note: d.note ?? null,
    });
    setNewEmail("");
    setAdding(false);
    load();
  }

  async function doDelete() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/admin/users/${deleteTarget.id}?confirm=${encodeURIComponent(confirmText.trim())}`,
      { method: "DELETE" }
    );
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d?.error || "Delete failed.");
      return;
    }
    setDeleteTarget(null);
    setConfirmText("");
    setSelected(null);
    load();
  }

  if (loading) return <p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>;

  // The API 404s for non-super-admins; mirror that rather than hinting the page exists.
  if (denied) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h1 className="text-sm font-semibold text-[var(--text-1)]">404 — Not found</h1>
          <a href="/dashboard" className="mt-2 inline-block text-xs text-[var(--text-4)] hover:text-[var(--text-2)]">
            ← Back to overview
          </a>
        </div>
      </div>
    );
  }

  const detail = users.find((u) => u.id === selected);
  const superAdmins = users.filter((u) => u.role === "super_admin").length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Users</h1>
          <p className="text-[13px] text-[var(--text-4)]">
            {users.length} account{users.length === 1 ? "" : "s"} · {superAdmins} super admin
            {superAdmins === 1 ? "" : "s"}
          </p>
        </div>
        <button
          onClick={() => {
            setAdding(true);
            setCreated(null);
            setError(null);
          }}
          className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2 text-[13px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          <UserPlus size={14} />
          Add user
        </button>
      </div>

      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--danger)]">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" />
          {error}
        </p>
      )}

      {/* Shown once, right after creation. Normally the account holder is emailed
          a link; the copy box only appears when that send failed, because the two
          paths mint competing recovery tokens and only one can be live. The link
          sets a password, so it's treated as a credential: copy-only, never
          persisted or re-displayed. */}
      {created && (
        <div className="mt-4 rounded-xl border border-[var(--ok)]/25 bg-[var(--ok-soft)] p-4">
          <p className="text-[13px] font-bold text-[var(--ok)]">Created {created.email}</p>
          {created.emailed ? (
            // "Sent" means the mail provider accepted it, not that it landed in an
            // inbox — so point at spam rather than promising delivery.
            <p className="mt-1 text-[11px] text-[var(--text-4)]">
              We&apos;ve emailed them a link to set their password. It expires in about an
              hour — worth telling them to check spam if it doesn&apos;t show up.
            </p>
          ) : created.setup_link ? (
            <>
              <p className="mt-1 text-[11px] text-[var(--text-4)]">
                {created.note ?? "Couldn't email them."} Send this one-time link instead —
                it isn&apos;t stored, so copy it now.
              </p>
              <div className="mt-2.5 flex gap-2">
                <input
                  readOnly
                  value={created.setup_link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 rounded-lg border border-[var(--border-strong)] bg-[var(--panel-bg)] px-3 py-2 font-mono text-[11px] text-[var(--text-2)]"
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(created.setup_link!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-[12px] font-bold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-[var(--text-4)]">{created.note}</p>
          )}
          <button
            onClick={() => setCreated(null)}
            className="mt-2.5 text-[11px] font-semibold text-[var(--text-4)] hover:text-[var(--text-2)]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Add form */}
      {adding && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-[var(--text-1)]">New user</h2>
            <button onClick={() => setAdding(false)} aria-label="Cancel" className="text-[var(--text-5)] hover:text-[var(--text-2)]">
              <X size={15} />
            </button>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
            <input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createUser()}
              type="email"
              placeholder="them@business.com"
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-base text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none md:text-[13px]"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-[13px] font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
            >
              {ASSIGNABLE_ROLE_OPTIONS.map((o) => (
                <option key={o.role} value={o.role}>
                  {o.label}
                </option>
              ))}
            </select>
            {/* Plan is only relevant for a `client` tenant — staff aren't metered. */}
            {needsSubscription(newRole) ? (
              <select
                value={newPlan}
                onChange={(e) => setNewPlan(e.target.value)}
                className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-[13px] font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center px-3 py-2 text-[12px] text-[var(--text-5)]">No plan needed</div>
            )}
            <button
              onClick={createUser}
              disabled={busy || !newEmail.trim() || (needsSubscription(newRole) && !newPlan)}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-[13px] font-bold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : "Create"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--text-5)]">
            {ROLE_OPTIONS.find((o) => o.role === newRole)?.description} · No password is set —
            they&apos;re emailed a link to choose one.
          </p>
        </div>
      )}

      {/* List */}
      <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                {["User", "Role", "Plan", "Tenancy", "Last sign-in", "This month"].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  onClick={() => setSelected(u.id === selected ? null : u.id)}
                  className={`cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-1)] ${
                    u.id === selected ? "bg-[var(--accent-soft)]" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <p className="text-[13px] font-bold text-[var(--text-1)]">
                      {u.email}
                      {u.is_self && <span className="ml-1.5 text-[10px] font-semibold text-[var(--text-5)]">you</span>}
                    </p>
                    <p className="text-[11px] text-[var(--text-5)]">joined {fmt(u.created_at)}</p>
                  </td>
                  <td className="px-4 py-3">
                    <RolePill role={u.role} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-[12px] font-semibold text-[var(--text-2)]">
                      {u.subscription?.plan_name ?? "—"}
                    </p>
                    {u.subscription && <SubPill status={u.subscription.status} />}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-[var(--text-3)]">
                    {u.counts.businesses} biz · {u.counts.accounts} acct
                  </td>
                  <td className="px-4 py-3 text-[12px] text-[var(--text-3)]">
                    {u.last_sign_in_at ? fmt(u.last_sign_in_at) : <span className="text-[var(--warn)]">never</span>}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-[var(--text-3)]">
                    {u.usage.messages} · ${(u.usage.costCents / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail */}
      {detail && (
        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-bold text-[var(--text-1)]">{detail.email}</h2>
              <p className="text-[11px] text-[var(--text-4)]">
                {detail.email_confirmed_at ? "Email confirmed" : "Email not confirmed"} · joined{" "}
                {fmt(detail.created_at)} · last sign-in{" "}
                {detail.last_sign_in_at ? fmt(detail.last_sign_in_at) : "never"}
              </p>
            </div>
            <button onClick={() => setSelected(null)} aria-label="Close" className="text-[var(--text-5)] hover:text-[var(--text-2)]">
              <X size={15} />
            </button>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {/* Role + plan */}
            <div className="space-y-3">
              <Field label="Role">
                <select
                  value={detail.role}
                  disabled={busy || detail.is_self}
                  onChange={(e) => mutate(detail.id, { role: e.target.value })}
                  className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-40"
                >
                  {/* super_admin isn't assignable here, but if this row already IS
                      one (only possible for its own disabled row — is_self blocks
                      changing it), its own option must still exist or the select
                      would render blank against a value with no matching option. */}
                  {(detail.role === "super_admin"
                    ? [ROLE_OPTIONS.find((o) => o.role === "super_admin")!, ...ASSIGNABLE_ROLE_OPTIONS]
                    : ASSIGNABLE_ROLE_OPTIONS
                  ).map((o) => (
                    <option key={o.role} value={o.role}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-[10px] text-[var(--text-5)]">
                {detail.is_self
                  ? "You can't change your own role."
                  : ROLE_OPTIONS.find((o) => o.role === detail.role)?.description}
              </p>

              {/* Plan applies to client tenants only — staff aren't metered. */}
              <Field label="Plan">
                {isStaff(detail.role) ? (
                  <span className="text-[12px] text-[var(--text-5)]">Not metered (staff)</span>
                ) : (
                  <select
                    value={plans.find((p) => p.name === detail.subscription?.plan_name)?.id ?? ""}
                    disabled={busy}
                    onChange={(e) => mutate(detail.id, { plan_id: e.target.value })}
                    className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-40"
                  >
                    <option value="" disabled>
                      No plan
                    </option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="Spend this month">
                <span className="text-[12px] font-bold text-[var(--text-2)]">
                  {detail.usage.messages} replies · ${(detail.usage.costCents / 100).toFixed(2)}
                </span>
              </Field>
            </div>

            {/* Tenancy */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
                Businesses &amp; accounts
              </p>
              {detail.businesses.length === 0 ? (
                <p className="mt-2 text-[12px] text-[var(--text-4)]">None yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {detail.businesses.map((b) => (
                    <div key={b.id} className="rounded-lg border border-[var(--border)] px-3 py-2">
                      <p className="text-[12px] font-bold text-[var(--text-1)]">
                        {b.name} <span className="text-[10px] font-semibold text-[var(--text-5)]">{b.status}</span>
                      </p>
                      {b.accounts.map((a) => (
                        <p key={a.id} className="mt-0.5 text-[11px] text-[var(--text-4)]">
                          @{a.username ?? "?"} · {a.status} ·{" "}
                          <span className={tokenAge(a.token_expires_at).cls}>
                            {tokenAge(a.token_expires_at).label}
                          </span>
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
            {detail.subscription?.status === "canceled" ? (
              <button
                onClick={() => mutate(detail.id, { subscription_status: "active" })}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--ok)]/30 px-3 py-1.5 text-[12px] font-bold text-[var(--ok)] hover:bg-[var(--ok-soft)] disabled:opacity-40"
              >
                <PlayCircle size={13} />
                Reactivate
              </button>
            ) : (
              <button
                onClick={() => mutate(detail.id, { subscription_status: "canceled" })}
                disabled={busy || !detail.subscription}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--warn)]/30 px-3 py-1.5 text-[12px] font-bold text-[var(--warn)] hover:bg-[var(--warn-soft)] disabled:opacity-40"
              >
                <PauseCircle size={13} />
                Suspend
              </button>
            )}
            <span className="text-[10px] text-[var(--text-5)]">
              Suspending stops their agent replying immediately. Reversible.
            </span>
            <button
              onClick={() => {
                setDeleteTarget(detail);
                setConfirmText("");
                setError(null);
              }}
              disabled={busy || detail.is_self}
              className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-[var(--text-4)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:opacity-30"
            >
              <Trash2 size={13} />
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Delete — states the real blast radius, then requires the email typed. */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4 backdrop-blur-sm"
          onClick={() => !busy && setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-[420px] rounded-2xl border border-[var(--border-strong)] bg-[var(--modal-bg)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--danger-soft)]">
                <Trash2 size={15} className="text-[var(--danger)]" />
              </div>
              <h3 className="text-[14px] font-bold text-[var(--text-1)]">Delete {deleteTarget.email}?</h3>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-[var(--text-4)]">
              This permanently deletes their account and everything under it:
            </p>
            <ul className="mt-2 space-y-1 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--danger)]">
              <li>{deleteTarget.counts.businesses} business{deleteTarget.counts.businesses === 1 ? "" : "es"}</li>
              <li>
                {deleteTarget.counts.accounts} Instagram account
                {deleteTarget.counts.accounts === 1 ? "" : "s"} (and their access tokens)
              </li>
              <li>every conversation and message they hold</li>
            </ul>
            <p className="mt-2 text-[11px] text-[var(--text-5)]">
              Their billing history stays, but stops being attributable to them. This can&apos;t be undone.
            </p>

            <label className="mt-4 block text-[11px] font-semibold text-[var(--text-4)]">
              Type <span className="font-mono text-[var(--text-2)]">{deleteTarget.email}</span> to confirm
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              className="mt-1.5 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-[13px] text-[var(--text-1)] focus:border-[var(--danger)] focus:outline-none"
            />

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--text-3)] hover:bg-[var(--surface-1)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={busy || confirmText.trim().toLowerCase() !== (deleteTarget.email ?? "").toLowerCase()}
                className="flex items-center gap-2 rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-semibold text-[var(--text-4)]">{label}</span>
      {children}
    </div>
  );
}

function RolePill({ role }: { role: string }) {
  const label = ROLE_OPTIONS.find((o) => o.role === role)?.label ?? role;
  // Elevated roles (can manage the operator's account) read with the accent; the
  // rest are neutral. Only super_admin/admin carry the shield.
  const elevated = role === "super_admin" || role === "admin";
  const staff = isStaff(role);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        elevated ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--surface-2)] text-[var(--text-4)]"
      }`}
    >
      {staff ? <ShieldCheck size={10} /> : <UserIcon size={10} />}
      {label}
    </span>
  );
}

function SubPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "text-[var(--ok)]",
    trialing: "text-[var(--ok)]",
    past_due: "text-[var(--warn)]",
    canceled: "text-[var(--danger)]",
  };
  return (
    <span className={`text-[10px] font-bold uppercase ${map[status] ?? "text-[var(--text-5)]"}`}>
      {status === "canceled" ? "suspended" : status}
    </span>
  );
}
