"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileText, Save, Loader2, Check, Star, Plus, Upload, X, AlertTriangle } from "lucide-react";

type ScriptRow = {
  id: string;
  name: string;
  business_id: string;
  business_name: string | null;
  is_default: boolean;
  updated_at: string;
};

type ScriptDetail = {
  id: string;
  name: string;
  content: string;
  business_id: string;
  updated_at: string;
};

type Business = { id: string; name: string };

function when(iso: string) {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// useSearchParams (to open the script named in ?script=) opts the route out of
// static prerender unless it sits in a Suspense boundary — so the page splits
// into a wrapper + this inner component.
export default function ScriptsPage() {
  return (
    <Suspense fallback={<p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>}>
      <ScriptsInner />
    </Suspense>
  );
}

// One editor covers all four actions: create a new script (POST), edit by hand,
// replace the content from an uploaded file (Claude reshapes it to our format),
// and save to update (PUT). Upload fills the editor for review — it never saves
// on its own, because this text governs every reply.
function ScriptsInner() {
  const params = useSearchParams();
  const wantScript = params.get("script"); // set by "Edit script" deep-links

  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScriptDetail | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newBiz, setNewBiz] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/scripts");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const list: ScriptRow[] = await res.json();
      setLoadFailed(false);
      setScripts(list);
      // Prefer the deep-linked script; else keep the current one; else the first.
      setSelectedId((cur) => cur ?? (wantScript || list[0]?.id) ?? null);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [wantScript]);

  // A deep-link (?script=<id>) selects that script directly — the detail effect
  // below loads it even before the list arrives.
  useEffect(() => {
    if (wantScript) setSelectedId(wantScript);
  }, [wantScript]);

  useEffect(() => {
    loadList();
    fetch("/api/businesses")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const bs: Business[] = (Array.isArray(list) ? list : []).map((b: { id: string; name: string }) => ({
          id: b.id,
          name: b.name,
        }));
        setBusinesses(bs);
        setNewBiz((cur) => cur || bs[0]?.id || "");
      })
      .catch(() => {});
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) return;
    setError(null);
    fetch(`/api/scripts/${selectedId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load that script."))))
      .then((d: ScriptDetail) => {
        setDetail(d);
        setName(d.name);
        setContent(d.content);
        setSavedAt(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [selectedId]);

  const dirty = !!detail && (name !== detail.name || content !== detail.content);
  const selectedRow = scripts.find((s) => s.id === selectedId);

  async function save() {
    if (!detail || saving || !dirty) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/scripts/${detail.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    setSaving(false);
    if (!res.ok) {
      setError("Save failed. Your changes are still here — try again.");
      return;
    }
    const updated = await res.json();
    setDetail({ ...detail, name, content, updated_at: updated.updated_at });
    setSavedAt(updated.updated_at);
    loadList();
  }

  async function createScript() {
    if (!newBiz || !newName.trim() || creating) return;
    setCreating(true);
    setError(null);
    const res = await fetch("/api/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_id: newBiz, name: newName.trim() }),
    });
    setCreating(false);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d?.error || "Couldn't create that script.");
      return;
    }
    setAdding(false);
    setNewName("");
    await loadList();
    setSelectedId(d.id);
  }

  async function handleUpload(file: File) {
    if (!detail || uploading) return;
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("business_id", detail.business_id);
    const res = await fetch("/api/scripts/reformat", { method: "POST", body: fd });
    setUploading(false);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d?.error || "Couldn't reformat that file.");
      return;
    }
    // Fill the editor for review — the content is now dirty until you Save.
    setContent(d.content);
  }

  async function makeDefault() {
    if (!detail || !selectedRow) return;
    setError(null);
    const res = await fetch(`/api/businesses/${detail.business_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_script_id: detail.id }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d?.error || "Couldn't set as default.");
      return;
    }
    loadList();
  }

  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const chars = content.length;

  if (loading) return <p className="p-8 text-xs text-[var(--text-4)]">Loading…</p>;

  // A failed load must NOT show the "Add a business" empty state — that reads as
  // landing on the Businesses page. Show an honest error with a retry instead.
  if (loadFailed) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <AlertTriangle size={22} className="mx-auto text-[var(--danger)]" />
          <p className="mt-3 text-[12px] font-bold text-[var(--text-1)]">Couldn&apos;t load your scripts</p>
          <p className="mt-1 max-w-xs text-[11px] text-[var(--text-4)]">
            Something went wrong reaching the server.
          </p>
          <button
            onClick={() => {
              setLoading(true);
              loadList();
            }}
            className="mt-4 inline-block rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[11px] font-bold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Genuine empty (the fetch succeeded but returned nothing).
  if (scripts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <FileText size={22} className="mx-auto text-[var(--text-5)]" />
          <p className="mt-3 text-[12px] font-bold text-[var(--text-1)]">No scripts yet</p>
          <p className="mt-1 max-w-xs text-[11px] text-[var(--text-4)]">
            A script is created automatically with your first business.
          </p>
          <Link
            href="/businesses"
            className="mt-4 inline-block rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[11px] font-bold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
          >
            Add a business
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Hidden file input for Upload & reformat */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,.docx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3.5 md:px-6">
        <div className="min-w-0">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Script name"
            className="w-full truncate rounded-md bg-transparent text-lg font-extrabold tracking-tight text-[var(--text-1)] focus:bg-[var(--surface-1)] focus:outline-none"
          />
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-4)]">
            {selectedRow?.is_default ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
                Business default — used for the next message
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-5)]" />
                Not the business default
                <button
                  onClick={makeDefault}
                  className="font-semibold text-[var(--accent)] hover:underline"
                >
                  Make default
                </button>
              </>
            )}
            {detail && <span className="text-[var(--text-5)]">· saved {when(detail.updated_at)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && !dirty && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-[var(--ok)]">
              <Check size={12} /> Saved
            </span>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !detail}
            title="Upload a .txt, .md, or .docx and let AI reshape it into this script"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] px-3 py-2 text-[11px] font-bold text-[var(--text-2)] transition-colors hover:bg-[var(--surface-1)] disabled:opacity-40"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {uploading ? "Reformatting…" : "Upload & reformat"}
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[11px] font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save changes
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Script list */}
        <aside className="border-b border-[var(--border)] p-3 md:w-[240px] md:flex-shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-2 pb-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-5)]">
              Your scripts
            </p>
            <button
              onClick={() => {
                setAdding((v) => !v);
                setError(null);
              }}
              className="flex items-center gap-1 text-[10px] font-bold text-[var(--accent)] hover:underline"
            >
              {adding ? <X size={12} /> : <Plus size={12} />}
              {adding ? "Cancel" : "New"}
            </button>
          </div>

          {adding && (
            <div className="mb-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2.5">
              <select
                value={newBiz}
                onChange={(e) => setNewBiz(e.target.value)}
                className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--panel-bg)] px-2 py-1.5 text-[11px] font-semibold text-[var(--text-2)] focus:border-[var(--accent)] focus:outline-none"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createScript()}
                placeholder="Script name"
                className="mt-2 w-full rounded-md border border-[var(--border-strong)] bg-[var(--panel-bg)] px-2 py-1.5 text-[11px] text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:border-[var(--accent)] focus:outline-none"
              />
              <button
                onClick={createScript}
                disabled={creating || !newName.trim() || !newBiz}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] py-1.5 text-[11px] font-bold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                {creating ? <Loader2 size={12} className="animate-spin" /> : "Create script"}
              </button>
            </div>
          )}

          {scripts.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                s.id === selectedId ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-1)]"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={`truncate text-[12px] font-bold ${
                    s.id === selectedId ? "text-[var(--accent)]" : "text-[var(--text-2)]"
                  }`}
                >
                  {s.name}
                </span>
                {s.is_default && (
                  <Star size={10} className="flex-shrink-0 text-[var(--warn)]" fill="currentColor" />
                )}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-[var(--text-4)]">
                {s.business_name}
              </span>
            </button>
          ))}
          <p className="mt-2 px-2 text-[10px] leading-relaxed text-[var(--text-5)]">
            <Star size={9} className="mb-px inline text-[var(--warn)]" fill="currentColor" /> marks a
            business default. Accounts without their own script inherit it.
          </p>
        </aside>

        {/* Editor */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-[var(--border)] px-4 py-2.5 md:px-6">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">
              Instructions
            </p>
          </div>

          {error && (
            <p className="mx-4 mt-3 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] font-semibold text-[var(--danger)] md:mx-6">
              {error}
            </p>
          )}

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            aria-label="Script instructions"
            placeholder="Describe the persona, the facts the agent may state, and the rules it must never break… or use “Upload & reformat” to build it from a file."
            className="min-h-[320px] flex-1 resize-none bg-transparent px-4 py-4 font-mono text-[12px] leading-relaxed text-[var(--text-1)] placeholder:text-[var(--text-6)] focus:outline-none md:px-6"
          />

          <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2.5 text-[10px] text-[var(--text-5)] md:px-6">
            <span>
              {words.toLocaleString()} word{words === 1 ? "" : "s"} ·{" "}
              {chars.toLocaleString()} character{chars === 1 ? "" : "s"}
            </span>
            {dirty && <span className="font-semibold text-[var(--warn)]">Unsaved changes</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
