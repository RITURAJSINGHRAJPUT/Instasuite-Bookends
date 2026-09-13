import { supabaseAdmin } from "@/lib/supabase";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendAndStore } from "@/lib/outbound";
import { feedbackSendAt, feedbackMessage } from "@/lib/feedback";
import { isBlocked } from "@/lib/blocklist";

// The post-dining feedback sweep, extracted from /api/cron/feedback so it has TWO callers:
// that route, and the webhook (via maybeSweepFeedback below).
//
// Why it can't only be a cron: the Render job that calls the route fired on 5 of 12 days,
// and 15 confirmed past reservations were never processed at all. A feedback DM is
// perishable — Instagram refuses any message more than 24h after the guest's last one — so a
// scheduler that misses a day doesn't delay the thank-you, it loses it. One guest's DM was
// due Saturday 3:15pm and was still unsent when someone clicked Feedback on Sunday evening,
// 39 hours later, and got "sent outside of allowed window".
//
// Piggybacking on inbound traffic removes that dependency: with 250+ conversations a day,
// anything due goes out within minutes of becoming due. The route stays idempotent
// (feedback_sent_at is stamped per order), so both callers can run without double-sending.

type Row = {
  id: string;
  scheduled_at: string;
  conversation_id: string | null;
  igsid: string | null;
  instagram_account_id: string | null;
  businesses: { public_handle: string | null } | { public_handle: string | null }[] | null;
  // The GUEST's handle, for the do-not-reply check — not the business's.
  instagram_conversations: { username: string | null } | { username: string | null }[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? v[0] ?? null : v;
}

export type SweepResult = {
  candidates: number;
  sent: number;
  failed: number;
  results: { order: string; ok: boolean; detail: string }[];
};

/**
 * Send every feedback DM that is due.
 *
 * `limit` caps how many messages ONE invocation will actually send. The cron passes no
 * limit and drains everything; the webhook-triggered path passes a small one, because its
 * work shares the webhook route's 60s maxDuration with the guest's actual AI reply — a
 * sweep clearing a backlog must never eat the budget that reply depends on. Skips are not
 * counted against the limit: they cost a row update, not a Graph call.
 */
export async function runFeedbackSweep(opts: { limit?: number } = {}): Promise<SweepResult> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const now = Date.now();
  // Look back a week, not 12 hours. With a 12h floor, any outage longer than that dropped due
  // bookings out of the window permanently — feedback_sent_at stayed null but they could never
  // be selected again. A wider floor plus the STALE_AFTER_MS stamp below drains them instead.
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Instagram refuses DMs outside the guest's 24h window, so a send due more than a day ago can
  // never succeed. Stamp those done rather than re-evaluating them on every run forever.
  const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id, scheduled_at, conversation_id, igsid, instagram_account_id, businesses(public_handle), instagram_conversations(username)"
    )
    .eq("kind", "reservation")
    // 'completed' too, not just 'confirmed' — a booking staff marked done is the one guest we
    // know for certain actually dined. Keying on 'confirmed' alone would have silently dropped
    // the thank-you for every table that got closed out before the 2h send window came round.
    .in("status", ["confirmed", "completed"])
    .is("feedback_sent_at", null)
    .not("scheduled_at", "is", null)
    .gte("scheduled_at", since);

  if (error) throw new Error(error.message);

  // Guests who asked to cancel must never be thanked for dining. On 11 Sep a guest sent a
  // cancellation request at 15:25 and got "thank you for dining with us!" at 17:19, because
  // nothing here knew the request existed.
  //
  // One query for the whole run rather than one per row — same set-building shape as
  // /api/orders. Deliberately NOT filtered to status 'pending', unlike that route: it
  // surfaces open work, whereas the question here is "did this guest ever ask to cancel?"
  // That 11 Sep request was already marked completed when the DM went out, and a resolved
  // request is still a reason not to send one.
  const { data: cancelReqs } = await supabaseAdmin
    .from("review_items")
    .select("conversation_id")
    .eq("category", "cancellation");
  const cancelRequested = new Set(
    (cancelReqs ?? []).map((r) => r.conversation_id).filter(Boolean)
  );

  const results: SweepResult["results"] = [];
  // One thank-you per guest, not per row. Duplicate order rows for the same conversation used to
  // each earn their own DM, so a guest could be thanked three times for one booking. Capture at
  // source is fixed too (see captureOrder), but this stays as the belt to that braces.
  const messagedConversations = new Set<string>();
  const stamp = (id: string) =>
    supabaseAdmin.from("orders").update({ feedback_sent_at: new Date().toISOString() }).eq("id", id);
  let attempted = 0;

  for (const row of (data ?? []) as unknown as Row[]) {
    const dueAt = feedbackSendAt(row.scheduled_at).getTime();
    if (now < dueAt) continue; // not due yet

    try {
      if (!row.igsid || !row.instagram_account_id) {
        results.push({ order: row.id, ok: false, detail: "no recipient snapshot" });
        continue;
      }

      // This guest asked to cancel. Thanking them for dining would be, at best, tone-deaf.
      // Stamped rather than merely skipped, or every future run reconsiders the same row.
      if (row.conversation_id && cancelRequested.has(row.conversation_id)) {
        await stamp(row.id);
        results.push({ order: row.id, ok: false, detail: "skipped: cancellation was requested" });
        continue;
      }

      // Too late to ever send — close it out so it stops being a candidate.
      if (now - dueAt > STALE_AFTER_MS) {
        await stamp(row.id);
        results.push({ order: row.id, ok: false, detail: "skipped: past the 24h window" });
        continue;
      }

      // A sibling row for this same chat already got the thank-you in this run.
      if (row.conversation_id && messagedConversations.has(row.conversation_id)) {
        await stamp(row.id);
        results.push({ order: row.id, ok: false, detail: "skipped: duplicate of same conversation" });
        continue;
      }

      // This thank-you is fully automated, so the do-not-reply list applies to it the
      // same way it applies to the webhook's AI replies. (Staff-triggered sends — the
      // Inbox composer, order confirm/cancel, the collab decline — are deliberately NOT
      // gated: those are a person choosing to write to someone.) Stamped done rather
      // than skipped, so an unblock months later doesn't resurrect a stale thank-you.
      if (await isBlocked(one(row.instagram_conversations)?.username ?? null)) {
        await stamp(row.id);
        results.push({ order: row.id, ok: false, detail: "skipped: blocked handle" });
        continue;
      }

      // Budget spent. Everything still due is left untouched — feedback_sent_at stays null,
      // so the next sweep picks it up a few minutes later, still well inside the 24h window.
      if (attempted >= limit) {
        results.push({ order: row.id, ok: false, detail: "deferred: sweep limit reached" });
        continue;
      }
      attempted++;

      const { data: acc } = await supabaseAdmin
        .from("instagram_accounts")
        .select("ig_account_id")
        .eq("id", row.instagram_account_id)
        .maybeSingle<{ ig_account_id: string }>();
      const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
      if (!resolved) {
        // Leave feedback_sent_at null so it retries once the account is back/approved.
        results.push({ order: row.id, ok: false, detail: "account unavailable" });
        continue;
      }

      const handle = one(row.businesses)?.public_handle ?? null;
      const message = feedbackMessage(handle);
      // Mirrors into the transcript only what was delivered, and only if the chat
      // still exists (it may have been deleted).
      const sent = await sendAndStore({
        conversationId: row.conversation_id,
        igsid: row.igsid,
        text: message,
        accessToken: resolved.accessToken,
      });
      const rejected = sent.error;
      // Claim the conversation even on a Meta rejection: the guest may still have received it,
      // and a sibling row retrying would risk a second copy.
      if (row.conversation_id) messagedConversations.add(row.conversation_id);

      // Stamp even on a Meta rejection (e.g. the 24h window) — the window won't reopen for a past
      // dine time, so retrying is pointless. A network throw skips this (caught below) and retries.
      await stamp(row.id);

      results.push({
        order: row.id,
        ok: sent.ok,
        detail: rejected ? `rejected: ${rejected.message || rejected.code || "policy"}` : "sent",
      });
    } catch (err) {
      console.error(`Feedback send failed for order ${row.id}:`, (err as Error).message);
      results.push({ order: row.id, ok: false, detail: (err as Error).message });
    }
  }

  return {
    candidates: data?.length ?? 0,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

// ---------------------------------------------------------------------------
// The traffic-driven trigger.
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Small on purpose — see `limit` on runFeedbackSweep. A backlog drains over several sweeps. */
const PER_SWEEP_LIMIT = 5;

// In-process state, which is the same assumption debounce.ts and queue.ts already make and
// document: one long-lived Render process. The cost of getting it wrong here is only a
// redundant sweep, and the sweep is idempotent.
let lastSweepAt = 0;
let inFlight = false;

/**
 * Run the sweep if it hasn't run recently. Called from the webhook on inbound traffic.
 *
 * NEVER throws and never returns anything the caller needs: a failure to send a thank-you
 * must not cost a guest their actual reply. Fire and forget.
 */
export async function maybeSweepFeedback(): Promise<void> {
  const now = Date.now();
  if (inFlight || now - lastSweepAt < MIN_INTERVAL_MS) return;
  inFlight = true;
  lastSweepAt = now;
  try {
    const r = await runFeedbackSweep({ limit: PER_SWEEP_LIMIT });
    if (r.sent > 0 || r.failed > 0) {
      console.log(`Feedback sweep (traffic): ${r.sent} sent, ${r.failed} skipped/failed.`);
    }
  } catch (err) {
    console.warn("Feedback sweep failed:", (err as Error).message);
  } finally {
    inFlight = false;
  }
}
