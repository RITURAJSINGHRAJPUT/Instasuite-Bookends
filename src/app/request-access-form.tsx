"use client";

import { useState } from "react";

// The landing page is a Server Component, so the interactive form lives here
// as a client island.
export default function RequestAccessForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: fd.get("name"),
        email: fd.get("email"),
        instagram_handle: fd.get("instagram_handle"),
        message: fd.get("message"),
        website: fd.get("website"), // honeypot — must stay empty
      }),
    });

    setLoading(false);
    if (res.ok) setSent(true);
    else {
      const d = await res.json().catch(() => ({}));
      setError(d?.error || "Something went wrong. Please try again.");
    }
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-[var(--ok)]/25 bg-[var(--ok-soft)] p-6 text-center">
        <p className="text-sm font-bold text-[var(--ok)]">Thanks — request received.</p>
        <p className="mt-1 text-xs text-[var(--text-4)]">
          We&apos;ll review it and get in touch about setting up your account.
        </p>
      </div>
    );
  }

  const field =
    "w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base md:text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none";

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-6">
      <div className="grid gap-3 md:grid-cols-2">
        <input name="name" required placeholder="Your name" className={field} />
        <input name="email" type="email" required placeholder="you@business.com" className={field} />
      </div>
      <input name="instagram_handle" placeholder="@yourbusiness" className={`${field} mt-3`} />
      <textarea
        name="message"
        rows={3}
        placeholder="What would you like the agent to handle? (optional)"
        className={`${field} mt-3 resize-none`}
      />

      {/* Honeypot: hidden from humans, catnip for bots. Never remove. */}
      <input
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />

      {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="mt-4 w-full rounded-xl bg-[var(--accent)] py-2.5 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
      >
        {loading ? "Sending…" : "Request access"}
      </button>
      <p className="mt-3 text-center text-[10px] text-[var(--text-5)]">
        We onboard accounts manually, so there&apos;s no instant signup — we&apos;ll reply by email.
      </p>
    </form>
  );
}
