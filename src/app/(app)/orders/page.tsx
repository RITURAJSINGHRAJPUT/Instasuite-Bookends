"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Receipt,
  CalendarClock,
  UtensilsCrossed,
  AlertTriangle,
  X,
  Check,
  Clock,
  Heart,
  Loader2,
  Ban,
} from "lucide-react";

// Real reservations + takeaway orders (the `orders` ledger), captured from the AI's handoff
// line — a live list, not an estimate. Each pending order can be Confirmed, which DMs the
// customer a confirmation and marks the row confirmed.

type Order = {
  id: string;
  kind: "reservation" | "takeaway";
  customer_name: string | null;
  account_id: string | null;
  account_username: string | null;
  details: string;
  status: "pending" | "confirmed" | "cancelled";
  created_at: string;
  confirmed_at: string | null;
  scheduled_at: string | null;
  feedback_sent_at: string | null;
  /** A guest asked to cancel this in-conversation — flagged from the Review pipeline. */
  cancellationRequested: boolean;
};

type Range = "all" | "week" | "month" | "year";
const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { week: 7, month: 30, year: 365 };
const RANGE_LABEL: Record<Range, string> = { all: "All", week: "Week", month: "Month", year: "Year" };

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

// The booked reservation/pickup time, always shown in IST (the outlets' clock) regardless of the
// operator's own timezone. e.g. "Sat, 30 Jul, 7:30 pm".
function bookedTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const bookedLabel = (o: Order) => (o.kind === "reservation" ? "Booked for" : "Pickup");

const acctLabel = (o: Order) => (o.account_username ? `@${o.account_username}` : "Account");

export default function OrdersPage() {
  return (
    <Suspense fallback={<p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>}>
      <OrdersInner />
    </Suspense>
  );
}

function OrdersInner() {
  const params = useSearchParams();
  const accountParam = params.get("account"); // set by the dashboard card links

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [account, setAccount] = useState<string>("all");
  const [range, setRange] = useState<Range>("all");
  const [selected, setSelected] = useState<Order | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);
  const [sendingFeedback, setSendingFeedback] = useState<string | null>(null);
  const [feedbackErr, setFeedbackErr] = useState<{ id: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/orders");
      if (!res.ok) throw new Error();
      const d = await res.json();
      setOrders(Array.isArray(d) ? d : []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (accountParam) setAccount(accountParam);
  }, [accountParam]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  async function confirm(id: string) {
    setConfirming(id);
    try {
      const res = await fetch(`/api/orders/${id}/confirm`, { method: "POST" });
      if (res.ok) {
        const d = await res.json().catch(() => null);
        // Reflect immediately; the DM has already gone out.
        setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: "confirmed" } : o)));
        setSelected((s) => (s && s.id === id ? { ...s, status: "confirmed" } : s));

        // Confirming can auto-cancel whatever this order superseded (e.g. the
        // guest cancelled a reservation, then booked this takeaway instead) —
        // reflect that second change immediately too, without waiting for load().
        const supersededId: string | undefined = d?.supersededOrder?.id;
        if (supersededId) {
          setOrders((prev) =>
            prev.map((o) =>
              o.id === supersededId ? { ...o, status: "cancelled", cancellationRequested: false } : o
            )
          );
          setSelected((s) =>
            s && s.id === supersededId ? { ...s, status: "cancelled", cancellationRequested: false } : s
          );
        }
      }
    } finally {
      setConfirming(null);
      load();
    }
  }

  async function cancelOrder(id: string) {
    setCanceling(id);
    try {
      const res = await fetch(`/api/orders/${id}/cancel`, { method: "POST" });
      if (res.ok) {
        // Reflect immediately; the DM has already gone out.
        setOrders((prev) =>
          prev.map((o) => (o.id === id ? { ...o, status: "cancelled", cancellationRequested: false } : o))
        );
        setSelected((s) =>
          s && s.id === id ? { ...s, status: "cancelled", cancellationRequested: false } : s
        );
      }
    } finally {
      setCanceling(null);
      load();
    }
  }

  // Manual "send the thank-you now" fallback (reservations). On success we stamp feedback_sent_at
  // locally so the button flips to "sent"; on a rejected send (e.g. the 24h window) we surface a
  // note and leave the button actionable — the server didn't stamp it, so it stays retryable.
  async function sendFeedback(id: string) {
    setSendingFeedback(id);
    setFeedbackErr((e) => (e && e.id === id ? null : e));
    try {
      const res = await fetch(`/api/orders/${id}/feedback`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.sent) {
        const stamp: string = d.feedback_sent_at || new Date().toISOString();
        setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, feedback_sent_at: stamp } : o)));
        setSelected((s) => (s && s.id === id ? { ...s, feedback_sent_at: stamp } : s));
      } else {
        setFeedbackErr({ id, msg: d.error || d.detail || "Couldn't send" });
      }
    } catch {
      setFeedbackErr({ id, msg: "Couldn't send" });
    } finally {
      setSendingFeedback(null);
    }
  }

  // Distinct accounts present in the data, for the filter dropdown.
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of orders) if (o.account_id) seen.set(o.account_id, acctLabel(o));
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [orders]);

  const cutoff = range === "all" ? 0 : Date.now() - RANGE_DAYS[range] * 86_400_000;
  const scoped = useMemo(
    () =>
      orders
        .filter((o) => account === "all" || o.account_id === account)
        .filter((o) => range === "all" || new Date(o.created_at).getTime() >= cutoff),
    [orders, account, range, cutoff]
  );
  const takeaways = scoped.filter((o) => o.kind === "takeaway");
  const reservations = scoped.filter((o) => o.kind === "reservation");

  if (loading) return <p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>;

  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <AlertTriangle size={22} className="mx-auto text-[var(--danger)]" />
          <p className="mt-3 text-[13px] font-bold text-[var(--text-1)]">Couldn&apos;t load orders</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3.5 md:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-extrabold tracking-tight text-[var(--text-1)]">
            Orders &amp; Reservations
          </h1>
          <p className="mt-0.5 text-[11px] text-[var(--text-4)]">
            Confirm to message the customer and mark it done.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
            {(["all", "week", "month", "year"] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  range === r
                    ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "text-[var(--text-4)] hover:text-[var(--text-2)]"
                }`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>

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
        <Column
          icon={<UtensilsCrossed size={15} className="text-[var(--accent)]" />}
          title="Takeaway orders"
          rows={takeaways}
          empty="No takeaway orders in this range."
          onOpen={setSelected}
          onConfirm={confirm}
          confirming={confirming}
          onCancel={cancelOrder}
          canceling={canceling}
          onFeedback={sendFeedback}
          sendingFeedback={sendingFeedback}
          feedbackErr={feedbackErr}
        />
        <Column
          icon={<CalendarClock size={15} className="text-[var(--accent)]" />}
          title="Reservations"
          rows={reservations}
          empty="No reservations in this range."
          onOpen={setSelected}
          onConfirm={confirm}
          confirming={confirming}
          onCancel={cancelOrder}
          canceling={canceling}
          onFeedback={sendFeedback}
          sendingFeedback={sendingFeedback}
          feedbackErr={feedbackErr}
        />
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-w-[440px] rounded-2xl border border-[var(--border-strong)] bg-[var(--modal-bg)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                  {selected.kind === "takeaway" ? (
                    <Receipt size={16} className="text-[var(--accent)]" />
                  ) : (
                    <CalendarClock size={16} className="text-[var(--accent)]" />
                  )}
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
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-2)]"
              >
                <X size={16} />
              </button>
            </div>

            {selected.cancellationRequested && (
              <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-[var(--warn-soft)] px-3 py-2 text-[12px] font-bold text-[var(--warn)]">
                <AlertTriangle size={13} className="flex-shrink-0" />
                The guest asked to cancel this — review and confirm below.
              </p>
            )}

            {selected.scheduled_at && (
              <p className="mt-3 flex items-center gap-1.5 text-[12px] font-bold text-[var(--text-1)]">
                <Clock size={13} className="flex-shrink-0 text-[var(--accent)]" />
                {bookedLabel(selected)} {bookedTime(selected.scheduled_at)}
              </p>
            )}

            <p className="mt-3 text-[10px] font-bold uppercase tracking-wide text-[var(--text-5)]">
              {selected.kind === "takeaway" ? "Order" : "Reservation"}
            </p>
            <p className="mt-1 whitespace-pre-wrap rounded-xl bg-[var(--surface-1)] p-3 text-[12px] leading-relaxed text-[var(--text-2)]">
              {selected.details || "No further detail captured."}
            </p>

            <div className="mt-4 space-y-2">
              {selected.status === "confirmed" ? (
                <span className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--ok)]">
                  <Check size={14} /> Confirmed — the customer was messaged.
                </span>
              ) : selected.status === "cancelled" ? (
                <span className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--danger)]">
                  <Ban size={14} /> Cancelled — the customer was messaged.
                </span>
              ) : (
                <button
                  onClick={() => confirm(selected.id)}
                  disabled={confirming === selected.id}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {confirming === selected.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Confirm &amp; message customer
                </button>
              )}

              {selected.status !== "cancelled" && (
                <button
                  onClick={() => cancelOrder(selected.id)}
                  disabled={canceling === selected.id}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--danger)]/30 px-4 py-2.5 text-sm font-bold text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)] disabled:opacity-40"
                >
                  {canceling === selected.id ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                  Cancel &amp; message customer
                </button>
              )}
            </div>

            {selected.kind === "reservation" && (
              <div className="mt-3">
                {selected.feedback_sent_at ? (
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-4)]">
                    <Check size={14} /> Feedback sent
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => sendFeedback(selected.id)}
                      disabled={sendingFeedback === selected.id}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2.5 text-sm font-bold text-[var(--text-2)] transition-colors hover:border-[var(--accent)] disabled:opacity-40"
                    >
                      {sendingFeedback === selected.id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Heart size={14} />
                      )}
                      Send feedback DM
                    </button>
                    {feedbackErr?.id === selected.id && (
                      <p className="mt-1.5 text-[11px] font-semibold text-[var(--danger)]">
                        {feedbackErr.msg}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Column({
  icon,
  title,
  rows,
  empty,
  onOpen,
  onConfirm,
  confirming,
  onCancel,
  canceling,
  onFeedback,
  sendingFeedback,
  feedbackErr,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Order[];
  empty: string;
  onOpen: (o: Order) => void;
  onConfirm: (id: string) => void;
  confirming: string | null;
  onCancel: (id: string) => void;
  canceling: string | null;
  onFeedback: (id: string) => void;
  sendingFeedback: string | null;
  feedbackErr: { id: string; msg: string } | null;
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
          {rows.map((o) => (
            <div
              key={o.id}
              onClick={() => onOpen(o)}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 transition-colors hover:bg-[var(--surface-1)]"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-bold text-[var(--text-1)]">
                  {o.customer_name || "Guest"}
                </p>
                <p className="truncate text-[11px] text-[var(--text-4)]">
                  {acctLabel(o)} · {relTime(o.created_at)}
                </p>
                {o.scheduled_at && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] font-semibold text-[var(--text-2)]">
                    <Clock size={11} className="flex-shrink-0 text-[var(--accent)]" />
                    {bookedLabel(o)} {bookedTime(o.scheduled_at)}
                  </p>
                )}
              </div>

              <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                {o.cancellationRequested && (
                  <span className="flex items-center gap-1 rounded-full bg-[var(--warn-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--warn)]">
                    <AlertTriangle size={11} /> Cancel requested
                  </span>
                )}

                {o.status === "confirmed" ? (
                  <span className="flex items-center gap-1 rounded-full bg-[var(--ok-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--ok)]">
                    <Check size={11} /> Confirmed
                  </span>
                ) : o.status === "cancelled" ? (
                  <span className="flex items-center gap-1 rounded-full bg-[var(--danger-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--danger)]">
                    <Ban size={11} /> Cancelled
                  </span>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onConfirm(o.id);
                    }}
                    disabled={confirming === o.id}
                    className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                  >
                    {confirming === o.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                    Confirm
                  </button>
                )}

                {o.status !== "cancelled" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancel(o.id);
                    }}
                    disabled={canceling === o.id}
                    className="flex items-center gap-1 rounded-lg border border-[var(--danger)]/30 px-3 py-1.5 text-[11px] font-bold text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)] disabled:opacity-40"
                  >
                    {canceling === o.id ? <Loader2 size={11} className="animate-spin" /> : <Ban size={11} />}
                    Cancel
                  </button>
                )}

                {o.kind === "reservation" &&
                  (o.feedback_sent_at ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold text-[var(--text-4)]">
                      <Check size={11} /> Feedback sent
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFeedback(o.id);
                        }}
                        disabled={sendingFeedback === o.id}
                        className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[11px] font-bold text-[var(--text-2)] transition-colors hover:border-[var(--accent)] disabled:opacity-40"
                      >
                        {sendingFeedback === o.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Heart size={11} />
                        )}
                        Feedback
                      </button>
                      {feedbackErr?.id === o.id && (
                        <span className="text-[10px] font-semibold text-[var(--danger)]">
                          {feedbackErr.msg}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
