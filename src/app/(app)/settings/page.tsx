"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import { sharedGet } from "@/lib/shared-fetch";

type Usage = {
  period_start: string;
  totals: { messages: number; inputTokens: number; outputTokens: number; costCents: number };
  subscription: {
    status: string;
    plans: {
      name: string;
      max_ig_accounts: number;
      max_messages_per_month: number | null;
      price_cents: number;
    } | null;
  } | null;
  by_account: { username: string; messages: number; cost_cents: number }[];
};

// Usage + plan + appearance. Business and account management moved to
// /businesses; script editing moved to /scripts.
export default function SettingsPage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Shared with the Sidebar: arriving here from Overview reuses the response
    // rather than re-running the app's deepest route a third time.
    sharedGet<Usage>("/api/usage")
      .then(setUsage)
      .finally(() => setLoading(false));
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  function setTheme(next: "light" | "dark") {
    setDark(next === "dark");
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // ignore (private mode / storage disabled)
    }
  }

  const plan = usage?.subscription?.plans;
  const cap = plan?.max_messages_per_month ?? null;
  const used = usage?.totals.messages ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Settings</h1>
      <p className="text-[12px] text-[var(--text-4)]">Your plan, usage and appearance.</p>

      {loading && <p className="mt-6 text-xs text-[var(--text-4)]">Loading…</p>}

      {/* Usage this period */}
      {usage && (
        <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
              Usage since {new Date(usage.period_start).toLocaleDateString()}
            </h2>
            {plan && (
              <span className="text-[10px] font-semibold text-[var(--text-4)]">
                {plan.name} plan · {usage.subscription?.status}
              </span>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-8">
            <div>
              <p className="text-xl font-extrabold text-[var(--text-1)]">
                {used}
                {cap != null && (
                  <span className="text-xs font-semibold text-[var(--text-4)]"> / {cap}</span>
                )}
              </p>
              <p className="text-[10px] text-[var(--text-4)]">AI replies</p>
            </div>
            <div>
              <p className="text-xl font-extrabold text-[var(--text-1)]">
                ${(usage.totals.costCents / 100).toFixed(2)}
              </p>
              <p className="text-[10px] text-[var(--text-4)]">AI cost</p>
            </div>
            <div>
              <p className="text-xl font-extrabold text-[var(--text-1)]">
                {(usage.totals.inputTokens + usage.totals.outputTokens).toLocaleString()}
              </p>
              <p className="text-[10px] text-[var(--text-4)]">tokens</p>
            </div>
          </div>

          {/* Limit bar — only when the plan actually caps messages */}
          {cap != null && (
            <div className="mt-4">
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

          {usage.by_account.length > 0 && (
            <div className="mt-4 space-y-1.5 border-t border-[var(--border)] pt-4">
              {usage.by_account.map((a) => (
                <div key={a.username} className="flex items-center justify-between text-[10px]">
                  <span className="text-[var(--text-4)]">@{a.username}</span>
                  <span className="font-semibold text-[var(--text-2)]">
                    {a.messages} replies · ${(a.cost_cents / 100).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Plan */}
      {plan && (
        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
          <h2 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">Plan</h2>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-[14px] font-bold text-[var(--text-1)]">{plan.name}</p>
              <p className="text-[10px] text-[var(--text-4)]">
                {plan.max_ig_accounts} Instagram account{plan.max_ig_accounts === 1 ? "" : "s"} ·{" "}
                {cap === null ? "unlimited replies" : `${cap.toLocaleString()} replies / month`}
              </p>
            </div>
            <p className="text-lg font-extrabold text-[var(--text-1)]">
              {plan.price_cents === 0 ? "Free" : `$${(plan.price_cents / 100).toFixed(0)}`}
              {plan.price_cents > 0 && (
                <span className="text-xs font-semibold text-[var(--text-4)]">/mo</span>
              )}
            </p>
          </div>
          {/* Deliberately no "Upgrade" button: there is no billing flow to send
              anyone to, so it would be a dead end. */}
          <p className="mt-3 border-t border-[var(--border)] pt-3 text-[10px] text-[var(--text-5)]">
            To change plan, reply to your onboarding email — we move accounts over manually.
          </p>
        </div>
      )}

      {/* Appearance */}
      <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <h2 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
          Appearance
        </h2>
        <div className="mt-3 flex gap-2">
          {(
            [
              { key: "light", label: "Light", Icon: Sun },
              { key: "dark", label: "Dark", Icon: Moon },
            ] as const
          ).map(({ key, label, Icon }) => {
            const active = (key === "dark") === dark;
            return (
              <button
                key={key}
                onClick={() => setTheme(key)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-[12px] font-bold transition-colors ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border-strong)] text-[var(--text-3)] hover:bg-[var(--surface-1)]"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-[11px] text-[var(--text-4)]">
        Looking for your businesses and Instagram accounts?{" "}
        <Link href="/businesses" className="font-semibold text-[var(--accent)] underline">
          They moved to Businesses →
        </Link>
      </p>
    </div>
  );
}
