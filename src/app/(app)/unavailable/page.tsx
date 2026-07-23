"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, CircleSlash, AlertTriangle, X } from "lucide-react";

// Staff mark a dish 86'd at an outlet, for today / a custom window / until cleared. The
// AI agent reads the active rows (src/lib/availability.ts → the tenant system prompt) and
// stops offering them. Outlets and dishes are free text — the menu isn't structured data.

type Row = {
  id: string;
  business_id: string;
  business_name: string | null;
  dish: string;
  outlet: string | null;
  note: string | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
};

type Biz = { id: string; name: string };

type Scope = "today" | "custom" | "open";

// The restaurant operates in IST; show end times there (consistent with the AI block),
// regardless of where the operator's browser is.
function fmtUntil(endsAt: string | null): string {
  if (!endsAt) return "until further notice";
  const when = new Date(endsAt).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `until ${when}`;
}

export default function UnavailablePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [businesses, setBusinesses] = useState<Biz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Add-form fields.
  const [businessId, setBusinessId] = useState("");
  const [dish, setDish] = useState("");
  const [outlet, setOutlet] = useState("");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<Scope>("today");
  const [until, setUntil] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/unavailable");
    const data = await res.json();
    if (!res.ok) setError(data?.error || "Couldn't load the list.");
    else setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Businesses populate the outlet's owning-business picker (only shown when >1).
    fetch("/api/businesses")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Biz[]) => {
        const list = Array.isArray(d) ? d.map((b) => ({ id: b.id, name: b.name })) : [];
        setBusinesses(list);
        if (list.length && !businessId) setBusinessId(list[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const canSubmit =
    !!dish.trim() && !!businessId && !saving && (scope !== "custom" || !!until);

  async function add() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/unavailable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business_id: businessId,
        dish: dish.trim(),
        outlet: outlet.trim() || undefined,
        note: note.trim() || undefined,
        scope,
        // datetime-local is wall-clock in the operator's browser — convert to an
        // absolute instant so the server stores it unambiguously.
        until: scope === "custom" && until ? new Date(until).toISOString() : undefined,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) return setError(data?.error || "Couldn't add that.");
    setDish("");
    setOutlet("");
    setNote("");
    setUntil("");
    setScope("today");
    load();
  }

  async function remove(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id)); // optimistic
    await fetch(`/api/unavailable/${id}`, { method: "DELETE" });
    load();
  }

  const showBizPicker = businesses.length > 1;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Unavailable</h1>
      <p className="text-[13px] text-[var(--text-4)]">
        Mark a dish that&apos;s run out at an outlet. While it&apos;s listed, the AI agent won&apos;t
        offer it — it clears automatically when the window ends.
      </p>

      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--danger)]">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" />
          {error}
        </p>
      )}

      {/* Add form */}
      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={dish}
            onChange={(e) => setDish(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Dish (e.g. Truffle Pizza)"
            className="flex-1 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none md:text-sm"
          />
          <input
            value={outlet}
            onChange={(e) => setOutlet(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Outlet (optional — blank = all)"
            className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none sm:w-56 md:text-sm"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Time scope */}
          <div className="flex rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
            {(
              [
                ["today", "Today"],
                ["custom", "Until…"],
                ["open", "No end"],
              ] as [Scope, string][]
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setScope(val)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  scope === val
                    ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "text-[var(--text-4)] hover:text-[var(--text-2)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {scope === "custom" && (
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--text-1)] focus:border-[var(--accent)] focus:outline-none"
            />
          )}

          {showBizPicker && (
            <select
              value={businessId}
              onChange={(e) => setBusinessId(e.target.value)}
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

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Note (optional)"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
          />

          <button
            onClick={add}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            <Plus size={13} />
            Add
          </button>
        </div>
      </div>

      {loading && <p className="mt-6 text-xs text-[var(--text-4)]">Loading…</p>}

      {!loading && rows.length === 0 && (
        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] py-12 text-center">
          <CircleSlash size={22} className="mx-auto text-[var(--text-5)]" />
          <p className="mt-3 text-[13px] font-bold text-[var(--text-1)]">Everything&apos;s available</p>
          <p className="mt-1 text-[12px] text-[var(--text-4)]">
            Nothing is 86&apos;d right now. Add a dish above when you run out.
          </p>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-[14px] font-bold text-[var(--text-1)]">{r.dish}</p>
                <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold text-[var(--text-4)]">
                  {r.outlet?.trim() || "all outlets"}
                </span>
                {showBizPicker && r.business_name && (
                  <span className="text-[10px] text-[var(--text-5)]">{r.business_name}</span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--text-4)]">
                {fmtUntil(r.ends_at)}
                {r.note?.trim() ? ` · ${r.note.trim()}` : ""}
              </p>
            </div>
            <button
              onClick={() => remove(r.id)}
              aria-label="Mark available"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--danger)]"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
