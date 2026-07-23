"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MessageCircle,
  Save,
  AlertTriangle,
  Check,
  Clock,
  XCircle,
  Loader2,
  WifiOff,
} from "lucide-react";

// Manage the reservation-team WhatsApp destinations (per business), log in by scanning the
// QR the worker reports, watch its connection, and see the delivery log. The worker holds
// the whatsapp-web.js session on its own machine and reports status/QR to the DB; this page
// reads that. Finding the group id still comes from the worker's startup log.

type Biz = { id: string; name: string; group_id: string; staff_numbers: string[] };

type Row = {
  id: string;
  business_name: string | null;
  kind: string;
  customer_name: string | null;
  account_username: string | null;
  body: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
};

type Session = {
  status: string;
  qr: string | null;
  phone: string | null;
  updated_at: string | null;
  online: boolean;
};

function relTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS: Record<Row["status"], { cls: string; icon: React.ReactNode; label: string }> = {
  sent: { cls: "bg-[var(--ok-soft)] text-[var(--ok)]", icon: <Check size={11} />, label: "sent" },
  pending: { cls: "bg-[var(--warn-soft)] text-[var(--warn)]", icon: <Clock size={11} />, label: "pending" },
  failed: { cls: "bg-[var(--danger-soft)] text-[var(--danger)]", icon: <XCircle size={11} />, label: "failed" },
};

function ConnectionCard({ session, loading }: { session: Session | null; loading: boolean }) {
  const online = !!session?.online;
  const status = session?.status ?? "unknown";

  return (
    <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
      <div className="flex items-center gap-2">
        <MessageCircle size={15} className="text-[var(--accent)]" />
        <h2 className="text-[14px] font-bold text-[var(--text-1)]">Connection</h2>
      </div>

      {loading && !session ? (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-[var(--text-4)]">
          <Loader2 size={13} className="animate-spin" /> Checking…
        </p>
      ) : !online ? (
        // Stale/absent heartbeat → the worker isn't running.
        <div className="mt-3 flex items-start gap-2.5">
          <WifiOff size={16} className="mt-0.5 flex-shrink-0 text-[var(--text-5)]" />
          <div>
            <p className="text-[13px] font-bold text-[var(--text-2)]">Worker isn&apos;t running</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-4)]">
              Start the WhatsApp worker on your machine (<code>cd worker &amp;&amp; node index.js</code>) — the
              QR to log in will appear here once it&apos;s up.
            </p>
          </div>
        </div>
      ) : status === "connected" ? (
        <div className="mt-3 flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-[var(--ok)]" />
          <div>
            <p className="text-[13px] font-bold text-[var(--text-1)]">Connected</p>
            {session?.phone && (
              <p className="mt-0.5 text-[11px] text-[var(--text-4)]">Linked as +{session.phone}</p>
            )}
          </div>
        </div>
      ) : status === "qr" && session?.qr ? (
        <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={session.qr}
            alt="WhatsApp login QR"
            width={200}
            height={200}
            className="rounded-xl bg-white p-2"
          />
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-[var(--text-1)]">Scan to log in</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] text-[var(--text-4)]">
              <li>Open WhatsApp on the sending phone (a dedicated SIM is best).</li>
              <li>Settings → <b>Linked Devices</b> → <b>Link a Device</b>.</li>
              <li>Scan this code. It refreshes automatically.</li>
            </ol>
          </div>
        </div>
      ) : status === "disconnected" || status === "auth_failure" ? (
        <div className="mt-3 flex items-start gap-2.5">
          <XCircle size={16} className="mt-0.5 flex-shrink-0 text-[var(--danger)]" />
          <div>
            <p className="text-[13px] font-bold text-[var(--text-2)]">
              {status === "auth_failure" ? "Login failed" : "Disconnected"}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--text-4)]">
              Restart the worker to re-pair; a fresh QR will appear here.
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-[var(--text-4)]">
          <Loader2 size={13} className="animate-spin" /> Connecting…
        </p>
      )}
    </div>
  );
}

export default function WhatsappPage() {
  const [businesses, setBusinesses] = useState<Biz[]>([]);
  const [outbox, setOutbox] = useState<Row[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form state for the currently-selected business.
  const [businessId, setBusinessId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [numbers, setNumbers] = useState("");

  const applyBusiness = useCallback((list: Biz[], id: string) => {
    const b = list.find((x) => x.id === id);
    setGroupId(b?.group_id ?? "");
    setNumbers((b?.staff_numbers ?? []).join(", "));
  }, []);

  const fetchData = useCallback(async () => {
    const res = await fetch("/api/whatsapp");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Couldn't load WhatsApp settings.");
    return data;
  }, []);

  useEffect(() => {
    let alive = true;

    // Initial load hydrates everything, including the destinations form.
    fetchData()
      .then((data) => {
        if (!alive) return;
        const biz: Biz[] = Array.isArray(data.businesses) ? data.businesses : [];
        setBusinesses(biz);
        setOutbox(Array.isArray(data.outbox) ? data.outbox : []);
        setSession(data.session ?? null);
        const first = biz[0]?.id ?? "";
        setBusinessId(first);
        applyBusiness(biz, first);
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));

    // Poll refreshes ONLY the connection + delivery log — never the form the user may be
    // editing (so a rotating QR / new deliveries show up without clobbering inputs).
    const t = setInterval(() => {
      fetchData()
        .then((data) => {
          if (!alive) return;
          setSession(data.session ?? null);
          setOutbox(Array.isArray(data.outbox) ? data.outbox : []);
        })
        .catch(() => {});
    }, 6000);

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchData, applyBusiness]);

  function selectBusiness(id: string) {
    setBusinessId(id);
    applyBusiness(businesses, id);
    setSaved(false);
  }

  async function save() {
    if (!businessId || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_id: businessId, group_id: groupId, staff_numbers: numbers }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) return setError(data?.error || "Couldn't save.");
    setSaved(true);
    // Refresh the businesses list (saved values) without disturbing the form or the poll.
    fetchData()
      .then((d) => {
        setBusinesses(Array.isArray(d.businesses) ? d.businesses : []);
        setOutbox(Array.isArray(d.outbox) ? d.outbox : []);
        setSession(d.session ?? null);
      })
      .catch(() => {});
  }

  const showBizPicker = businesses.length > 1;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">WhatsApp</h1>
      <p className="text-[13px] text-[var(--text-4)]">
        Log in, choose where confirmations are sent, and see whether they went through.
      </p>

      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--danger)]">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" />
          {error}
        </p>
      )}

      {/* Connection / login */}
      <ConnectionCard session={session} loading={loading} />

      {/* Destinations */}
      <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-bold text-[var(--text-1)]">Destinations</h2>
          {showBizPicker && (
            <select
              value={businessId}
              onChange={(e) => selectBusiness(e.target.value)}
              aria-label="Business"
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {businesses.length === 0 ? (
          <p className="mt-3 text-[12px] text-[var(--text-4)]">No business to configure yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-5)]">
                Reservation-team group id
              </span>
              <input
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setSaved(false);
                }}
                placeholder="1203…@g.us"
                className="mt-1 w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
              />
              <span className="mt-1 block text-[10px] text-[var(--text-5)]">
                Find it in the worker&apos;s startup log (it prints every group&apos;s id). Leave blank to send to numbers only.
              </span>
            </label>

            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-5)]">
                Staff numbers
              </span>
              <input
                value={numbers}
                onChange={(e) => {
                  setNumbers(e.target.value);
                  setSaved(false);
                }}
                placeholder="919876543210, 919812345678"
                className="mt-1 w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
              />
              <span className="mt-1 block text-[10px] text-[var(--text-5)]">
                Comma-separated, with country code, no “+”. Confirmations go to the group and each number.
              </span>
            </label>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                <Save size={13} />
                {saving ? "Saving…" : "Save"}
              </button>
              {saved && (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-[var(--ok)]">
                  <Check size={12} /> Saved
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Delivery log */}
      <div className="mt-6 mb-2 flex items-center gap-2">
        <MessageCircle size={15} className="text-[var(--accent)]" />
        <h2 className="text-[14px] font-bold text-[var(--text-1)]">Delivery log</h2>
        <span className="text-[10px] text-[var(--text-5)]">last 50</span>
      </div>

      {loading ? (
        <p className="text-xs text-[var(--text-4)]">Loading…</p>
      ) : outbox.length === 0 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] py-12 text-center">
          <MessageCircle size={22} className="mx-auto text-[var(--text-5)]" />
          <p className="mt-3 text-[13px] font-bold text-[var(--text-1)]">Nothing sent yet</p>
          <p className="mt-1 text-[12px] text-[var(--text-4)]">
            Order &amp; reservation confirmations will appear here as they&apos;re queued.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {outbox.map((r) => {
            const s = STATUS[r.status] ?? STATUS.pending;
            return (
              <div
                key={r.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${s.cls}`}>
                      {s.icon}
                      {s.label}
                    </span>
                    <span className="text-[12px] font-bold text-[var(--text-1)]">
                      {r.kind === "takeaway" ? "Takeaway" : "Reservation"}
                    </span>
                    <span className="truncate text-[12px] text-[var(--text-3)]">
                      {r.customer_name || "Guest"}
                    </span>
                    {r.account_username && (
                      <span className="text-[10px] text-[var(--text-5)]">@{r.account_username}</span>
                    )}
                    {r.business_name && showBizPicker && (
                      <span className="text-[10px] text-[var(--text-5)]">· {r.business_name}</span>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-[10px] text-[var(--text-5)]">{relTime(r.created_at)}</span>
                </div>
                <p className="mt-1 truncate text-[11px] text-[var(--text-4)]">{r.body}</p>
                {r.status === "failed" && r.last_error && (
                  <p className="mt-1 text-[10px] font-semibold text-[var(--danger)]">
                    {r.last_error} (attempt {r.attempts})
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
