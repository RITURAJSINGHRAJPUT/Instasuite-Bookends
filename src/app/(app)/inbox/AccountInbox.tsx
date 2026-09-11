"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  MessageSquare,
  ChevronLeft,
  Trash2,
  Send,
  Loader2,
  User,
  Bot,
  Hand,
  FileText,
  UserCheck,
  Clock,
  Receipt,
  AlertTriangle,
  Zap,
  ImageOff,
  X,
} from "lucide-react";
import type { ConversationWithLastMessage, Message } from "@/lib/types";
import type { Media, MediaKind } from "@/lib/attachments";

// One complete inbox for a single Instagram account: header, conversation list,
// thread, composer. Rendered once per account so two accounts can be worked side
// by side with independent selections.
//
// Deliberate split of responsibilities with the parent page:
//   parent  — accounts, the shared conversation list, ONE Realtime subscription
//   here    — selection, the open thread's messages, the composer, delete
// Two panels must not mean two sockets or two copies of the same list, so inbound
// messages arrive as the `liveMessage` prop and each panel decides whether the
// message belongs to the conversation IT has open.

export type ConnectedAccount = {
  id: string;
  ig_account_id: string;
  username: string | null;
  name: string | null;
  profile_picture_url: string | null;
  status: string;
  business_id: string | null;
  script_id: string | null;
  businesses: { name: string; default_script_id: string | null } | null;
};

type ScriptRow = { id: string; name: string };

export function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getInitials(name: string | null, igsid: string) {
  if (name) return name.slice(0, 2).toUpperCase();
  return igsid.slice(-2);
}

// Has this thread actually moved? Messages are append-only and never edited in place, so
// length plus the last row's id settles it without walking the array. Used to keep the
// messages array's IDENTITY stable across a poll that found nothing new — the auto-scroll
// effect keys off that identity, so a fresh array every minute would drag anyone reading
// back through a long chat down to the bottom.
function sameThread(a: Message[], b: Message[]) {
  return a.length === b.length && a[a.length - 1]?.id === b[b.length - 1]?.id;
}

// Header for the Ongoing / Completed groups in the conversation list.
function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-1.5">
      <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-4)]">{label}</span>
      <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--text-4)]">
        {count}
      </span>
    </div>
  );
}

export function Avatar({
  src,
  name,
  igsid,
  size,
}: {
  src: string | null;
  name: string | null;
  igsid: string;
  size: number;
}) {
  const cls =
    "rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold overflow-hidden";
  const style = { width: size, height: size, minWidth: size, fontSize: size * 0.3 };
  if (src) {
    return (
      <div className={cls} style={style}>
        <Image
          src={src}
          alt={name || igsid}
          width={size}
          height={size}
          className="h-full w-full rounded-full object-cover"
          unoptimized
        />
      </div>
    );
  }
  return (
    <div className={cls} style={{ ...style, background: "var(--brand-gradient)" }}>
      {getInitials(name, igsid)}
    </div>
  );
}

const MEDIA_LABEL: Record<MediaKind, string> = {
  story_reply: "Replied to your story",
  story_mention: "Mentioned you in their story",
  post: "Shared a post",
  reel: "Shared a reel",
  image: "Sent a photo",
  video: "Sent a video",
  audio: "Sent a voice message",
  other: "Sent an attachment",
};

/**
 * A story reply / shared post, shown above the message the way Instagram does.
 *
 * We store Meta's CDN URL rather than a copy of the file, and those links are
 * short-lived — so an expired thumbnail is the NORMAL end state for older chats,
 * not an error. `failed` swaps in a deliberate placeholder so it reads as "this
 * has aged out" rather than looking broken.
 */
function MediaCard({ media, align }: { media: Media; align: "start" | "end" }) {
  const [failed, setFailed] = useState(false);
  const label = MEDIA_LABEL[media.kind] ?? MEDIA_LABEL.other;
  const showImage = !!media.url && !failed;

  return (
    <div className={`mb-1 flex flex-col ${align === "start" ? "items-start" : "items-end"}`}>
      <p className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-5)]">
        {label}
      </p>
      {showImage ? (
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
          <Image
            src={media.url as string}
            alt={label}
            width={160}
            height={280}
            className="h-[200px] w-[112px] object-cover"
            onError={() => setFailed(true)}
            unoptimized
          />
        </div>
      ) : (
        <div className="flex h-[200px] w-[112px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-1)] px-2 text-center">
          <ImageOff size={16} className="text-[var(--text-5)]" />
          <p className="text-[10px] leading-tight text-[var(--text-5)]">No longer available</p>
        </div>
      )}
      {media.title && (
        <p className="mt-1 max-w-[200px] truncate px-1 text-[10px] text-[var(--text-4)]">
          {media.title}
        </p>
      )}
    </div>
  );
}

export default function AccountInbox({
  account,
  conversations,
  scripts,
  liveMessage,
  onChanged,
  showContext,
  focusConversationId,
}: {
  account: ConnectedAccount;
  /** Already filtered to this account by the parent. */
  conversations: ConversationWithLastMessage[];
  scripts: ScriptRow[];
  /** Latest Realtime insert, for any conversation. Appended only if it's ours. */
  liveMessage: Message | null;
  /** Tell the parent to refetch the shared conversation list. */
  onChanged: () => void;
  /** The profile/AI-context aside. No room for it in split mode. */
  showContext: boolean;
  /**
   * A conversation to open on arrival — the Orders page's "Open chat" link. Broadcast to
   * every panel, so this one ignores it unless the conversation is actually its own.
   */
  focusConversationId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Only true on a FIRST open of a chat — a cached one paints instantly with no spinner.
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Set when Instagram refused the reply (too long, 24h window closed, dead token).
  // The guest got nothing, so this has to be visible rather than swallowed.
  const [sendError, setSendError] = useState<string | null>(null);
  const [handingBack, setHandingBack] = useState(false);
  const [handBackError, setHandBackError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationWithLastMessage | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Quick replies popover — pre-written messages (managed on the /quick-replies
  // page) for this account's business. Lazy-loaded on first open, then cached for
  // the life of this panel; `null` means "not fetched yet" (distinct from "fetched,
  // empty").
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [quickReplies, setQuickReplies] = useState<{ id: string; title: string; message: string }[] | null>(
    null
  );
  const [loadingQuickReplies, setLoadingQuickReplies] = useState(false);

  async function toggleQuickReplies() {
    const opening = !showQuickReplies;
    setShowQuickReplies(opening);
    if (opening && quickReplies === null && account.business_id) {
      setLoadingQuickReplies(true);
      const res = await fetch(`/api/quick-replies?business_id=${account.business_id}`);
      const data = await res.json().catch(() => []);
      setLoadingQuickReplies(false);
      setQuickReplies(Array.isArray(data) ? data : []);
    }
  }

  function sendQuickReply(text: string) {
    setShowQuickReplies(false);
    sendMessage(text);
  }

  // Log-order modal — for a reservation/order staff handled by typing their own
  // reply instead of letting the AI produce it, so it still shows up on /orders.
  const [logOrderTarget, setLogOrderTarget] = useState<ConversationWithLastMessage | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderKind, setOrderKind] = useState<"reservation" | "takeaway">("reservation");
  const [orderCustomerName, setOrderCustomerName] = useState("");
  const [orderOutlet, setOrderOutlet] = useState("");
  const [orderGuestsOrItems, setOrderGuestsOrItems] = useState("");
  const [orderContact, setOrderContact] = useState("");
  const [orderScheduledAt, setOrderScheduledAt] = useState("");
  const [orderAlreadyConfirmed, setOrderAlreadyConfirmed] = useState(true);
  const [orderError, setOrderError] = useState<string | null>(null);

  function openLogOrder(convo: ConversationWithLastMessage) {
    setLogOrderTarget(convo);
    setOrderKind("reservation");
    setOrderCustomerName(convo.name || convo.username || "");
    setOrderOutlet("");
    setOrderGuestsOrItems("");
    setOrderContact("");
    setOrderScheduledAt("");
    setOrderAlreadyConfirmed(true);
    setOrderError(null);
  }

  async function submitLogOrder() {
    if (!logOrderTarget || savingOrder) return;
    setSavingOrder(true);
    setOrderError(null);
    const res = await fetch(`/api/conversations/${logOrderTarget.id}/log-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: orderKind,
        customer_name: orderCustomerName,
        outlet: orderOutlet,
        guests_or_items: orderGuestsOrItems,
        contact: orderContact,
        scheduled_at: orderScheduledAt ? new Date(orderScheduledAt).toISOString() : undefined,
        already_confirmed: orderAlreadyConfirmed,
      }),
    });
    setSavingOrder(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setOrderError(d?.error || "Couldn't log that.");
      return;
    }
    setLogOrderTarget(null);
    onChanged();
  }
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Split the list into Ongoing / Completed. A chat is Completed once its latest order's
  // scheduled time has passed; everything else (upcoming order, an order with no captured
  // time, or no order at all) stays Ongoing. `now` ticks every 30s so a chat slides from
  // Ongoing to Completed as its reservation/pickup time passes — no refetch needed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const { ongoing, completed } = useMemo(() => {
    const ong: ConversationWithLastMessage[] = [];
    const done: ConversationWithLastMessage[] = [];
    for (const c of conversations) {
      const at = c.order?.scheduled_at;
      if (at && new Date(at).getTime() < now) done.push(c);
      else ong.push(c);
    }
    return { ongoing: ong, completed: done };
  }, [conversations, now]);

  const renderConvRow = (convo: ConversationWithLastMessage) => {
    const isSelected = selectedId === convo.id;

    // This guest has been told "someone from our team will confirm shortly" and is now
    // waiting on a human to press Confirm. Nothing else in the list distinguishes that
    // from an ordinary chat, and two guests once sat in it for 25 hours — past their own
    // reservation times — because no one noticed.
    //
    // Keyed on the ORDER's status rather than human_handoff_reason: the reason is wiped
    // the moment staff hand the chat back to the AI, which would un-tint the row while
    // the guest is still waiting. The order status is the fact, and Confirm is what
    // changes it.
    const awaitingConfirm = convo.order?.status === "pending";

    return (
      <button
        key={convo.id}
        onClick={() => setSelectedId(convo.id)}
        className={`relative w-full px-4 py-3.5 text-left transition-colors ${
          awaitingConfirm
            ? // Deliberately survives selection: the accent bar below already marks which
              // row is open, so opening a chat shouldn't erase the reason you opened it.
              "bg-[var(--danger-soft)] hover:bg-[var(--danger)]/15"
            : isSelected
              ? "bg-[var(--accent-soft)]"
              : "hover:bg-[var(--surface-1)]"
        }`}
      >
        {isSelected && <div className="absolute left-0 top-0 h-full w-0.5 bg-[var(--accent)]" />}
        <div className="flex items-center gap-3">
          <Avatar src={convo.profile_pic} name={convo.name} igsid={convo.igsid} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-bold text-[var(--text-1)]">
                {convo.name || convo.username || convo.igsid}
              </span>
              <span className="flex-shrink-0 text-[10px] text-[var(--text-5)]">
                {formatTime(convo.updated_at)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-[var(--text-4)]">
              {convo.last_message || (convo.username ? `@${convo.username}` : "")}
            </p>
            <span
              className={`mt-1.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                convo.mode === "agent"
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "bg-[var(--warn-soft)] text-[var(--warn)]"
              }`}
            >
              {convo.mode === "agent" ? "AI handled" : "Human active"}
            </span>
          </div>
        </div>
      </button>
    );
  };

  const selected = conversations.find((c) => c.id === selectedId);

  // Open the conversation a deep-link asked for (Orders -> "Open chat").
  //
  // The ref is what makes this safe to run on every render: it records the id this panel
  // has ALREADY honoured, so once the user clicks away to another chat we don't drag them
  // back on the next re-render — and there are many, since the parent refetches the whole
  // conversation list on every Realtime event.
  //
  // `conversations` is in the deps because the list arrives after this component mounts:
  // on a cold load the id is known before the chat it names exists here, and without the
  // re-check the link would silently do nothing.
  const honouredFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusConversationId || honouredFocusRef.current === focusConversationId) return;
    if (!conversations.some((c) => c.id === focusConversationId)) return; // another panel's
    honouredFocusRef.current = focusConversationId;
    setSelectedId(focusConversationId);
  }, [focusConversationId, conversations]);

  // Per-conversation message cache, so reopening a chat paints instantly instead of
  // waiting on the network again. A ref, not state: writing to it must never trigger
  // a re-render on its own.
  const messageCache = useRef(new Map<string, Message[]>());
  // Which conversation the newest request belongs to. Switching A -> B -> C fires
  // three overlapping requests that can resolve out of order; without this guard a
  // slow response for A could land after C and paint the wrong person's messages.
  const latestRequest = useRef<string | null>(null);

  const fetchMessages = useCallback(async (convoId: string) => {
    latestRequest.current = convoId;
    try {
      const res = await fetch(`/api/conversations/${convoId}/messages`);
      const data = await res.json();
      const list: Message[] = Array.isArray(data) ? data : [];
      messageCache.current.set(convoId, list);
      // Only paint if this is still the conversation on screen.
      if (latestRequest.current === convoId) {
        // Keep the existing array when nothing changed — see sameThread. Every fetch
        // parses a new array, so an unconditional set would repaint the whole
        // non-virtualized thread and re-fire the scroll effect on every poll.
        setMessages((prev) => (sameThread(prev, list) ? prev : list));
        setLoadingMessages(false);
      }
    } catch {
      if (latestRequest.current === convoId) setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setLoadingMessages(false);
      return;
    }
    // Paint SYNCHRONOUSLY on switch — cached messages if we have them, otherwise
    // empty. Previously `setMessages` only ran once the fetch resolved, so the
    // PREVIOUS person's messages stayed on screen for the whole round trip, which
    // is what made switching chats feel laggy.
    const cached = messageCache.current.get(selectedId);
    setMessages(cached ?? []);
    setLoadingMessages(!cached);
    // Always revalidate in the background, so a cached view is never stale for long.
    fetchMessages(selectedId);
  }, [selectedId, fetchMessages]);

  // The open thread on the same slow cadence as the parent's list poll, and for the same
  // reason: Realtime is the fast path, this is the floor under it. A tick that finds
  // nothing new is inert — fetchMessages keeps the existing array, so neither this list
  // nor the scroll position moves.
  useEffect(() => {
    if (!selectedId) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fetchMessages(selectedId);
    }, 60_000);
    return () => clearInterval(t);
  }, [selectedId, fetchMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // The whole point of routing Realtime through a prop: only append when the new
  // message belongs to the conversation THIS panel has open. The other panel gets
  // the same prop and correctly ignores it.
  useEffect(() => {
    if (!liveMessage || liveMessage.conversation_id !== selectedId) return;
    setMessages((prev) => {
      if (prev.some((m) => m.id === liveMessage.id)) return prev;
      const next = [...prev, liveMessage];
      // Keep the cache in step, or switching away and back would drop this message
      // until the background revalidate caught up.
      messageCache.current.set(liveMessage.conversation_id, next);
      return next;
    });
  }, [liveMessage, selectedId]);

  async function toggleMode() {
    if (!selected) return;
    const newMode = selected.mode === "agent" ? "human" : "agent";
    const res = await fetch(`/api/conversations/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
    });
    // Only reflect the flip once the server accepted it — this used to update
    // unconditionally, so a failed PATCH left the UI claiming the agent was off
    // while it was still replying.
    if (!res.ok) return;
    onChanged();
  }

  // Every human-mode chat on this account, back to the AI at once. No acknowledgement
  // step, unlike Confirm/Cancel on an order: nothing is sent to any guest here, and any
  // single chat can be taken back over immediately afterwards.
  async function handBackAll() {
    if (handingBack) return;
    setHandingBack(true);
    setHandBackError(null);
    try {
      const res = await fetch(`/api/accounts/${account.id}/handback`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHandBackError(d?.error || "Couldn't hand these chats back.");
        return;
      }
      // Same rule as toggleMode: reflect only what the server accepted. onChanged
      // refetches the shared list, which is what actually repaints the modes.
      onChanged();
    } catch {
      setHandBackError("Couldn't reach the server.");
    } finally {
      setHandingBack(false);
    }
  }

  // Clears the "log this order" nudge below without leaving human mode — for when
  // the handoff genuinely wasn't a reservation/order (e.g. just a question).
  async function dismissHandoffNotice(convoId: string) {
    const res = await fetch(`/api/conversations/${convoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismiss_handoff_notice: true }),
    });
    if (res.ok) onChanged();
  }

  // Takes the text as a param (rather than always reading `input`) so a tapped
  // quick reply can send immediately without ever touching the composer's input state.
  async function sendMessage(text: string) {
    if (!text.trim() || !selectedId || sending) return;
    setSending(true);
    setSendError(null);
    const res = await fetch(`/api/conversations/${selectedId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text.trim() }),
    });
    setSending(false);

    // Nothing was delivered and nothing was stored. Keep the text in the composer so
    // it can be shortened and retried instead of vanishing as if it had been sent.
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setSendError(body?.error || "Instagram wouldn't accept that message.");
      return;
    }

    setInput("");
    fetchMessages(selectedId);
    onChanged();
  }

  function handleSend() {
    return sendMessage(input);
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const id = deleteTarget.id;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (selectedId === id) {
      setSelectedId(null);
      setMessages([]);
    }
    setDeleteTarget(null);
    setDeleting(false);
    onChanged();
  }

  // Which script answers this conversation — the same resolution order the webhook
  // uses (tenant.ts): the account's own script, else the business default.
  const activeScriptId = account.script_id ?? account.businesses?.default_script_id ?? null;
  const activeScript = scripts.find((s) => s.id === activeScriptId);

  // Chats this account is currently answering by hand — drives the bulk hand-back button.
  // Read off the list the parent already loaded, so it costs no extra request and can
  // never disagree with the modes on screen.
  const humanCount = conversations.filter((c) => c.mode === "human").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Always rendered now, not just in split view. It was multi-account-only on the
          grounds that the page toolbar already names the account — but this is also the
          only strip scoped to ONE account, so the account-level action below has nowhere
          else to live, and hiding it left single-account tenants with no way to reach it. */}
      <div
        className="flex flex-shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-4 py-2.5"
        style={{ background: "var(--panel-bg)" }}
      >
        <Avatar
          src={account.profile_picture_url}
          name={account.name}
          igsid={account.ig_account_id}
          size={28}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-bold text-[var(--text-1)]">
            {account.username ? `@${account.username}` : account.ig_account_id}
          </p>
          <p className="truncate text-[10px] text-[var(--text-4)]">
            {handBackError ? (
              <span className="font-semibold text-[var(--danger)]">{handBackError}</span>
            ) : (
              <>
                {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
              </>
            )}
          </p>
        </div>
        {/* Acts on the whole ACCOUNT, unlike the per-conversation button beside it, so
            the two labels have to stay tellable apart at a glance. Hidden rather than
            disabled at zero, for the same reason as the button below. */}
        {humanCount > 0 && (
          <button
            onClick={handBackAll}
            disabled={handingBack}
            title={`Hand all ${humanCount} human-handled chat${humanCount === 1 ? "" : "s"} on this account back to the AI`}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-[var(--accent)]/30 px-2.5 py-1 text-[10px] font-bold text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-40"
          >
            {handingBack ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />}
            All back to AI ({humanCount})
          </button>
        )}
        {/* Acts on the SELECTED conversation, not the account — mode is
            per-conversation. Only rendered with something selected: a permanently
            disabled control here would be worse than none. Same wording and
            colours as the context aside's button so they read as one action, and
            both stay in sync because each reads selected.mode from the shared
            conversation list. */}
        {selected && (
          <button
            onClick={toggleMode}
            className={`flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-bold transition-colors ${
              selected.mode === "agent"
                ? "border-[var(--warn)]/30 text-[var(--warn)] hover:bg-[var(--warn-soft)]"
                : "border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            }`}
          >
            {selected.mode === "agent" ? <Hand size={12} /> : <Bot size={12} />}
            {selected.mode === "agent" ? "Take over" : "Back to AI"}
          </button>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* List — full width on mobile, hidden once a chat is open */}
        <div
          className={`${
            selectedId ? "hidden md:flex" : "flex"
          } w-full min-w-0 flex-col border-r border-[var(--border)] md:w-[260px] md:flex-shrink-0`}
          style={{ background: "var(--panel-bg)" }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-1)]">
                  <MessageSquare size={18} className="text-[var(--text-5)]" />
                </div>
                <p className="text-xs text-[var(--text-5)]">No conversations yet</p>
              </div>
            ) : (
              <>
                <SectionLabel label="Ongoing" count={ongoing.length} />
                {ongoing.length ? (
                  ongoing.map(renderConvRow)
                ) : (
                  <p className="px-4 py-3 text-[10px] text-[var(--text-5)]">Nothing ongoing.</p>
                )}
                <SectionLabel label="Completed" count={completed.length} />
                {completed.length ? (
                  completed.map(renderConvRow)
                ) : (
                  <p className="px-4 py-3 text-[10px] text-[var(--text-5)]">Nothing completed.</p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Thread */}
        <div className={`${selectedId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-1)]">
                <MessageSquare size={24} className="text-[var(--text-6)]" />
              </div>
              <div className="text-center">
                <p className="text-[12px] font-bold text-[var(--text-3)]">Select a conversation</p>
                <p className="mt-1 text-xs text-[var(--text-5)]">
                  Choose from the list to start chatting
                </p>
              </div>
            </div>
          ) : (
            <>
              <div
                className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3"
                style={{ background: "var(--panel-bg)" }}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    onClick={() => setSelectedId(null)}
                    aria-label="Back to conversations"
                    className="-ml-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--surface-1)] md:hidden"
                  >
                    <ChevronLeft size={19} />
                  </button>
                  <Avatar
                    src={selected.profile_pic}
                    name={selected.name}
                    igsid={selected.igsid}
                    size={36}
                  />
                  <div className="min-w-0">
                    <h2 className="truncate text-[13px] font-bold text-[var(--text-1)]">
                      {selected.name || selected.username || selected.igsid}
                    </h2>
                    <p className="truncate text-[10px] text-[var(--text-4)]">
                      {selected.username ? `@${selected.username}` : selected.igsid}
                    </p>
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <button
                    onClick={toggleMode}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold transition-colors ${
                      selected.mode === "agent"
                        ? "border-[var(--accent)]/25 bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "border-[var(--warn)]/25 bg-[var(--warn-soft)] text-[var(--warn)]"
                    }`}
                  >
                    {selected.mode === "agent" ? <Bot size={12} /> : <Hand size={12} />}
                    <span className="hidden lg:inline">
                      {selected.mode === "agent" ? "AI mode" : "Human mode"}
                    </span>
                  </button>
                  <button
                    onClick={() => setDeleteTarget(selected)}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {selected.mode === "human" &&
                selected.human_handoff_reason === "undelivered" && (
                  <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-[var(--danger)]/25 bg-[var(--danger-soft)] px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2 text-[10px] font-bold text-[var(--danger)]">
                      <AlertTriangle size={14} className="flex-shrink-0" />
                      <span className="truncate">
                        Instagram rejected the AI&apos;s last reply, so the guest never received
                        it. Reply here to pick this up.
                      </span>
                    </div>
                    <button
                      onClick={() => dismissHandoffNotice(selected.id)}
                      aria-label="Dismiss"
                      className="flex-shrink-0 opacity-60 transition-opacity hover:opacity-100"
                    >
                      <X size={14} className="text-[var(--danger)]" />
                    </button>
                  </div>
                )}

              {selected.mode === "human" &&
                selected.human_handoff_reason === "outage" &&
                !selected.order && (
                  <div
                    className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-[var(--warn)]/25 bg-[var(--warn-soft)] px-4 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2 text-[10px] font-bold text-[var(--warn)]">
                      <AlertTriangle size={14} className="flex-shrink-0" />
                      <span className="truncate">
                        The AI went down mid-chat and handed this to a human. If you confirmed a
                        reservation or order here yourself, it won&apos;t show up on Orders unless
                        you log it.
                      </span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <button
                        onClick={() => openLogOrder(selected)}
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--warn)]/30 px-2.5 py-1 text-[10px] font-bold text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10"
                      >
                        <Receipt size={12} />
                        Log order
                      </button>
                      <button
                        onClick={() => dismissHandoffNotice(selected.id)}
                        aria-label="Dismiss"
                        title="Not an order — dismiss"
                        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                )}

              {/* The AI stopped ITSELF at the recap and is waiting on a human decision. Without
                  this banner a deliberately silent thread is indistinguishable from a broken one —
                  which is exactly how staff would come to mistrust the pause and turn it off.
                  No dismiss button: the silence is real and lasts until the order is actioned, so
                  hiding the notice would only hide the reason the chat has gone quiet. */}
              {selected.mode === "human" &&
                selected.human_handoff_reason === "awaiting_confirmation" && (
                  <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--warn)]/25 bg-[var(--warn-soft)] px-4 py-2.5 text-[10px] font-bold text-[var(--warn)]">
                    <AlertTriangle size={14} className="flex-shrink-0" />
                    <span className="truncate">
                      The AI has paused — this guest is waiting on your confirmation. Confirm the
                      order to reply and hand the chat back to the AI.
                    </span>
                  </div>
                )}

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
                {loadingMessages && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={16} className="animate-spin text-[var(--text-5)]" />
                  </div>
                )}
                {messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const showTime =
                    i === messages.length - 1 || messages[i + 1]?.role !== msg.role;
                  return (
                    <div
                      key={msg.id}
                      className={`flex items-end gap-2 ${isUser ? "justify-start" : "justify-end"}`}
                    >
                      {isUser && (
                        <Avatar
                          src={selected.profile_pic}
                          name={selected.name}
                          igsid={selected.igsid}
                          size={24}
                        />
                      )}
                      <div
                        className={`flex max-w-[85%] flex-col ${
                          isUser ? "items-start" : "items-end"
                        }`}
                      >
                        {/* Story reply / shared post, above the text the way Instagram shows it. */}
                        {msg.attachments?.map((media, mi) => (
                          <MediaCard key={mi} media={media} align={isUser ? "start" : "end"} />
                        ))}
                        {/* A media-only message has no text — don't render an empty bubble. */}
                        {msg.content?.trim() && (
                          <div
                            className={`rounded-2xl px-4 py-2.5 text-[12px] leading-relaxed ${
                              isUser
                                ? "rounded-tl-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]"
                                : "rounded-tr-sm text-white"
                            }`}
                            style={!isUser ? { background: "var(--accent)" } : undefined}
                          >
                            <p className="whitespace-pre-wrap">{msg.content}</p>
                          </div>
                        )}
                        {showTime && (
                          <p className="mt-1.5 px-1 text-[10px] text-[var(--text-5)]">
                            {formatTime(msg.created_at)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              <div
                className="relative flex-shrink-0 border-t border-[var(--border)] px-4 py-3"
                style={{ background: "var(--panel-bg)" }}
              >
                {showQuickReplies && (
                  <>
                    {/* Click-outside catcher — sits under the panel, above everything else. */}
                    <div className="fixed inset-0 z-10" onClick={() => setShowQuickReplies(false)} />
                    <div className="absolute bottom-full left-4 right-4 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-1.5 shadow-lg">
                      {loadingQuickReplies && (
                        <p className="px-2.5 py-2 text-[10px] text-[var(--text-4)]">Loading…</p>
                      )}
                      {!loadingQuickReplies && quickReplies?.length === 0 && (
                        <p className="px-2.5 py-2 text-[10px] text-[var(--text-4)]">
                          No quick replies yet — add some from the Quick Replies page.
                        </p>
                      )}
                      {!loadingQuickReplies &&
                        quickReplies?.map((qr) => (
                          <button
                            key={qr.id}
                            onClick={() => sendQuickReply(qr.message)}
                            disabled={sending}
                            className="block w-full min-w-0 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-1)] disabled:opacity-50"
                          >
                            <p className="truncate text-[11px] font-bold text-[var(--text-1)]">{qr.title}</p>
                            <p className="truncate text-[10px] text-[var(--text-4)]">{qr.message}</p>
                          </button>
                        ))}
                    </div>
                  </>
                )}
                {sendError && (
                  <div className="mb-1.5 flex items-start gap-2 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2 text-[10px] font-semibold text-[var(--danger)]">
                    <AlertTriangle size={13} className="mt-px flex-shrink-0" />
                    <span className="min-w-0 flex-1">Not delivered — {sendError}</span>
                    <button
                      onClick={() => setSendError(null)}
                      aria-label="Dismiss"
                      className="flex-shrink-0 opacity-60 transition-opacity hover:opacity-100"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2 transition-colors focus-within:border-[var(--accent)]">
                  <button
                    onClick={toggleQuickReplies}
                    aria-label="Quick replies"
                    title="Quick replies"
                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
                      showQuickReplies
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "text-[var(--text-4)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    <Zap size={15} />
                  </button>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                    placeholder={`Reply to ${selected.name?.split(" ")[0] || "customer"}…`}
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:outline-none md:text-[12px]"
                  />
                  <button
                    onClick={handleSend}
                    disabled={sending || !input.trim()}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-30"
                    aria-label="Send"
                  >
                    {sending ? (
                      <Loader2 size={14} className="animate-spin text-white" />
                    ) : (
                      <Send size={14} className="text-white" />
                    )}
                  </button>
                </div>
                {selected.mode === "agent" && (
                  <p className="mt-1.5 text-[10px] text-[var(--text-5)]">
                    The agent is answering this conversation. Sending a reply yourself
                    doesn&apos;t stop it — switch to Human mode for that.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Context aside — every field is real. Omitted in split mode: there is no
            room for a third column inside each panel. */}
        {showContext && selected && (
          <aside
            className="hidden w-[280px] flex-shrink-0 flex-col overflow-y-auto border-l border-[var(--border)] xl:flex"
            style={{ background: "var(--panel-bg)" }}
          >
            <div className="flex flex-col items-center border-b border-[var(--border)] px-5 py-6 text-center">
              <Avatar
                src={selected.profile_pic}
                name={selected.name}
                igsid={selected.igsid}
                size={72}
              />
              <h3 className="mt-3 text-[14px] font-bold text-[var(--text-1)]">
                {selected.name || selected.username || selected.igsid}
              </h3>
              {selected.username && (
                <p className="text-[10px] text-[var(--text-4)]">@{selected.username}</p>
              )}
              <p className="mt-1 text-[10px] text-[var(--text-5)]">
                In touch since {formatDate(selected.created_at)}
              </p>
              <button
                onClick={toggleMode}
                className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-bold transition-colors ${
                  selected.mode === "agent"
                    ? "border-[var(--warn)]/30 text-[var(--warn)] hover:bg-[var(--warn-soft)]"
                    : "border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                }`}
              >
                {selected.mode === "agent" ? <Hand size={12} /> : <Bot size={12} />}
                {selected.mode === "agent" ? "Take over" : "Give back to AI"}
              </button>
            </div>

            <div className="border-b border-[var(--border)] px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
                AI context
              </p>
              <div className="mt-2.5 rounded-xl bg-[var(--accent-soft)] p-3">
                <div className="flex items-start gap-2">
                  <FileText size={13} className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-[var(--accent)]">
                      {activeScript ? activeScript.name : "No script resolved"}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--text-4)]">
                      {account.script_id
                        ? "Account's own script"
                        : activeScript
                          ? `${account.businesses?.name ?? "Business"} default`
                          : "This conversation has no script attached"}
                    </p>
                  </div>
                </div>
                {activeScript && (
                  <Link
                    href={`/scripts?script=${activeScript.id}`}
                    className="mt-2.5 block text-[10px] font-bold text-[var(--accent)] hover:underline"
                  >
                    Edit script →
                  </Link>
                )}
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--text-5)]">
                <Clock size={10} />
                Last activity {formatTime(selected.updated_at)} · {messages.length} message
                {messages.length === 1 ? "" : "s"}
              </p>
            </div>

            <div className="px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
                Profile
              </p>
              <div className="mt-2.5 space-y-2.5">
                {selected.follower_count !== null && (
                  <Row
                    icon={<User size={12} />}
                    label="Followers"
                    value={selected.follower_count.toLocaleString()}
                  />
                )}
                {selected.is_user_follow_business !== null && (
                  <Row
                    icon={<UserCheck size={12} />}
                    label="Follows you"
                    value={selected.is_user_follow_business ? "Yes" : "No"}
                  />
                )}
                {selected.is_business_follow_user !== null && (
                  <Row
                    icon={<UserCheck size={12} />}
                    label="You follow"
                    value={selected.is_business_follow_user ? "Yes" : "No"}
                  />
                )}
                <Row
                  icon={<MessageSquare size={12} />}
                  label="Received on"
                  value={account.username ? `@${account.username}` : account.ig_account_id}
                />
              </div>
            </div>
          </aside>
        )}
      </div>

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4 backdrop-blur-sm"
          onClick={() => !deleting && setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-[340px] rounded-2xl border border-[var(--border-strong)] bg-[var(--modal-bg)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--danger-soft)]">
                <Trash2 size={15} className="text-[var(--danger)]" />
              </div>
              <h3 className="text-[13px] font-bold text-[var(--text-1)]">Delete conversation?</h3>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[var(--text-4)]">
              This permanently removes{" "}
              <span className="font-bold text-[var(--text-2)]">
                {deleteTarget.name || deleteTarget.username || deleteTarget.igsid}
              </span>{" "}
              and all its messages. This can&apos;t be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--text-3)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-1)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-2 rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deleting && <Loader2 size={12} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {logOrderTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4 backdrop-blur-sm"
          onClick={() => !savingOrder && setLogOrderTarget(null)}
        >
          <div
            className="w-full max-w-[420px] rounded-2xl border border-[var(--border-strong)] bg-[var(--modal-bg)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                  <Receipt size={15} className="text-[var(--accent)]" />
                </div>
                <div>
                  <h3 className="text-[13px] font-bold text-[var(--text-1)]">Log an order</h3>
                  <p className="text-[10px] text-[var(--text-4)]">
                    For a booking you handled by typing your own reply
                  </p>
                </div>
              </div>
              <button
                onClick={() => setLogOrderTarget(null)}
                aria-label="Close"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-4)] transition-colors hover:bg-[var(--surface-1)]"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="flex rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
                {(["reservation", "takeaway"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setOrderKind(k)}
                    className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-bold capitalize transition-colors ${
                      orderKind === k
                        ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                        : "text-[var(--text-4)] hover:text-[var(--text-2)]"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>

              <input
                value={orderCustomerName}
                onChange={(e) => setOrderCustomerName(e.target.value)}
                placeholder="Guest name"
                className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-3.5 py-2.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
              />
              <input
                value={orderOutlet}
                onChange={(e) => setOrderOutlet(e.target.value)}
                placeholder="Outlet"
                className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-3.5 py-2.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={orderGuestsOrItems}
                  onChange={(e) => setOrderGuestsOrItems(e.target.value)}
                  placeholder={orderKind === "reservation" ? "Guests" : "Items"}
                  className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-3.5 py-2.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  value={orderContact}
                  onChange={(e) => setOrderContact(e.target.value)}
                  placeholder="Contact (optional)"
                  className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-3.5 py-2.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-[var(--text-4)]">
                  {orderKind === "reservation" ? "Reservation time" : "Pickup time"}
                </label>
                <input
                  type="datetime-local"
                  value={orderScheduledAt}
                  onChange={(e) => setOrderScheduledAt(e.target.value)}
                  className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-3.5 py-2.5 text-sm text-[var(--text-1)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <label className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3.5 py-3 text-[11px] text-[var(--text-2)]">
                <input
                  type="checkbox"
                  checked={orderAlreadyConfirmed}
                  onChange={(e) => setOrderAlreadyConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I already told the guest this is confirmed — don&apos;t send another
                  confirmation message. (Leave unchecked to log it as pending, so it can be
                  confirmed later from Orders as usual.)
                </span>
              </label>

              {orderError && (
                <p className="text-[10px] font-semibold text-[var(--danger)]">{orderError}</p>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setLogOrderTarget(null)}
                disabled={savingOrder}
                className="rounded-lg px-3.5 py-2 text-[12px] font-bold text-[var(--text-3)] transition-colors hover:bg-[var(--surface-1)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={submitLogOrder}
                disabled={savingOrder}
                className="flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-[12px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                {savingOrder && <Loader2 size={13} className="animate-spin" />}
                Log order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-4)]">
        {icon}
        {label}
      </span>
      <span className="truncate text-[10px] font-bold text-[var(--text-2)]">{value}</span>
    </div>
  );
}
