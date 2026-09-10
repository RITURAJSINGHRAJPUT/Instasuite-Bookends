"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { Loader2, Lock } from "lucide-react";

// This page has to accept TWO different callback shapes, and they are mutually
// incompatible with auto-detection:
//
//   ?code=...           PKCE     — "Forgot password?" on /login, which starts in the
//                                  browser and can stash a code verifier.
//   #access_token=...   implicit — the admin-generated setup link from /users. There
//                                  is no browser-side verifier, so it can't be PKCE.
//
// createBrowserClient hardcodes flowType:"pkce" *after* spreading options, so it
// cannot be overridden — and auth-js throws "Not a valid PKCE flow url." when a
// PKCE client meets an implicit callback. detectSessionInUrl would therefore reject
// every setup link and the page would blame the user with "invalid or has expired".
//
// So: detection off, and we consume whichever shape actually arrived. setSession()
// doesn't care about flowType.
export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { detectSessionInUrl: false } }
      ),
    []
  );

  useEffect(() => {
    (async () => {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const query = new URLSearchParams(window.location.search);

      // A genuinely dead link comes back as an error in the fragment. Report what
      // Supabase actually said instead of guessing.
      const errDesc = hash.get("error_description") ?? query.get("error_description");
      if (errDesc) {
        setError(`${errDesc}. Request a new link from the login page.`);
        return;
      }

      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const code = query.get("code");

      let failed: string | null = null;

      if (accessToken && refreshToken) {
        const { error: e } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        failed = e?.message ?? null;
      } else if (code) {
        const { error: e } = await supabase.auth.exchangeCodeForSession(code);
        failed = e?.message ?? null;
      } else {
        // No callback in the URL — only valid if a session already exists (e.g. a
        // reload after the tokens were stripped below).
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          setError("This reset link is invalid or has expired. Request a new one from the login page.");
          return;
        }
        setReady(true);
        return;
      }

      if (failed) {
        setError(`${failed}. Request a new link from the login page.`);
        return;
      }

      // Drop the credentials from the address bar once they're exchanged, so they
      // don't linger in history or get shared in a screenshot.
      window.history.replaceState(null, "", window.location.pathname);
      setReady(true);
    })();
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || !password) return;
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");

    setLoading(true);
    setError(null);
    // `data` maps to user_metadata, so the new password and the cleared flag land in ONE
    // call — they can't half-succeed and strand the user in the proxy's redirect loop.
    // Harmless for someone who arrived by a normal reset link and never had the flag.
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { must_change_password: false },
    });
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    setDone(true);
    setLoading(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-4 font-sans">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ background: "var(--brand-gradient)" }}
          >
            <Lock size={26} color="#fff" strokeWidth={2.5} />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-bold tracking-tight text-[var(--text-1)]">Set a new password</h1>
            <p className="mt-1 text-xs text-[var(--text-4)]">Choose a password for your account</p>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-6">
          {done ? (
            <div className="text-center">
              <p className="text-sm text-[var(--ok)]">Password updated.</p>
              <a
                href="/login"
                className="mt-4 inline-block rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                Go to sign in
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <label className="mb-2 block text-xs font-medium text-[var(--text-4)]">New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={!ready}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base md:text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-40"
              />

              <label className="mb-2 mt-4 block text-xs font-medium text-[var(--text-4)]">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={!ready}
                autoComplete="new-password"
                placeholder="Repeat it"
                className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-2.5 text-base md:text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-40"
              />

              {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}

              <button
                type="submit"
                disabled={loading || !ready || !password || !confirm}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : "Update password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
