"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { AlertTriangle } from "lucide-react";
import type { ConversationWithLastMessage, Message } from "@/lib/types";
import AccountInbox, { type ConnectedAccount } from "./AccountInbox";

// The inbox shell. Each connected account gets its own full panel (list + thread)
// via AccountInbox, so two accounts can be worked side by side.
//
// What stays HERE rather than in the panels, and why:
//   - the conversation list: one fetch, sliced per account. Two panels fetching
//     the same endpoint independently would double the work and let them drift.
//   - the Realtime subscription: ONE socket. Panels receive the newest insert as a
//     prop and decide for themselves whether it belongs to their open conversation.
// The panels own only what is genuinely per-account: selection, the open thread,
// the composer.

type ScriptRow = { id: string; name: string };

// useSearchParams (to open the conversation named in ?conversation=, set by the Orders
// page's "Open chat" link) opts the route out of static prerender unless it sits in a
// Suspense boundary — so the page splits into a wrapper + this inner component. Same
// shape as /scripts and /orders.
export default function InboxPage() {
  return (
    <Suspense fallback={<p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>}>
      <InboxInner />
    </Suspense>
  );
}

function InboxInner() {
  const params = useSearchParams();
  const router = useRouter();

  // The conversation to open on arrival, captured on the FIRST render and then consumed.
  //
  // A lazy useState initializer rather than an effect: it pins the value before the URL
  // is cleared, so the panels are handed it no matter how the clear is scheduled, and the
  // effect below is left with nothing to do but tidy the address bar.
  //
  // Clearing matters because otherwise a refresh would yank the selection back to the
  // order's thread after the user had already moved on to a different chat.
  const [focusId] = useState<string | null>(() => params.get("conversation"));
  useEffect(() => {
    if (focusId) router.replace("/inbox", { scroll: false });
  }, [focusId, router]);

  // Session-aware client (reads the auth cookie), not a bare anon client. Realtime
  // enforces RLS per event and the policies are `to authenticated` keyed on
  // auth.uid() — an unauthenticated socket matches zero rows.
  const supabase = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    return createBrowserClient(url, key);
  }, []);

  const [conversations, setConversations] = useState<ConversationWithLastMessage[]>([]);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [activeAccount, setActiveAccount] = useState<string>("all");
  const [liveMessage, setLiveMessage] = useState<Message | null>(null);

  const fetchConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(Array.isArray(data) ? data : []);
  }, []);

  const fetchAccount = useCallback(async () => {
    try {
      const res = await fetch("/api/account");
      const data = await res.json();
      if (!res.ok) {
        setAccounts([]);
        setAccountError(data?.error || "Couldn't load your connected accounts.");
        return;
      }
      setAccounts(Array.isArray(data) ? data : []);
      setAccountError(null);
    } catch {
      setAccounts([]);
      setAccountError("Couldn't reach the server.");
    }
  }, []);

  // Read by the Realtime handler so the channel subscribes ONCE and still calls the
  // latest refetch, rather than being torn down and rebuilt (which drops events).
  const fetchConversationsRef = useRef(fetchConversations);
  useEffect(() => {
    fetchConversationsRef.current = fetchConversations;
  }, [fetchConversations]);

  useEffect(() => {
    fetchConversations();
    fetchAccount();
    fetch("/api/scripts")
      .then((r) => (r.ok ? r.json() : []))
      .then(setScripts)
      .catch(() => {});
  }, [fetchConversations, fetchAccount]);

  // Realtime below is the primary path; this slow poll is the floor under it. When the
  // socket goes quiet — an expired JWT, a dropped connection, Supabase's per-client event
  // cap — nothing surfaces that, and the Inbox simply stops updating until someone reloads
  // the tab. With this, the worst case is 60s stale instead of silently frozen.
  //
  // Skipped while the tab is hidden: this app is the kind of thing that sits open in a
  // background tab all day, and polling for nobody is just load on our own API.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetchConversations();
      fetchAccount();
    }, 60_000);
    return () => clearInterval(t);
  }, [fetchConversations, fetchAccount]);

  useEffect(() => {
    if (!supabase) return;
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
        .channel("realtime-instagram-messages")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "instagram_messages" },
          (payload) => {
            // Published to every panel; each ignores it unless it matches the
            // conversation that panel has open.
            setLiveMessage(payload.new as Message);
            fetchConversationsRef.current();
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "instagram_conversations" },
          () => fetchConversationsRef.current()
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
  }, [supabase]);

  // Split only when nothing is filtered and there's more than one account. Picking a
  // single account is the deliberate escape hatch on a narrow screen — one panel,
  // full width, context aside back.
  const splitView = activeAccount === "all" && accounts.length > 1;
  const panelAccounts = splitView
    ? accounts
    : accounts.filter((a) => activeAccount === "all" || a.id === activeAccount);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-extrabold tracking-tight text-[var(--text-1)]">Inbox</h1>
          <p className="text-[10px] text-[var(--text-4)]">
            {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
            {accounts.length > 1 && ` across ${accounts.length} accounts`}
          </p>
        </div>

        {accounts.length > 1 && (
          <select
            value={activeAccount}
            onChange={(e) => setActiveAccount(e.target.value)}
            aria-label="Filter by account"
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-2 text-xs font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="all">All accounts ({accounts.length})</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.username ? `@${a.username}` : a.ig_account_id}
              </option>
            ))}
          </select>
        )}
      </div>

      {accountError && (
        <p className="mx-4 mt-3 flex items-start gap-1.5 rounded-lg bg-[var(--danger-soft)] px-2.5 py-2 text-[10px] font-semibold text-[var(--danger)]">
          <AlertTriangle size={12} className="mt-px flex-shrink-0" />
          {accountError}
        </p>
      )}

      {panelAccounts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-xs text-[var(--text-5)]">No connected accounts yet.</p>
        </div>
      ) : (
        // Panels scroll horizontally rather than being crushed: two full inboxes
        // need real width, and a squeezed one is useless. Below md there's only
        // ever one, so the mobile push behaviour inside each panel still applies.
        <div className="flex min-h-0 min-w-0 flex-1 overflow-x-auto">
          {panelAccounts.map((account) => (
            <div
              key={account.id}
              className={`flex min-h-0 min-w-0 flex-1 border-r border-[var(--border)] last:border-r-0 ${
                splitView ? "md:min-w-[520px]" : ""
              }`}
            >
              <AccountInbox
                account={account}
                conversations={conversations.filter(
                  (c) => c.instagram_account_id === account.id
                )}
                scripts={scripts}
                liveMessage={liveMessage}
                onChanged={fetchConversations}
                showContext={!splitView}
                // Handed to every panel; only the one that actually owns this
                // conversation acts on it.
                focusConversationId={focusId}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
