"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, CircleSlash, UtensilsCrossed, Store, AlertTriangle, X } from "lucide-react";

// Two columns: 86'd DISHES (left) and closed OUTLETS (right). The AI agent reads the active rows of
// both (src/lib/availability.ts → the tenant system prompt): it stops offering a 86'd dish, and stops
// taking reservations/takeaways for a closed outlet. Outlets and dishes are free text — the menu isn't
// structured data.

type Scope = "today" | "custom" | "open";
type Outlet = { id: string; name: string };
type Biz = { id: string; name: string; outlets: Outlet[] };

type DishRow = {
  id: string;
  business_name: string | null;
  dish: string;
  outlet: string | null;
  note: string | null;
  ends_at: string | null;
};
type OutletRow = {
  id: string;
  business_name: string | null;
  outlet: string;
  note: string | null;
  ends_at: string | null;
};

// The restaurant operates in IST; show end times there (consistent with the AI block), regardless of
// where the operator's browser is.
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

// Shared Today / Until… / No end control.
function ScopeToggle({ scope, setScope }: { scope: Scope; setScope: (s: Scope) => void }) {
  return (
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
  );
}

const INPUT =
  "rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none md:text-sm";

// A labelled step in the add-form, so the flow reads Brand → Outlet → … top to bottom.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--text-5)]">{label}</p>
      {children}
    </div>
  );
}

// Shared brand selector (only meaningful with >1 brand) + the outlet dropdown, reused by both columns.
function BrandSelect({ businesses, businessId, setBusinessId }: ColProps) {
  return (
    <select
      value={businessId}
      onChange={(e) => setBusinessId(e.target.value)}
      aria-label="Brand"
      className={`w-full ${INPUT}`}
    >
      {businesses.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}

type ColProps = {
  businesses: Biz[];
  businessId: string;
  setBusinessId: (id: string) => void;
};

export default function UnavailablePage() {
  const [businesses, setBusinesses] = useState<Biz[]>([]);
  const [businessId, setBusinessId] = useState("");

  useEffect(() => {
    fetch("/api/unavailable/businesses")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Biz[]) => {
        const list = Array.isArray(d)
          ? d.map((b) => ({ id: b.id, name: b.name, outlets: b.outlets ?? [] }))
          : [];
        setBusinesses(list);
        setBusinessId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Unavailable</h1>
      <p className="text-[13px] text-[var(--text-4)]">
        Mark a dish that&apos;s run out, or an outlet that&apos;s fully shut. While it&apos;s listed the
        AI agent won&apos;t offer the dish, or take bookings for the outlet — each clears automatically
        when its window ends.
      </p>

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <DishColumn businesses={businesses} businessId={businessId} setBusinessId={setBusinessId} />
        <OutletColumn businesses={businesses} businessId={businessId} setBusinessId={setBusinessId} />
      </div>
    </div>
  );
}

function ColumnShell({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-[14px] font-bold text-[var(--text-1)]">{title}</h2>
        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent)]">
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

function DishColumn({ businesses, businessId, setBusinessId }: ColProps) {
  const [rows, setRows] = useState<DishRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dish, setDish] = useState("");
  const [outlet, setOutlet] = useState("");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<Scope>("today");
  const [until, setUntil] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/unavailable");
    const data = await res.json();
    if (!res.ok) setError(data?.error || "Couldn't load dishes.");
    else setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Outlet options come from the selected brand; clear the choice when the brand changes so a
  // Capiche outlet can't linger when Aiko is selected.
  const outlets = businesses.find((b) => b.id === businessId)?.outlets ?? [];
  useEffect(() => {
    setOutlet("");
  }, [businessId]);

  const canSubmit = !!dish.trim() && !!businessId && !saving && (scope !== "custom" || !!until);

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
    setRows((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/unavailable/${id}`, { method: "DELETE" });
    load();
  }

  const showBiz = businesses.length > 1;

  return (
    <ColumnShell
      icon={<UtensilsCrossed size={15} className="text-[var(--accent)]" />}
      title="Unavailable dishes"
      count={rows.length}
    >
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <div className="flex flex-col gap-3">
          {showBiz && (
            <Field label="Brand">
              <BrandSelect businesses={businesses} businessId={businessId} setBusinessId={setBusinessId} />
            </Field>
          )}
          <Field label="Outlet">
            <select
              value={outlet}
              onChange={(e) => setOutlet(e.target.value)}
              aria-label="Outlet"
              className={`w-full ${INPUT}`}
            >
              <option value="">All outlets</option>
              {outlets.map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Dish">
            <input
              value={dish}
              onChange={(e) => setDish(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. Truffle Pizza"
              className={`w-full ${INPUT}`}
            />
          </Field>
          <Field label="Unavailable for">
            <div className="flex flex-wrap items-center gap-2">
              <ScopeToggle scope={scope} setScope={setScope} />
              {scope === "custom" && (
                <input
                  type="datetime-local"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--text-1)] focus:border-[var(--accent)] focus:outline-none"
                />
              )}
            </div>
          </Field>
          <Field label="Note (optional)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. back tomorrow"
              className={`w-full ${INPUT}`}
            />
          </Field>
        </div>
        <button
          onClick={add}
          disabled={!canSubmit}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          <Plus size={14} />
          Add
        </button>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--danger)]">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" />
          {error}
        </p>
      )}

      {loading && <p className="mt-4 text-xs text-[var(--text-4)]">Loading…</p>}

      {!loading && rows.length === 0 && (
        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] py-10 text-center">
          <CircleSlash size={20} className="mx-auto text-[var(--text-5)]" />
          <p className="mt-2 text-[12px] font-bold text-[var(--text-1)]">Every dish is available</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-4)]">Add one above when you run out.</p>
        </div>
      )}

      <div className="mt-4 space-y-2">
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
                {showBiz && r.business_name && (
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
    </ColumnShell>
  );
}

function OutletColumn({ businesses, businessId, setBusinessId }: ColProps) {
  const [rows, setRows] = useState<OutletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [outlet, setOutlet] = useState("");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<Scope>("today");
  const [until, setUntil] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/unavailable/outlets");
    const data = await res.json();
    if (!res.ok) setError(data?.error || "Couldn't load outlets.");
    else setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Outlet options come from the selected brand; clear the choice when the brand changes.
  const outlets = businesses.find((b) => b.id === businessId)?.outlets ?? [];
  useEffect(() => {
    setOutlet("");
  }, [businessId]);

  const canSubmit = !!outlet.trim() && !!businessId && !saving && (scope !== "custom" || !!until);

  async function add() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/unavailable/outlets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business_id: businessId,
        outlet: outlet.trim(),
        note: note.trim() || undefined,
        scope,
        until: scope === "custom" && until ? new Date(until).toISOString() : undefined,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) return setError(data?.error || "Couldn't add that.");
    setOutlet("");
    setNote("");
    setUntil("");
    setScope("today");
    load();
  }

  async function remove(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/unavailable/outlets/${id}`, { method: "DELETE" });
    load();
  }

  const showBiz = businesses.length > 1;

  return (
    <ColumnShell
      icon={<Store size={15} className="text-[var(--accent)]" />}
      title="Closed outlets"
      count={rows.length}
    >
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <div className="flex flex-col gap-3">
          {showBiz && (
            <Field label="Brand">
              <BrandSelect businesses={businesses} businessId={businessId} setBusinessId={setBusinessId} />
            </Field>
          )}
          <Field label="Outlet">
            <select
              value={outlet}
              onChange={(e) => setOutlet(e.target.value)}
              aria-label="Outlet"
              disabled={outlets.length === 0}
              className={`w-full ${INPUT} disabled:opacity-60`}
            >
              <option value="" disabled>
                {outlets.length ? "Select an outlet…" : "No outlets — add on the Businesses page"}
              </option>
              {outlets.map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Closed for">
            <div className="flex flex-wrap items-center gap-2">
              <ScopeToggle scope={scope} setScope={setScope} />
              {scope === "custom" && (
                <input
                  type="datetime-local"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--text-1)] focus:border-[var(--accent)] focus:outline-none"
                />
              )}
            </div>
          </Field>
          <Field label="Note (optional)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. staff shortage"
              className={`w-full ${INPUT}`}
            />
          </Field>
        </div>
        <button
          onClick={add}
          disabled={!canSubmit}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          <Plus size={14} />
          Add
        </button>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--danger)]">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" />
          {error}
        </p>
      )}

      {loading && <p className="mt-4 text-xs text-[var(--text-4)]">Loading…</p>}

      {!loading && rows.length === 0 && (
        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] py-10 text-center">
          <Store size={20} className="mx-auto text-[var(--text-5)]" />
          <p className="mt-2 text-[12px] font-bold text-[var(--text-1)]">All outlets open</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-4)]">Add one above when an outlet shuts.</p>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-[14px] font-bold text-[var(--text-1)]">{r.outlet}</p>
                <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--danger)]">
                  closed
                </span>
                {showBiz && r.business_name && (
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
              aria-label="Reopen outlet"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--danger)]"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ColumnShell>
  );
}
