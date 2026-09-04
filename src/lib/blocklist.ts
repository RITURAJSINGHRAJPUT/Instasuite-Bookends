import { supabaseAdmin } from "@/lib/supabase";

// A global do-not-reply list, keyed on the guest's Instagram handle.
//
// Blocking is deliberately NOT per business (see 0025_blocked_users.sql): one entry
// silences a handle on every connected account. A block suppresses only AUTOMATED
// replies — the guest's message is still stored and still shows in the Inbox, and
// staff can still answer by hand. The guards live in src/app/api/webhook/route.ts.
//
// Fail-open by design: see isBlocked below.

/**
 * The one canonical form of a handle, used on BOTH the write path (the API routes)
 * and the read path (isBlocked). A mismatch between the two is the single way this
 * feature silently does nothing, so there is exactly one implementation.
 *
 * Instagram handles are case-insensitive, and people paste them with the '@' on.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

// Cached because this is consulted on EVERY inbound message, and the list changes
// rarely. In-memory, same spirit as debounce.ts and queue.ts — this app is already
// a single long-lived Render process, so per-process state is an existing accepted
// constraint rather than a new one. The API routes call invalidateBlocklistCache()
// on write, so a block from the dashboard takes effect at once rather than in <=60s.
const TTL_MS = 60_000;
let cache: Set<string> | null = null;
let cachedAt = 0;

/** Drop the cached list so the next isBlocked() re-reads from the database. */
export function invalidateBlocklistCache(): void {
  cache = null;
  cachedAt = 0;
}

async function loadBlocklist(): Promise<Set<string> | null> {
  const { data, error } = await supabaseAdmin.from("blocked_users").select("username");
  if (error) {
    console.warn("blocked_users read failed, treating nobody as blocked:", error.message);
    return null;
  }
  // Normalize on read too: rows written before normalizeHandle existed, or inserted
  // by hand in the SQL editor, would otherwise never match.
  return new Set((data ?? []).map((r: { username: string }) => normalizeHandle(r.username)));
}

/**
 * Is this guest on the do-not-reply list?
 *
 * `username` comes from instagram_conversations.username, which fetchInstagramProfile()
 * refreshes on every message. It is legitimately null when that Graph call failed
 * (src/lib/instagram.ts swallows the error and returns nulls), and an unknown handle
 * cannot match anything — so null means "not blocked".
 *
 * FAILS OPEN. A database error returns false and does not poison the cache. The
 * asymmetry is deliberate: failing closed would turn one transient blip into total
 * silence on every account, while failing open costs at most one extra reply to a
 * spammer. Same discipline as getUnavailableBlock() returning "" on any error.
 */
export async function isBlocked(username: string | null | undefined): Promise<boolean> {
  const handle = username ? normalizeHandle(username) : "";
  if (!handle) return false;

  try {
    if (!cache || Date.now() - cachedAt > TTL_MS) {
      const loaded = await loadBlocklist();
      if (!loaded) return false; // query failed — fail open, keep any stale cache out of it
      cache = loaded;
      cachedAt = Date.now();
    }
    return cache.has(handle);
  } catch (err) {
    console.warn("isBlocked threw, treating as not blocked:", (err as Error).message);
    return false;
  }
}
