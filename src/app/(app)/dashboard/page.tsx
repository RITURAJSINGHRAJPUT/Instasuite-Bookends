"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2, AtSign, MessageSquare, Coins, AlertTriangle } from "lucide-react";
import { tokenAge } from "@/lib/token-age";
import { sharedGet } from "@/lib/shared-fetch";
import VolumeChart, { type Point } from "@/components/VolumeChart";

type Account = {
  id: string;
  username: string | null;
  name: string | null;
  status: string;
  token_expires_at: string | null;
  businesses: { name: string } | null;
};

type Usage = {
  totals: { messages: number; costCents: number };
  subscription: {
    status: string;
    plans: { name: string; max_messages_per_month: number | null } | null;
  } | null;
};

type Volume = {
  days: number;
  total: number;
  accounts: { account_id: string; total: number; series: Point[] }[];
};

type AdminAccount = { username: string | null; token_expires_at: string | null; status: string };

type AccountStat = {
  account_id: string;
  username: string | null;
  name: string | null;
  status: string;
  conversations: number;
  human_handled: number;
  ai_replies: number;
  cost_cents: number;
  last_activity: string | null;
  // Detected from chat text (heuristic), not a ledger — see the endpoint comment.
  takeaway_orders: number;
  reservations: number;
};

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [conversations, setConversations] = useState(0);
  const [pending, setPending] = useState<{ businesses: number; accounts: number } | null>(null);
  const [adminTokens, setAdminTokens] = useState<AdminAccount[]>([]);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [accountStats, setAccountStats] = useState<AccountStat[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  // Everything here comes from endpoints that are already ownership-scoped.
  const load = useCallback(async () => {
    const [a, u, c, p, s] = await Promise.all([
      fetch("/api/account"),
      // Shared with the Sidebar, which requests the same thing on this very load.
      sharedGet<Usage>("/api/usage"),
      // count=1, not the full list: this card shows one integer, and the unfiltered
      // route runs a last-message query per conversation to build previews nobody
      // reads here.
      fetch("/api/conversations?count=1"),
      fetch("/api/admin/pending"), // 404s for non-super-admins
      fetch("/api/analytics/accounts"),
    ]);
    if (a.ok) setAccounts(await a.json());
    if (u) setUsage(u); // already parsed by sharedGet
    if (c.ok) {
      const d = await c.json();
      setConversations(typeof d?.count === "number" ? d.count : 0);
    }
    if (p.ok) {
      const d = await p.json();
      setPending({
        businesses: (d.businesses ?? []).filter((x: { status: string }) => x.status === "pending").length,
        accounts: (d.accounts ?? []).filter((x: { status: string }) => x.status === "pending").length,
      });
      setAdminTokens(d.accounts ?? []);
    }
    if (s.ok) setAccountStats(await s.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Separate from load(): re-runs on the 7/30 toggle without refetching the rest.
  useEffect(() => {
    fetch(`/api/analytics/volume?days=${days}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setVolume)
      .catch(() => {});
  }, [days]);

  const cap = usage?.subscription?.plans?.max_messages_per_month ?? null;
  const used = usage?.totals.messages ?? 0;

  // A token dying silently is what takes an account offline, so it gets top
  // billing. Super-admins see every account's; clients now see their own too
  // (token_expires_at was added to /api/account for exactly this).
  const tokenSource: AdminAccount[] = adminTokens.length
    ? adminTokens
    : accounts.map((a) => ({
        username: a.username,
        token_expires_at: a.token_expires_at,
        status: a.status,
      }));

  const atRisk = tokenSource.filter((t) => {
    if (t.status === "disabled") return false;
    const { level } = tokenAge(t.token_expires_at);
    return level === "warn" || level === "danger";
  });

  // Label a volume series by account. /api/analytics/volume returns account_id only;
  // the usernames are already on hand from /api/account.
  const accountName = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a?.username ? `@${a.username}` : a?.name || "Account";
  };

  // Fixed-height frame on desktop so the page fills the viewport and doesn't scroll;
  // on mobile the content is taller than any phone, so it flows and `main` scrolls.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-5 md:h-full md:min-h-0 md:overflow-hidden md:px-8 md:py-6">
      <div className="flex-shrink-0">
        <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Overview</h1>
        <p className="text-[12px] text-[var(--text-4)]">This month, across your connected accounts.</p>
      </div>

      {loading ? (
        <p className="mt-8 text-xs text-[var(--text-4)]">Loading…</p>
      ) : (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
          {/* Things that need attention come first */}
          {atRisk.length > 0 && (
            <div className="flex-shrink-0 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-soft)] p-3">
              <p className="flex items-center gap-2 text-[12px] font-bold text-[var(--danger)]">
                <AlertTriangle size={14} />
                {atRisk.length} account{atRisk.length === 1 ? "" : "s"} need attention
              </p>
              {atRisk.map((t) => (
                <p key={t.username} className="mt-1 text-[10px] text-[var(--text-4)]">
                  @{t.username} — {tokenAge(t.token_expires_at).label}. Instagram tokens last ~60
                  days; the daily refresh job renews them.
                </p>
              ))}
            </div>
          )}

          {pending && pending.businesses + pending.accounts > 0 && (
            <div className="flex flex-shrink-0 items-center justify-between gap-3 rounded-xl border border-[var(--warn)]/25 bg-[var(--warn-soft)] p-3">
              <p className="text-[12px] font-semibold text-[var(--warn)]">
                {pending.businesses} business{pending.businesses === 1 ? "" : "es"} and{" "}
                {pending.accounts} account{pending.accounts === 1 ? "" : "s"} awaiting approval
              </p>
              <Link
                href="/admin"
                className="flex-shrink-0 text-[10px] font-semibold text-[var(--text-3)] hover:text-[var(--text-1)]"
              >
                Review →
              </Link>
            </div>
          )}

          {/* Four real numbers. The reference's "AI Efficiency" card is absent:
              no accuracy signal exists in the schema to compute one from. */}
          <div className="grid flex-shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={Building2} label="Conversations" value={String(conversations)} sub="all time" />
            <Stat
              icon={MessageSquare}
              label="AI replies"
              value={cap === null ? String(used) : `${used}/${cap}`}
              sub={usage?.subscription?.plans?.name ? `${usage.subscription.plans.name} plan` : "this month"}
            />
            <Stat
              icon={Coins}
              label="AI cost"
              value={`$${((usage?.totals.costCents ?? 0) / 100).toFixed(2)}`}
              sub="this month"
            />
            <Stat
              icon={AtSign}
              label="Accounts"
              value={String(accounts.length)}
              sub={`${accounts.filter((a) => a.status === "approved").length} approved`}
            />
          </div>

          {cap !== null && (
            <div className="flex-shrink-0">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (used / cap) * 100)}%`,
                    background: used >= cap ? "var(--danger)" : "var(--accent)",
                  }}
                />
              </div>
              {used >= cap && (
                <p className="mt-2 text-[10px] font-semibold text-[var(--danger)]">
                  Monthly limit reached — auto-replies are paused until the period resets.
                </p>
              )}
            </div>
          )}

          {/* Fills the remaining height: chart and per-account cards side by side. */}
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
            {/* Message volume */}
            <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
              <div className="flex flex-shrink-0 flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[14px] font-bold text-[var(--text-1)]">Message volume</h2>
                  <p className="text-[11px] text-[var(--text-4)]">
                    Messages in and out, across your accounts
                  </p>
                </div>
                <div className="flex gap-1 rounded-lg bg-[var(--surface-1)] p-0.5">
                  {[7, 30].map((d) => (
                    <button
                      key={d}
                      onClick={() => setDays(d)}
                      className={`rounded-md px-3 py-1 text-[10px] font-bold transition-colors ${
                        days === d
                          ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                          : "text-[var(--text-4)] hover:text-[var(--text-2)]"
                      }`}
                    >
                      {d} days
                    </button>
                  ))}
                </div>
              </div>

              {/* One mini-chart per connected account, stacked. Scrolls within the
                  card on a short screen rather than pushing the page past the fold. */}
              <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                {!volume ? (
                  <p className="my-auto text-center text-xs text-[var(--text-5)]">Loading…</p>
                ) : volume.accounts.length === 0 ? (
                  <p className="my-auto text-center text-xs text-[var(--text-5)]">
                    No connected accounts yet.
                  </p>
                ) : (
                  volume.accounts.map((acc) => (
                    <div key={acc.account_id}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11px] font-bold text-[var(--text-1)]">
                          {accountName(acc.account_id)}
                        </span>
                        <span className="flex-shrink-0 text-[10px] text-[var(--text-5)]">
                          {acc.total.toLocaleString()} msg{acc.total === 1 ? "" : "s"}
                        </span>
                      </div>
                      {acc.total === 0 ? (
                        <p className="py-4 text-center text-[10px] text-[var(--text-5)]">
                          No messages in the last {volume.days} days
                        </p>
                      ) : (
                        <VolumeChart series={acc.series} />
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* By account — real per-account totals. No reservations/takeaways figure
                here: neither is tracked, so a number would be invented. The details
                live on the Orders page, linked below. Scrolls within its own column
                on a short screen rather than pushing the page past the viewport. */}
            {accountStats.length > 0 && (
              <div className="flex min-h-0 flex-col">
                <h2 className="flex-shrink-0 text-[14px] font-bold text-[var(--text-1)]">By account</h2>
                <p className="flex-shrink-0 text-[11px] text-[var(--text-4)]">
                  All-time totals per connected Instagram account
                </p>
                <div className="mt-3 grid min-h-0 flex-1 content-start gap-3 overflow-y-auto">
                  {accountStats.map((s) => (
                    <div
                      key={s.account_id}
                      className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-bold text-[var(--text-1)]">
                            {s.username ? `@${s.username}` : s.name || "Account"}
                          </p>
                          {s.name && s.username && (
                            <p className="truncate text-[10px] text-[var(--text-4)]">{s.name}</p>
                          )}
                        </div>
                        <StatusPill status={s.status} />
                      </div>
                      {/* Six metrics in one dense 3-col grid (was two grids + a
                          divider) to save vertical space. */}
                      <div className="mt-3 grid grid-cols-3 gap-3">
                        <CardStat
                          label="Convos"
                          value={String(s.conversations)}
                          sub={`${s.human_handled} human`}
                        />
                        <CardStat label="AI replies" value={String(s.ai_replies)} />
                        <CardStat label="Cost" value={`$${(s.cost_cents / 100).toFixed(2)}`} />
                        <CardStat label="Orders" value={String(s.takeaway_orders)} sub="detected" />
                        <CardStat label="Reservations" value={String(s.reservations)} sub="links" />
                        <CardStat label="Last active" value={relTime(s.last_activity)} />
                      </div>
                      <Link
                        href={`/orders?account=${s.account_id}`}
                        className="mt-3 inline-block text-[10px] font-bold text-[var(--accent)] hover:underline"
                      >
                        View orders &amp; reservations →
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-3.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
        <Icon size={15} className="text-[var(--accent)]" />
      </div>
      <p className="mt-2.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-5)]">{label}</p>
      <p className="mt-0.5 text-xl font-extrabold tracking-tight text-[var(--text-1)]">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-[var(--text-4)]">{sub}</p>}
    </div>
  );
}

// Compact metric inside an account card. Distinct from the top-of-page `Stat`
// (which is a full bordered tile with an icon) — these sit in a dense grid.
function CardStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-bold uppercase tracking-wide text-[var(--text-5)]">{label}</p>
      <p className="mt-0.5 truncate text-base font-extrabold tracking-tight text-[var(--text-1)]">{value}</p>
      {sub && <p className="truncate text-[10px] text-[var(--text-4)]">{sub}</p>}
    </div>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved: "bg-[var(--ok-soft)] text-[var(--ok)]",
    pending: "bg-[var(--warn-soft)] text-[var(--warn)]",
    rejected: "bg-[var(--danger-soft)] text-[var(--danger)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        map[status] ?? "bg-[var(--surface-2)] text-[var(--text-4)]"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
