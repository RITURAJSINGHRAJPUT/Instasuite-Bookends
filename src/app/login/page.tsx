"use client";

import { useRef, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { Loader2 } from "lucide-react";
import { LogoMark } from "@/components/Logo";
import { firstAllowedRoute } from "@/lib/permissions";

export default function LoginPage() {
  // Uncontrolled inputs read via refs: browser/password-manager autofill often
  // fills the field WITHOUT firing React's onChange, so controlled state can stay
  // empty (button disabled, submit no-ops) even when the fields look filled. The
  // DOM value is always correct, so we read it at submit time.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    const email = emailRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setLoading(true);
    setError(null);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      if (passwordRef.current) passwordRef.current.value = "";
      setLoading(false);
      return;
    }

    // Respect an explicit ?from=, else land on the first section this role can use
    // (an agent has no Overview, so /dashboard would just bounce to "no access").
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    if (from) {
      window.location.href = from;
      return;
    }
    const me = await fetch("/api/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // If /api/me somehow didn't resolve, fall back to the overview — the proxy and
    // the page guard still apply, so this never lands anyone somewhere unsafe.
    window.location.href = me?.role ? firstAllowedRoute(me.role) : "/dashboard";
  }

  async function handleForgot() {
    const email = emailRef.current?.value.trim() ?? "";
    if (!email) {
      setError("Enter your email first, then choose 'Forgot password?'.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset`,
    });

    // Don't reveal whether the address exists; report send failures plainly
    // (the built-in mailer is rate-limited to a couple of sends per hour).
    if (resetError) setError(resetError.message);
    else setNotice("If that email has an account, a reset link is on its way.");
    setLoading(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-4 font-sans">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <LogoMark size="lg" />
          <div className="text-center">
            <h1 className="text-lg font-bold tracking-tight text-[var(--text-1)]">Instasuite</h1>
            <p className="mt-1 text-xs text-[var(--text-4)]">Sign in to open your dashboard</p>
          </div>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-6"
        >
          <label className="mb-2 block text-xs font-medium text-[var(--text-4)]">Email</label>
          <input
            type="email"
            name="email"
            ref={emailRef}
            autoFocus
            autoComplete="email"
            placeholder="you@example.com"
            className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-[16px] md:text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
          />

          <label className="mb-2 mt-4 block text-xs font-medium text-[var(--text-4)]">Password</label>
          <input
            type="password"
            name="password"
            ref={passwordRef}
            autoComplete="current-password"
            placeholder="Your password"
            className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-[16px] md:text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
          />

          {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}
          {notice && <p className="mt-3 text-xs text-[var(--ok)]">{notice}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : "Sign in"}
          </button>

          <button
            type="button"
            onClick={handleForgot}
            disabled={loading}
            className="mt-3 w-full text-center text-xs text-[var(--text-4)] hover:text-[var(--text-2)] transition-colors disabled:opacity-40"
          >
            Forgot password?
          </button>
        </form>
      </div>
    </div>
  );
}
