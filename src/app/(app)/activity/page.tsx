"use client";

import { useEffect, useMemo, useState } from "react";
import { ScrollText, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

// Activity — every write action, and who performed it. super_admin only (the `audit`
// capability); AppGuard blocks the page and /api/activity 404s for anyone else.

type Entry = {
  id: string;
  actor_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  created_at: string;
};

// Verb phrasing per action, so the table reads as a sentence rather than a slug.
// An unmapped action degrades to its own name with the punctuation cleaned up —
// a new action added later shows up readably instead of silently vanishing.
const ACTION_LABEL: Record<string, string> = {
  "order.confirm": "Confirmed order",
  "order.cancel": "Cancelled order",
  "order.update": "Edited order",
  "order.log_manual": "Logged order manually",
  "order.feedback_dm": "Sent feedback DM",
  "conversation.send": "Replied in chat",
  "conversation.delete": "Deleted conversation",
  "conversation.mode_human": "Took over chat",
  "conversation.mode_agent": "Handed chat back to AI",
  "conversation.dismiss_notice": "Dismissed handoff notice",
  "review.completed": "Marked review done",
  "review.dismissed": "Dismissed review item",
  "script.update": "Edited AI script",
  "script.create": "Created AI script",
  "quick_reply.create": "Added quick reply",
  "quick_reply.delete": "Deleted quick reply",
  "business.create": "Created business",
  "business.update": "Edited business",
  "business.delete": "Deleted business",
  "outlet.create": "Added outlet",
  "outlet.delete": "Removed outlet",
  "account.connect": "Connected Instagram account",
  "account.disconnect": "Disconnected Instagram account",
  "account.update": "Edited Instagram account",
  "unavailable.dish_add": "Marked dish sold out",
  "unavailable.dish_remove": "Restored dish",
  "unavailable.outlet_close": "Closed outlet",
  "unavailable.outlet_reopen": "Reopened outlet",
  "user.create": "Created user",
  "user.delete": "Deleted user",
  "user.update": "Edited user",
  "user.role_change": "Changed role",
  "plan.create": "Created plan",
  "plan.update": "Edited plan",
};

const FILTERS = [
  { value: "", label: "All" },
  { value: "order", label: "Orders" },
  { value: "conversation", label: "Chats" },
  { value: "script", label: "Scripts" },
  { value: "user", label: "Users" },
  { value: "business", label: "Businesses" },
  { value: "account", label: "IG accounts" },
  { value: "unavailable", label: "Availability" },
];

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/[._]/g, " ");
}

function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function ActivityPage() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [loading, setLoading] = useState(true);

  // No setState before the first await, and `loading` only ever goes true -> false:
  // a synchronous setState in an effect triggers a cascading re-render (the
  // react-hooks/set-state-in-effect rule). A refetch therefore keeps the current rows
  // on screen instead of flashing a spinner, which reads better anyway.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const qs = new URLSearchParams({ page: String(page) });
      if (action) qs.set("action", action);
      if (actor) qs.set("actor", actor);
      const res = await fetch(`/api/activity?${qs}`);
      if (cancelled) return;
      if (res.ok) {
        const data = await res.json();
        if (cancelled) return;
        setRows(data.rows ?? []);
        setTotal(data.total ?? 0);
        setPageSize(data.pageSize ?? 50);
      }
      setLoading(false);
    })();
    // Guards against an out-of-order response overwriting a newer one when filters
    // are changed quickly.
    return () => {
      cancelled = true;
    };
  }, [page, action, actor]);

  // Actor options come from the rows on screen — enough to jump to one person's
  // trail without a second endpoint just to enumerate users.
  const actors = useMemo(
    () => [...new Set(rows.map((r) => r.actor_email))].sort(),
    [rows]
  );

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-6">
      <div className="flex items-center gap-2">
        <ScrollText size={18} className="text-[var(--text-4)]" />
        <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Activity</h1>
      </div>
      <p className="mt-1 text-[12px] text-[var(--text-5)]">
        Every change made in the dashboard, and who made it. Automated activity — the AI&apos;s own
        replies, scheduled jobs — isn&apos;t listed here.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => {
              setAction(f.value);
              setPage(1);
            }}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors ${
              action === f.value
                ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                : "border border-[var(--border)] text-[var(--text-4)] hover:bg-[var(--surface-2)]"
            }`}
          >
            {f.label}
          </button>
        ))}
        <select
          value={actor}
          onChange={(e) => {
            setActor(e.target.value);
            setPage(1);
          }}
          className="ml-auto rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-1 text-[11px] text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
        >
          <option value="">Everyone</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-[12px] text-[var(--text-5)]">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-[12px] text-[var(--text-5)]">No activity recorded yet.</p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[10px] uppercase tracking-wider text-[var(--text-5)]">
                <th className="px-3 py-2 font-bold">When</th>
                <th className="px-3 py-2 font-bold">Who</th>
                <th className="px-3 py-2 font-bold">Action</th>
                <th className="px-3 py-2 font-bold">Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-[var(--text-5)]">
                    {fullDate(r.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-[var(--text-2)]">{r.actor_email}</span>
                    <span className="ml-1.5 text-[10px] text-[var(--text-5)]">{r.actor_role}</span>
                  </td>
                  <td className="px-3 py-2 font-semibold text-[var(--text-1)]">
                    {actionLabel(r.action)}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-4)]">
                    {r.target_label || r.target_id || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > pageSize && (
        <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--text-5)]">
          <span>
            Page {page} of {lastPage} · {total.toLocaleString()} entries
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 font-bold transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            >
              <ChevronLeft size={12} />
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage}
              className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 font-bold transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            >
              Next
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
