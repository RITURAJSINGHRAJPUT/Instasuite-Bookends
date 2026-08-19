import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage, fetchInstagramProfile } from "@/lib/instagram";
import { getAIResponse } from "@/lib/ai";
import { resolveAccountByIgId, type ResolvedAccount } from "@/lib/tenant";
import { checkMessageQuota } from "@/lib/usage";
import { withSlot } from "@/lib/queue";
import { debounce, DEBOUNCE_MS } from "@/lib/debounce";
import {
  isNoIntentOpener,
  isTrivialAck,
  cannedWelcome,
  mergeConsecutiveTurns,
} from "@/lib/message-triage";
import {
  detectHandoff,
  detectReview,
  stripHandoff,
  dedupeKey,
  refersToPastOrder,
} from "@/lib/order-detect";

// The reply is generated in after() (see below), and on Vercel that background
// work is bounded by THIS function's maxDuration — exceed it and the reply is
// killed mid-generation while Meta already got its 200, i.e. a silent no-reply.
// Pin it rather than depend on the platform default staying generous. An LLM
// reply is ~10-30s; 60s covers a small batch. Raise for slower models.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  // Platform-level: one Meta app = one callback URL = one verify token.
  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Messaging = any;

/**
 * Meta signs every webhook with the app secret. Without this check anyone who
 * learns the URL can forge an event — and now that entry[0].id selects a tenant,
 * a forged event is a cross-tenant write.
 */
function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    // Fail open only when unconfigured, and say so loudly — otherwise a missing
    // env var would silently drop every real message.
    console.warn("META_APP_SECRET not set — webhook signature NOT verified.");
    return true;
  }
  if (!header?.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const got = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(got, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  // Read the raw body: the signature is over exact bytes, so re-serialising breaks it.
  const raw = await request.text();

  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    console.warn("Rejected webhook with an invalid X-Hub-Signature-256.");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { object?: string; entry?: { id?: string; messaging?: Messaging[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.object !== "instagram") {
    return Response.json({ status: "ignored" });
  }

  // Acknowledge Meta immediately (must respond within ~5s or it retries the event,
  // causing duplicate processing). Heavy work runs after the response.
  for (const entry of body.entry ?? []) {
    // entry.id IS the destination Instagram business account — i.e. which tenant
    // this DM belongs to. Everything downstream is scoped by it.
    const igAccountId = entry.id;
    if (!igAccountId) continue;

    for (const messaging of entry.messaging ?? []) {
      if (!messaging?.message?.text) continue;
      // Echoes fire for EVERY outbound message on the account — ours (AI/dashboard,
      // already stored when sent) and anything sent manually from the connected
      // account's own Instagram app. processEcho tells the two apart by mid.
      if (messaging?.message?.is_echo) {
        after(() => withSlot(() => processEcho(igAccountId, messaging)));
        continue;
      }
      // Bounded: a burst of DMs queues instead of firing unlimited concurrent AI calls.
      after(() => withSlot(() => processMessage(igAccountId, messaging)));
    }
  }

  return Response.json({ status: "received" });
}

async function processMessage(igAccountId: string, messaging: Messaging) {
  const igsid = messaging.sender.id;
  const text = messaging.message.text;
  const instagramMsgId = messaging.message.mid;

  try {
    // Which tenant owns this account? Unknown / unapproved => ignore. Never fall
    // back to another tenant.
    const account = await resolveAccountByIgId(igAccountId);
    if (!account) return;

    const conversation = await findOrCreateConversation(account, igsid);
    if (!conversation) {
      console.error("Failed to create conversation for", igsid, "on", igAccountId);
      return;
    }

    // Store user message. Duplicate mid (Meta retry) is now scoped per-conversation.
    const { error: insertError } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: text,
      instagram_msg_id: instagramMsgId,
    });
    if (insertError?.code === "23505") return;

    await touch(conversation.id);

    if (conversation.mode === "human") return;

    // Cost pre-filter — runs before anything that touches the paid AI. A bare
    // emoji or "thanks" used to trigger a full Claude call with the ~19K-char
    // script every single time; neither case needs the model at all.
    const { count: messageCount } = await supabaseAdmin
      .from("instagram_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversation.id);
    const isFirstMessage = messageCount === 1;

    if (isFirstMessage && isNoIntentOpener(text)) {
      // Faithful stand-in for the AI's own scripted welcome line — no AI call.
      await sendCannedReply(account, conversation.id, igsid, cannedWelcome(account.businessName));
      return;
    }
    if (!isFirstMessage && isTrivialAck(text)) {
      // A bare emoji or "thanks" needs no reply at all — nothing sent, nothing generated.
      return;
    }

    // Real content: debounce so a burst of several quick messages ("hi", "table
    // for 2", "tonight 8pm" as three bubbles) becomes ONE AI call, not three.
    // Already running inside the caller's after() background task — no need to
    // nest another after() here, and the setTimeout it schedules relies on this
    // being a single long-lived process (Render), same constraint queue.ts
    // already documents for its own in-process concurrency gate.
    debounce(conversation.id, DEBOUNCE_MS, () => {
      withSlot(() => generateAndSendReply(igAccountId, conversation.id)).catch((error) =>
        console.error("Debounced reply error:", error)
      );
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

// Sends a fixed, non-AI reply (the canned first-message welcome). Mirrors the
// storage side of generateAndSendReply's real send, minus everything AI-only.
async function sendCannedReply(
  account: ResolvedAccount,
  conversationId: string,
  igsid: string,
  text: string
) {
  const sendResult = await sendInstagramMessage(igsid, text, account.accessToken);
  await supabaseAdmin.from("instagram_messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: text,
    instagram_msg_id: sendResult?.message_id ?? null,
  });
  await touch(conversationId);
}

// The AI-calling path, run after the debounce window settles. Re-resolves the
// account and re-fetches the conversation fresh rather than trusting a closure
// captured several seconds ago — mode may have changed in the meantime (e.g. a
// manual phone reply arrived and handed the conversation to a human).
async function generateAndSendReply(igAccountId: string, conversationId: string) {
  try {
    const account = await resolveAccountByIgId(igAccountId);
    if (!account) return;

    const { data: conversation } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conversation) return;
    if (conversation.mode === "human") return;

    const igsid = conversation.igsid;

    // Plan quota. Checked BEFORE the AI call, because the AI call is the thing
    // that costs money. The inbound message(s) are already stored, so nothing is
    // lost — the tenant just stops getting auto-replies until the period rolls
    // over or they upgrade.
    const quota = await checkMessageQuota(account.clientId);
    if (!quota.allowed) {
      console.warn(
        `Quota blocked reply for client ${account.clientId} on @${account.username}: ${quota.reason}`
      );
      return;
    }

    // Fresh start after an order: once a reservation/takeaway is captured we stamp
    // `context_reset_at` (below), and from then on the AI is fed ONLY the messages after that
    // point — the finished order is hidden so the AI can't resume or re-confirm it. The one
    // exception is when the guest clearly asks about a past order: then we lift the filter for
    // this single turn so the AI has the full transcript to answer from.
    const resetAt = (conversation as { context_reset_at?: string | null }).context_reset_at ?? null;

    const { data: rawHistory } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(20);
    const rows = rawHistory || [];

    // Debounce may have batched several guest bubbles since the last assistant
    // turn — check intent across all of them, not just the very last one.
    const trailingUserText = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].role === "user"; i--) {
      trailingUserText.unshift(rows[i].content);
    }
    const wantsPast = refersToPastOrder(trailingUserText.join("\n"));

    // The guest is revising a "finished" order — it's not really finished
    // anymore. Clear the reset boundary (not just lift it for this one turn)
    // so a bare follow-up answer ("4:30 PM", answering the AI's own "what
    // time?") keeps seeing full history too, instead of losing the order the
    // moment the guest's reply no longer contains a trigger keyword itself.
    // A new handoff line (see below) re-stamps a fresh boundary once the
    // revised order is actually finalized.
    if (resetAt && wantsPast) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ context_reset_at: null })
        .eq("id", conversation.id);
    }

    const filtered =
      resetAt && !wantsPast ? rows.filter((m) => m.created_at > resetAt) : rows;

    // This tenant's script — not a module-level constant.
    const ai = await getAIResponse(
      mergeConsecutiveTurns(
        filtered
          .map((m) => ({
            role: m.role as "user" | "assistant",
            // Never feed a raw handoff line back to the model — a previously-leaked one in the history
            // makes it echo the same order every turn (a loop). Strip it from assistant turns; a turn
            // that was ONLY a handoff line becomes empty and is dropped below.
            content: m.role === "assistant" ? stripHandoff(m.content).trim() : m.content,
          }))
          .filter((m) => m.content.length > 0)
      ),
      { systemPrompt: account.systemPrompt }
    );

    // If the AI appended a reservation/takeaway handoff line — or a REVIEW line for a matter that
    // needs a human — strip it so the guest sees only the clean reply; the row is captured below.
    const detected = detectHandoff(ai.text);
    const detectedReview = detectReview(ai.text);
    const stripped = (detected || detectedReview ? stripHandoff(ai.text) : ai.text).trim();
    // NEVER leak the raw internal handoff line to the guest. If stripping leaves nothing (the model
    // replied with only the note), send a safe line instead of the raw grammar — and this clean text
    // is what gets stored below, so the history stays uncontaminated.
    const customerText =
      stripped || "Thanks! I've noted that — our team will confirm and follow up shortly. 🙌";

    // Reply FROM this tenant's account: the token is the sender identity.
    const sendResult = await sendInstagramMessage(igsid, customerText, account.accessToken);

    const { data: assistantMsg } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: customerText,
        // Recorded so the later echo of this same send (see processEcho below) is
        // recognized as ours and deduped instead of appearing as a second message.
        instagram_msg_id: sendResult?.message_id ?? null,
      })
      .select("created_at")
      .single<{ created_at: string }>();

    await touch(conversation.id);
    await recordUsage(account, ai);

    if (detected) {
      await captureOrder(account, conversation, detected);
      // Fresh-start boundary: hide everything up to and including this confirmation from future AI
      // turns. Using the confirmation message's own DB timestamp (with the strict `>` filter above)
      // keeps the cut exact regardless of app-vs-DB clock skew. Covers reservations AND takeaways.
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ context_reset_at: assistantMsg?.created_at ?? new Date().toISOString() })
        .eq("id", conversation.id);
    }
    if (detectedReview) await captureReview(account, conversation, detectedReview);

    // Hand the conversation to a human — future inbound messages aren't auto-answered (the guard
    // near the top of processMessage early-returns on mode === "human"), so staff pick it up. Two
    // reasons: (a) Claude couldn't answer (paused key, outage, or refusal) — the safe holding
    // message was already sent above and we never serve weak-model output; or (b) the AI flagged a
    // REVIEW matter (collab/complaint/…) that a person must take over.
    if (ai.unavailable || detectedReview) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ mode: "human" })
        .eq("id", conversation.id);
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

/**
 * An echo of an outbound message on the account. Sender/recipient are flipped
 * versus a normal inbound event: the business account is the sender, the guest
 * is the recipient.
 *
 * We never know in advance whether an echo is one of ours (AI reply or a
 * dashboard-sent reply, both already stored with this same mid when sent) or a
 * reply typed directly in the Instagram app on someone's phone (never stored
 * anywhere). Rather than guess, we just try to insert it: the partial unique
 * index on (conversation_id, instagram_msg_id) makes a duplicate a no-op via
 * the same 23505 swallow used for inbound retries, while a genuinely new mid
 * inserts cleanly — which is exactly the phone-app case this exists to catch.
 */
async function processEcho(igAccountId: string, messaging: Messaging) {
  const igsid = messaging.recipient.id;
  const text = messaging.message.text;
  const instagramMsgId = messaging.message.mid;

  try {
    const account = await resolveAccountByIgId(igAccountId);
    if (!account) return;

    const conversation = await findOrCreateConversation(account, igsid);
    if (!conversation) return;

    const { error: insertError } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: text,
      instagram_msg_id: instagramMsgId,
    });
    if (insertError?.code === "23505") return; // ours — already recorded when sent

    // Genuinely new: sent from outside Instasuite (the phone app). A human is
    // clearly already handling this guest, so stop the AI from also replying.
    await touch(conversation.id);
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ mode: "human" })
      .eq("id", conversation.id);
  } catch (error) {
    console.error("Webhook echo processing error:", error);
  }
}

// Persist a captured reservation/takeaway as a pending order row. Guarded so it can never
// break the reply (already sent above), and swallows the 23505 dedupe collision the same way
// the message insert does. Staff confirm it later from the Orders page.
async function captureOrder(
  account: ResolvedAccount,
  conversation: { id: string; igsid: string; name?: string | null; username?: string | null },
  detected: NonNullable<ReturnType<typeof detectHandoff>>
) {
  try {
    const customer =
      detected.customer || conversation.name || conversation.username || "Guest";
    const { error } = await supabaseAdmin.from("orders").insert({
      business_id: account.businessId,
      conversation_id: conversation.id,
      igsid: conversation.igsid,
      instagram_account_id: account.accountId,
      kind: detected.kind,
      customer_name: customer,
      details: detected.summary,
      scheduled_at: detected.scheduledAt,
      dedupe_key: dedupeKey(detected.kind, conversation.id, detected.line),
    });
    if (error && error.code !== "23505") {
      console.warn("orders insert failed:", error.message);
    }
  } catch (err) {
    console.warn("captureOrder error:", (err as Error).message);
  }
}

// Persist a captured REVIEW matter (collab/complaint/billing/event/other) as a pending review row.
// Same guards as captureOrder: never breaks the reply (already sent), swallows the 23505 dedupe
// collision. Staff work these from the Review page; the conversation is flipped to human above.
async function captureReview(
  account: ResolvedAccount,
  conversation: { id: string; igsid: string; name?: string | null; username?: string | null },
  detected: NonNullable<ReturnType<typeof detectReview>>
) {
  try {
    const customer =
      detected.customer || conversation.name || conversation.username || "Guest";
    const { error } = await supabaseAdmin.from("review_items").insert({
      business_id: account.businessId,
      conversation_id: conversation.id,
      igsid: conversation.igsid,
      instagram_account_id: account.accountId,
      category: detected.category,
      customer_name: customer,
      details: detected.summary,
      dedupe_key: dedupeKey("review", conversation.id, detected.line),
    });
    if (error && error.code !== "23505") {
      console.warn("review_items insert failed:", error.message);
    }
  } catch (err) {
    console.warn("captureReview error:", (err as Error).message);
  }
}

async function findOrCreateConversation(account: ResolvedAccount, igsid: string) {
  // Scoped by account: the same customer may talk to several tenants, and each
  // gets its own conversation (this is what UNIQUE(instagram_account_id, igsid) allows).
  const { data: existing } = await supabaseAdmin
    .from("instagram_conversations")
    .select("*")
    .eq("instagram_account_id", account.accountId)
    .eq("igsid", igsid)
    .maybeSingle();

  const profile = await fetchInstagramProfile(igsid, account.accessToken);

  if (existing) {
    await supabaseAdmin
      .from("instagram_conversations")
      .update(profile)
      .eq("id", existing.id);
    return { ...existing, ...profile };
  }

  const { data: created, error } = await supabaseAdmin
    .from("instagram_conversations")
    .insert({ instagram_account_id: account.accountId, igsid, ...profile })
    .select()
    .single();

  if (error) console.error("Conversation insert failed:", error.message);
  return created;
}

async function touch(conversationId: string) {
  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

// Per-reply COGS. Phase 3 bills off this table.
async function recordUsage(
  account: ResolvedAccount,
  ai: Awaited<ReturnType<typeof getAIResponse>>
) {
  if (ai.provider === "none") return;
  // Haiku 4.5: $1/1M in, $5/1M out -> cents per token.
  const costCents =
    ai.provider === "claude" && ai.inputTokens != null && ai.outputTokens != null
      ? (ai.inputTokens / 1_000_000) * 100 + (ai.outputTokens / 1_000_000) * 500
      : 0;

  await supabaseAdmin.from("usage_events").insert({
    client_id: account.clientId,
    business_id: account.businessId,
    instagram_account_id: account.accountId,
    kind: "ai_reply",
    model: ai.model,
    input_tokens: ai.inputTokens,
    output_tokens: ai.outputTokens,
    cost_cents: costCents,
  });
}
