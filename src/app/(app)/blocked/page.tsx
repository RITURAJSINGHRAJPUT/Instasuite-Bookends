"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, UserX, AlertTriangle, X } from "lucide-react";

// The global do-not-reply list. Same shape as the Quick Replies page (inline add-form,
// flat list, delete "X", no modal) minus the brand picker — this list is deliberately
// NOT per business: one entry silences a handle on every connected account.

type Blocked = {
  id: string;
  username: string;
  reason: string | null;
  created_by_email: string | null;
  created_at: string;
};

const INPUT =
  "rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none md:text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--text-5)]">{label}</p>
      {children}
    </div>
  );
}

export default function BlockedPage() {
  const [rows, setRows] = useState<Blocked[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [username, setUsername] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/blocked");
    const data = await res.json();
    if (!res.ok) setError(data?.error || "Couldn't load the blocked list.");
    else setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const canSubmit = !!username.trim() && !saving;

  async function add() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/blocked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The '@' is stripped server-side by normalizeHandle, so pasting either form works.
      body: JSON.stringify({ username: username.trim(), reason: reason.trim() }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) return setError(data?.error || "Couldn't block that username.");
    setUsername("");
    setReason("");
    load();
  }

  async function remove(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/blocked/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-extrabold tracking-tight text-[var(--text-1)]">Blocked</h1>
      <p className="text-[13px] text-[var(--text-4)]">
        Usernames the AI never replies to. A block applies to{" "}
        <span className="font-semibold text-[var(--text-2)]">every connected account</span> — their
        messages still appear in the Inbox, they just get no automatic answer. You can still reply
        by hand.
      </p>

      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <div className="flex flex-col gap-3">
          <Field label="Instagram username">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-[var(--text-5)]">@</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="e.g. spamguy"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`w-full ${INPUT}`}
              />
            </div>
          </Field>
          <Field label="Reason (optional)">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. Repeated collab spam"
              className={`w-full ${INPUT}`}
            />
            <p className="mt-1 text-[10px] text-[var(--text-5)]">
              For your team only — never sent to the guest.
            </p>
          </Field>
        </div>
        <button
          onClick={add}
          disabled={!canSubmit}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          <Plus size={14} />
          Block
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
          <UserX size={20} className="mx-auto text-[var(--text-5)]" />
          <p className="mt-2 text-[12px] font-bold text-[var(--text-1)]">No one is blocked</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-4)]">
            Add a username above to stop the AI replying to them.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-[var(--text-1)]">@{r.username}</p>
              <p className="mt-0.5 truncate text-[11px] text-[var(--text-4)]">
                {r.reason || "No reason given"}
                {r.created_by_email && (
                  <span className="text-[var(--text-5)]"> · added by {r.created_by_email}</span>
                )}
              </p>
            </div>
            <button
              onClick={() => remove(r.id)}
              aria-label={`Unblock ${r.username}`}
              title="Unblock"
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
