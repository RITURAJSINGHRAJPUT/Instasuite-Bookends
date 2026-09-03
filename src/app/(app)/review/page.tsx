"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import {
  Flag,
  AlertTriangle,
  X,
  Check,
  Loader2,
  MessagesSquare,
  Send,
} from "lucide-react";
import { COLLAB_DECLINE, COLLAB_DECLINE_LABEL } from "@/lib/review-responses";

// The Review queue — non-order handoffs the AI flagged for a human (the `review_items` ledger),
// captured from the AI's REVIEW line. Each pending item can be Marked reviewed, which flips the row
// (no DM — the reply happens in the Inbox, where the chat was moved to human mode at capture).

type Category = "collaboration" | "complaint" | "billing" | "event" | "cancellation" | "other";
type ReviewItem = {
  id: string;
  category: Category;
  customer_name: string | null;
  account_id: string | null;
  account_username: string | null;
  details: string;
  status: "pending" | "completed" | "dismissed";
  created_at: string;
  completed_at: string | null;
  conversation_id: string;
};

const CAT_LABEL: Record<Category, string> = {
  collaboration: "Collaboration",
  complaint: "Complaint",
  billing: "Billing",
  event: "Event",
  cancellation: "Cancellation",
  other: "Other",
};
const CAT_ORDER: Category[] = ["cancellation", "collaboration", "complaint", "billing", "event", "other"];

function relTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const acctLabel = (r: ReviewItem) => (r.account_username ? `@${r.account_username}` : "Account");
const catLabel = (c: Category) => CAT_LABEL[c] ?? "Other";

function CategoryChip({ category }: { category: Category }) {
  return (
    <span className="flex-shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--accent)]">
      {catLabel(category)}
    </span>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>}>
      <ReviewInner />
    </Suspense>
  );
}

function ReviewInner() {
  const params = useSearchParams();
  const accountParam = params.get("account");

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [account, setAccount] = useState<string>("all");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [selected, setSelected] = useState<ReviewItem | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  // Which item's decline is awaiting confirmation. The button sits on EVERY category,
  // so it must never be one click away from sending a collab reply to a complaint —
  // the first click only reveals the message for staff to read.
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/review");
      if (!res.ok) throw new Error();
      const d = await res.json();
      setItems(Array.isArray(d) ? d : []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Real-time: a new/changed review item refetches the list immediately instead
  // of waiting for a manual reload. Same pattern as Orders/Inbox's subscriptions.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    const supabase = createBrowserClient(url, key);
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      // Hand Realtime the user's JWT before subscribing, or RLS drops every event.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      supabase.realtime.setAuth(session?.access_token ?? null);
      if (cancelled) return;

      channel = supabase
        .channel("realtime-review-items")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "review_items" },
          () => loadRef.current()
        )
        .subscribe();
    })();

    // The access token expires (~1h); re-auth the socket or it goes quiet with no error.
    const { data: authSub } = supabase.auth.onAuthStateChange((_e, session) => {
      supabase.realtime.setAuth(session?.access_token ?? null);
    });

    return () => {
      cancelled = true;
      authSub.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (accountParam) setAccount(accountParam);
  }, [accountParam]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePanel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  async function markReviewed(id: string) {
    setWorking(id);
    try {
      const res = await fetch(`/api/review/${id}/complete`, { method: "POST" });
      if (res.ok) {
        setItems((prev) => prev.map((r) => (r.id === id ? { ...r, status: "completed" } : r)));
        setSelected((s) => (s && s.id === id ? { ...s, status: "completed" } : s));
      }
    } finally {
      setWorking(null);
      load();
    }
  }

  // Closing the panel abandons any pending confirm step — reopening the same item
  // should start from the buttons again, not a half-finished send.
  function closePanel() {
    setSelected(null);
    setConfirming(null);
  }

  async function sendDecline(id: string) {
    setWorking(id);
    try {
      const res = await fetch(`/api/review/${id}/respond`, { method: "POST" });
      if (res.ok) {
        setItems((prev) => prev.map((r) => (r.id === id ? { ...r, status: "completed" } : r)));
        setSelected((s) => (s && s.id === id ? { ...s, status: "completed" } : s));
        setConfirming(null);
      }
    } finally {
      setWorking(null);
      load();
    }
  }

  // Distinct accounts present in the data, for the filter dropdown.
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of items) if (r.account_id) seen.set(r.account_id, acctLabel(r));
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [items]);

  const scoped = useMemo(
    () =>
      items
        .filter((r) => account === "all" || r.account_id === account)
        .filter((r) => category === "all" || r.category === category),
    [items, account, category]
  );
  const pending = scoped.filter((r) => r.status === "pending");
  const reviewed = scoped.filter((r) => r.status !== "pending");

  if (loading) return <p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>;

  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <AlertTriangle size={22} className="mx-auto text-[var(--danger)]" />
          <p className="mt-3 text-[13px] font-bold text-[var(--text-1)]">Couldn&apos;t load the review queue</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3.5 md:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-extrabold tracking-tight text-[var(--text-1)]">Review</h1>
          <p className="mt-0.5 text-[11px] text-[var(--text-4)]">
            Handoffs that need a person — review before completion. The chat is paused for the AI.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as "all" | Category)}
            aria-label="Filter by category"
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-2 text-xs font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="all">All types</option>
            {CAT_ORDER.map((c) => (
              <option key={c} value={c}>
                {CAT_LABEL[c]}
              </option>
            ))}
          </select>

          {accounts.length > 1 && (
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              aria-label="Filter by account"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-2 text-xs font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="all">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="grid gap-6 p-4 md:grid-cols-2 md:p-6">
        <Section
          icon={<Flag size={15} className="text-[var(--accent)]" />}
          title="Needs review"
          rows={pending}
          empty="Nothing waiting on review."
          onOpen={setSelected}
          onResolve={markReviewed}
          working={working}
        />
        <Section
          icon={<Check size={15} className="text-[var(--ok)]" />}
          title="Reviewed"
          rows={reviewed}
          empty="No reviewed items yet."
          onOpen={setSelected}
          onResolve={markReviewed}
          working={working}
        />
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4 backdrop-blur-sm"
          onClick={() => closePanel()}
        >
          <div
            className="w-full max-w-[440px] rounded-2xl border border-[var(--border-strong)] bg-[var(--modal-bg)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                  <Flag size={16} className="text-[var(--accent)]" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-[14px] font-bold text-[var(--text-1)]">
                    {selected.customer_name || "Guest"}
                  </h3>
                  <p className="truncate text-[11px] text-[var(--text-4)]">
                    {acctLabel(selected)} · {fullDate(selected.created_at)}
                  </p>
                </div>
              </div>
              <button
                onClick={() => closePanel()}
                aria-label="Close"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-2)]"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <CategoryChip category={selected.category} />
              <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-5)]">Matter</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap rounded-xl bg-[var(--surface-1)] p-3 text-[12px] leading-relaxed text-[var(--text-2)]">
              {selected.details || "No further detail captured."}
            </p>

            {/* Confirm step: the exact text that will be sent, shown before anything
                goes out. The button is available on every category, so staff read
                what they're about to send rather than trusting the label. */}
            {confirming === selected.id && (
              <div className="mt-4 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--accent)]">
                  This message will be sent to {selected.customer_name || "the guest"}
                </p>
                <p className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--surface-1)] p-3 text-[12px] leading-relaxed text-[var(--text-2)]">
                  {COLLAB_DECLINE}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => setConfirming(null)}
                    disabled={working === selected.id}
                    className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2 text-sm font-bold text-[var(--text-2)] transition-colors hover:bg-[var(--panel-bg)] disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => sendDecline(selected.id)}
                    disabled={working === selected.id}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                  >
                    {working === selected.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Send size={14} />
                    )}
                    Send it
                  </button>
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center gap-2">
              <Link
                href="/inbox"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2.5 text-sm font-bold text-[var(--text-2)] transition-colors hover:bg-[var(--panel-bg)]"
              >
                <MessagesSquare size={14} /> Open in Inbox
              </Link>
              {selected.status === "pending" ? (
                <>
                  {confirming !== selected.id && (
                    <button
                      onClick={() => setConfirming(selected.id)}
                      disabled={working === selected.id}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-sm font-bold text-[var(--text-2)] transition-colors hover:bg-[var(--panel-bg)] disabled:opacity-40"
                    >
                      <Send size={14} /> {COLLAB_DECLINE_LABEL}
                    </button>
                  )}
                  <button
                    onClick={() => markReviewed(selected.id)}
                    disabled={working === selected.id}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                  >
                    {working === selected.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    Mark reviewed
                  </button>
                </>
              ) : (
                <span className="flex flex-1 items-center justify-center gap-1.5 text-[12px] font-bold text-[var(--ok)]">
                  <Check size={14} /> {selected.status === "dismissed" ? "Dismissed" : "Reviewed"}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  rows,
  empty,
  onOpen,
  onResolve,
  working,
}: {
  icon: React.ReactNode;
  title: string;
  rows: ReviewItem[];
  empty: string;
  onOpen: (r: ReviewItem) => void;
  onResolve: (id: string) => void;
  working: string | null;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-[14px] font-bold text-[var(--text-1)]">{title}</h2>
        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent)]">
          {rows.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-[var(--border)] px-4 py-6 text-center text-[12px] leading-relaxed text-[var(--text-5)]">
          {empty}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.id}
              onClick={() => onOpen(r)}
              className="flex cursor-pointer items-start justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 transition-colors hover:bg-[var(--surface-1)]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CategoryChip category={r.category} />
                  <p className="truncate text-[13px] font-bold text-[var(--text-1)]">
                    {r.customer_name || "Guest"}
                  </p>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--text-3)]">
                  {r.details || "No detail captured."}
                </p>
                <p className="mt-1 truncate text-[11px] text-[var(--text-4)]">
                  {acctLabel(r)} · {relTime(r.created_at)}
                </p>
              </div>
              {r.status === "pending" ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onResolve(r.id);
                  }}
                  disabled={working === r.id}
                  className="flex flex-shrink-0 items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {working === r.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Reviewed
                </button>
              ) : (
                <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ok-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--ok)]">
                  <Check size={11} /> {r.status === "dismissed" ? "Dismissed" : "Done"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
