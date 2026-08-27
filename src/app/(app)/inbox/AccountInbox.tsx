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
  X,
} from "lucide-react";
import type { ConversationWithLastMessage, Message } from "@/lib/types";

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

export default function AccountInbox({
  account,
  conversations,
  scripts,
  liveMessage,
  onChanged,
  showHeader,
  showContext,
}: {
  account: ConnectedAccount;
  /** Already filtered to this account by the parent. */
  conversations: ConversationWithLastMessage[];
  scripts: ScriptRow[];
  /** Latest Realtime insert, for any conversation. Appended only if it's ours. */
  liveMessage: Message | null;
  /** Tell the parent to refetch the shared conversation list. */
  onChanged: () => void;
  /** The @username strip — only useful when more than one panel is on screen. */
  showHeader: boolean;
  /** The profile/AI-context aside. No room for it in split mode. */
  showContext: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationWithLastMessage | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    return (
      <button
        key={convo.id}
        onClick={() => setSelectedId(convo.id)}
        className={`relative w-full px-4 py-3.5 text-left transition-colors ${
          isSelected ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-1)]"
        }`}
      >
        {isSelected && <div className="absolute left-0 top-0 h-full w-0.5 bg-[var(--accent)]" />}
        <div className="flex items-center gap-3">
          <Avatar src={convo.profile_pic} name={convo.name} igsid={convo.igsid} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-bold text-[var(--text-1)]">
                {convo.name || convo.username || convo.igsid}
              </span>
              <span className="flex-shrink-0 text-[10px] text-[var(--text-5)]">
                {formatTime(convo.updated_at)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-[var(--text-4)]">
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

  const fetchMessages = useCallback(async (convoId: string) => {
    const res = await fetch(`/api/conversations/${convoId}/messages`);
    const data = await res.json();
    setMessages(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    if (selectedId) fetchMessages(selectedId);
    else setMessages([]);
  }, [selectedId, fetchMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // The whole point of routing Realtime through a prop: only append when the new
  // message belongs to the conversation THIS panel has open. The other panel gets
  // the same prop and correctly ignores it.
  useEffect(() => {
    if (!liveMessage || liveMessage.conversation_id !== selectedId) return;
    setMessages((prev) =>
      prev.some((m) => m.id === liveMessage.id) ? prev : [...prev, liveMessage]
    );
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

  async function handleSend() {
    if (!input.trim() || !selectedId || sending) return;
    setSending(true);
    await fetch(`/api/conversations/${selectedId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input.trim() }),
    });
    setInput("");
    setSending(false);
    fetchMessages(selectedId);
    onChanged();
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showHeader && (
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
            <p className="truncate text-[13px] font-bold text-[var(--text-1)]">
              {account.username ? `@${account.username}` : account.ig_account_id}
            </p>
            <p className="truncate text-[10px] text-[var(--text-4)]">
              {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
            </p>
          </div>
          {/* Acts on the SELECTED conversation, not the account — mode is
              per-conversation. Only rendered with something selected: a permanently
              disabled control here would be worse than none. Same wording and
              colours as the context aside's button so they read as one action, and
              both stay in sync because each reads selected.mode from the shared
              conversation list. */}
          {selected && (
            <button
              onClick={toggleMode}
              className={`flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${
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
      )}

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
                  <p className="px-4 py-3 text-[11px] text-[var(--text-5)]">Nothing ongoing.</p>
                )}
                <SectionLabel label="Completed" count={completed.length} />
                {completed.length ? (
                  completed.map(renderConvRow)
                ) : (
                  <p className="px-4 py-3 text-[11px] text-[var(--text-5)]">Nothing completed.</p>
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
                <p className="text-[13px] font-bold text-[var(--text-3)]">Select a conversation</p>
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
                    <h2 className="truncate text-[14px] font-bold text-[var(--text-1)]">
                      {selected.name || selected.username || selected.igsid}
                    </h2>
                    <p className="truncate text-[11px] text-[var(--text-4)]">
                      {selected.username ? `@${selected.username}` : selected.igsid}
                    </p>
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <button
                    onClick={toggleMode}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
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
                selected.human_handoff_reason === "outage" &&
                !selected.order && (
                  <div
                    className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-[var(--warn)]/25 bg-[var(--warn-soft)] px-4 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2 text-[11px] font-bold text-[var(--warn)]">
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
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--warn)]/30 px-2.5 py-1 text-[11px] font-bold text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10"
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

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
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
                        <div
                          className={`rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                            isUser
                              ? "rounded-tl-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]"
                              : "rounded-tr-sm text-white"
                          }`}
                          style={!isUser ? { background: "var(--accent)" } : undefined}
                        >
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        </div>
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
                className="flex-shrink-0 border-t border-[var(--border)] px-4 py-3"
                style={{ background: "var(--panel-bg)" }}
              >
                <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2 transition-colors focus-within:border-[var(--accent)]">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                    placeholder={`Reply to ${selected.name?.split(" ")[0] || "customer"}…`}
                    className="min-w-0 flex-1 bg-transparent text-base text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:outline-none md:text-[13px]"
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
              <h3 className="mt-3 text-[15px] font-bold text-[var(--text-1)]">
                {selected.name || selected.username || selected.igsid}
              </h3>
              {selected.username && (
                <p className="text-[11px] text-[var(--text-4)]">@{selected.username}</p>
              )}
              <p className="mt-1 text-[11px] text-[var(--text-5)]">
                In touch since {formatDate(selected.created_at)}
              </p>
              <button
                onClick={toggleMode}
                className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-bold transition-colors ${
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
                    <p className="text-[12px] font-bold text-[var(--accent)]">
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
                    className="mt-2.5 block text-[11px] font-bold text-[var(--accent)] hover:underline"
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
              <h3 className="text-[14px] font-bold text-[var(--text-1)]">Delete conversation?</h3>
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
                  <h3 className="text-[14px] font-bold text-[var(--text-1)]">Log an order</h3>
                  <p className="text-[11px] text-[var(--text-4)]">
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
                    className={`flex-1 rounded-md px-2.5 py-1.5 text-[12px] font-bold capitalize transition-colors ${
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
                <label className="mb-1 block text-[11px] font-semibold text-[var(--text-4)]">
                  {orderKind === "reservation" ? "Reservation time" : "Pickup time"}
                </label>
                <input
                  type="datetime-local"
                  value={orderScheduledAt}
                  onChange={(e) => setOrderScheduledAt(e.target.value)}
                  className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] px-3.5 py-2.5 text-sm text-[var(--text-1)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <label className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3.5 py-3 text-[12px] text-[var(--text-2)]">
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
                <p className="text-[11px] font-semibold text-[var(--danger)]">{orderError}</p>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setLogOrderTarget(null)}
                disabled={savingOrder}
                className="rounded-lg px-3.5 py-2 text-[13px] font-bold text-[var(--text-3)] transition-colors hover:bg-[var(--surface-1)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={submitLogOrder}
                disabled={savingOrder}
                className="flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-[13px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
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
      <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-4)]">
        {icon}
        {label}
      </span>
      <span className="truncate text-[11px] font-bold text-[var(--text-2)]">{value}</span>
    </div>
  );
}
