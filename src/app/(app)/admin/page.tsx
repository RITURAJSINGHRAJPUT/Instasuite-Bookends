"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { tokenAge } from "@/lib/token-age";

type PendingBusiness = {
  id: string;
  name: string;
  status: string;
  profiles: { email: string } | null;
};

type PendingAccount = {
  id: string;
  ig_account_id: string;
  username: string | null;
  status: string;
  token_expires_at: string | null;
  businesses: { name: string; profiles: { email: string } | null } | null;
};

type Plan = {
  id: string;
  name: string;
  max_ig_accounts: number;
  max_messages_per_month: number | null;
  price_cents: number;
  stripe_price_id: string | null;
};

type Lead = {
  id: string;
  name: string;
  email: string;
  instagram_handle: string | null;
  message: string | null;
  status: string;
  created_at: string;
};

type AdminUsage = {
  total_cost_cents: number;
  total_messages: number;
  clients: { email: string; messages: number; cost_cents: number }[];
};

const badge = (s: string) =>
  s === "approved"
    ? "bg-emerald-500/15 text-emerald-400"
    : s === "pending"
      ? "bg-amber-500/15 text-amber-400"
      : "bg-red-500/15 text-red-400";

export default function AdminPage() {
  const [businesses, setBusinesses] = useState<PendingBusiness[]>([]);
  const [accounts, setAccounts] = useState<PendingAccount[]>([]);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [usage, setUsage] = useState<AdminUsage | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);

  const load = useCallback(async () => {
    // All four together. The other three used to wait on /api/admin/pending purely
    // because its 404 doubles as the permission probe — but each of these routes
    // applies the same `admin` gate and 404s on its own, so nothing is exposed by
    // asking in parallel and the page loads in one round trip instead of two.
    const [res, p, u, l] = await Promise.all([
      fetch("/api/admin/pending"),
      fetch("/api/admin/plans"),
      fetch("/api/admin/usage"),
      fetch("/api/admin/leads"),
    ]);

    if (res.status === 404) {
      setDenied(true);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setBusinesses(data.businesses ?? []);
    setAccounts(data.accounts ?? []);

    if (p.ok) setPlans(await p.json());
    if (u.ok) setUsage(await u.json());
    if (l.ok) setLeads(await l.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function setLeadStatus(id: string, status: string) {
    await fetch(`/api/admin/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }

  async function savePlan(id: string, patch: Partial<Plan>) {
    await fetch(`/api/admin/plans/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    load();
  }

  async function setStatus(kind: "businesses" | "accounts", id: string, status: string) {
    await fetch(`/api/admin/${kind}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }

  if (loading) {
    return <p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>;
  }

  // The API 404s for non-super-admins; mirror that here rather than hinting the
  // page exists.
  if (denied) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h1 className="text-sm font-semibold text-[var(--text-1)]">404 — Not found</h1>
          <Link href="/dashboard" className="mt-2 inline-block text-xs text-[var(--text-4)] hover:text-[var(--text-2)]">
            ← Back to overview
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-1)]">Admin</h1>
            <p className="text-xs text-[var(--text-4)]">Nothing goes live until approved here.</p>
          </div>
        </div>

        {/* Leads — from the landing page's request-access form */}
        <h2 className="mt-8 text-[10px] uppercase tracking-wide text-[var(--text-5)]">
          Access requests ({leads.filter((l) => l.status === "new").length} new)
        </h2>
        <div className="mt-2 space-y-2">
          {leads.length === 0 && <p className="text-xs text-[var(--text-4)]">None yet.</p>}
          {leads.map((l) => (
            <div key={l.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text-1)] truncate">
                    {l.name} {l.instagram_handle && <span className="text-[var(--text-4)]">· @{l.instagram_handle}</span>}
                  </p>
                  <p className="text-[10px] text-[var(--text-4)] truncate">{l.email}</p>
                  {l.message && <p className="mt-1 text-[10px] text-[var(--text-5)]">{l.message}</p>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase ${badge(l.status === "converted" ? "approved" : l.status === "rejected" ? "rejected" : "pending")}`}>
                    {l.status}
                  </span>
                  <select
                    value={l.status}
                    onChange={(e) => setLeadStatus(l.id, e.target.value)}
                    className="rounded border border-[var(--border-strong)] bg-[var(--surface-1)] px-1.5 py-1 text-[10px] text-[var(--text-2)] focus:outline-none"
                  >
                    <option value="new">new</option>
                    <option value="contacted">contacted</option>
                    <option value="converted">converted</option>
                    <option value="rejected">rejected</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Platform COGS */}
        {usage && (
          <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
            <h2 className="text-[10px] uppercase tracking-wide text-[var(--text-5)]">
              Platform AI cost this month
            </h2>
            <div className="mt-2 flex flex-wrap gap-6">
              <div>
                <p className="text-lg font-semibold text-[var(--text-1)]">
                  ${(usage.total_cost_cents / 100).toFixed(2)}
                </p>
                <p className="text-[10px] text-[var(--text-4)]">what you owe Anthropic</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-[var(--text-1)]">{usage.total_messages}</p>
                <p className="text-[10px] text-[var(--text-4)]">AI replies</p>
              </div>
            </div>
            {usage.clients.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-[var(--border)] pt-3">
                {usage.clients.map((c) => (
                  <div key={c.email} className="flex items-center justify-between text-[10px]">
                    <span className="text-[var(--text-4)] truncate">{c.email}</span>
                    <span className="text-[var(--text-2)] flex-shrink-0">
                      {c.messages} replies · ${(c.cost_cents / 100).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Plans */}
        <h2 className="mt-8 text-[10px] uppercase tracking-wide text-[var(--text-5)]">Plans</h2>
        <div className="mt-2 space-y-2">
          {plans.map((p) => (
            <div key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-[var(--text-1)] flex-1 min-w-0 truncate">{p.name}</span>
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-4)]">
                  accounts
                  <input
                    type="number"
                    defaultValue={p.max_ig_accounts}
                    onBlur={(e) => savePlan(p.id, { max_ig_accounts: Number(e.target.value) })}
                    className="w-16 rounded border border-[var(--border-strong)] bg-[var(--surface-1)] px-1.5 py-1 text-[var(--text-1)] focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-4)]">
                  msgs/mo
                  <input
                    type="number"
                    defaultValue={p.max_messages_per_month ?? ""}
                    placeholder="∞"
                    onBlur={(e) => savePlan(p.id, { max_messages_per_month: e.target.value === "" ? null : Number(e.target.value) })}
                    className="w-20 rounded border border-[var(--border-strong)] bg-[var(--surface-1)] px-1.5 py-1 text-[var(--text-1)] focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-4)]">
                  $/mo
                  <input
                    type="number"
                    defaultValue={(p.price_cents / 100).toFixed(2)}
                    onBlur={(e) => savePlan(p.id, { price_cents: Math.round(Number(e.target.value) * 100) })}
                    className="w-20 rounded border border-[var(--border-strong)] bg-[var(--surface-1)] px-1.5 py-1 text-[var(--text-1)] focus:outline-none"
                  />
                </label>
              </div>
              <p className="mt-1 text-[10px] text-[var(--text-5)]">
                blank msgs/mo = unlimited · stripe_price_id: {p.stripe_price_id ?? "not linked yet"}
              </p>
            </div>
          ))}
        </div>

        {/* Businesses */}
        <h2 className="mt-8 text-[10px] uppercase tracking-wide text-[var(--text-5)]">Businesses</h2>
        <div className="mt-2 space-y-2">
          {businesses.length === 0 && <p className="text-xs text-[var(--text-4)]">None.</p>}
          {businesses.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-1)] truncate">{b.name}</p>
                <p className="text-[10px] text-[var(--text-4)] truncate">{b.profiles?.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase ${badge(b.status)}`}>{b.status}</span>
                {b.status !== "approved" && (
                  <button onClick={() => setStatus("businesses", b.id, "approved")} className="rounded-lg bg-emerald-500/90 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-emerald-500">
                    Approve
                  </button>
                )}
                {b.status !== "rejected" && (
                  <button onClick={() => setStatus("businesses", b.id, "rejected")} className="rounded-lg px-2.5 py-1 text-[10px] font-medium text-[var(--text-4)] hover:text-red-400 hover:bg-red-500/10">
                    Reject
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Accounts */}
        <h2 className="mt-8 text-[10px] uppercase tracking-wide text-[var(--text-5)]">Instagram accounts</h2>
        <div className="mt-2 space-y-2">
          {accounts.length === 0 && <p className="text-xs text-[var(--text-4)]">None.</p>}
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-1)] truncate">
                  {a.username ? `@${a.username}` : a.ig_account_id}
                </p>
                <p className="text-[10px] text-[var(--text-4)] truncate">
                  {a.businesses?.name} · {a.businesses?.profiles?.email}
                </p>
                <p className={`text-[10px] ${tokenAge(a.token_expires_at).cls}`}>
                  {tokenAge(a.token_expires_at).label}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase ${badge(a.status)}`}>{a.status}</span>
                {a.status !== "approved" && (
                  <button onClick={() => setStatus("accounts", a.id, "approved")} className="rounded-lg bg-emerald-500/90 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-emerald-500">
                    Approve
                  </button>
                )}
                {a.status !== "disabled" && (
                  <button onClick={() => setStatus("accounts", a.id, "disabled")} className="rounded-lg px-2.5 py-1 text-[10px] font-medium text-[var(--text-4)] hover:text-red-400 hover:bg-red-500/10">
                    Disable
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
    </div>
  );
}
