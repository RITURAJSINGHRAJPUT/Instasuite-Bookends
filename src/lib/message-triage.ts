// Zero-cost heuristics that run BEFORE any AI call, so trivial messages never
// reach the paid Claude API. Every inbound message used to trigger a full call
// regardless of content — a bare emoji or a "thanks" cost the same as a real
// booking request. This is deliberately conservative: when in doubt, a message
// falls through to the real AI rather than risk silently swallowing something
// that actually needed an answer (e.g. "yes"/"ok" confirming a booking).

// \u{200D} = zero-width joiner (multi-part emoji like a family emoji built
// from several base emoji), \u{FE0F} = variation selector-16 (forces emoji
// presentation), \p{Emoji_Modifier} = skin-tone modifiers (e.g. the 🏽 in
// 👍🏽) — none of these are matched by \p{Extended_Pictographic} on their own.
// Written as escapes, not literal invisible characters, so the source stays
// unambiguous.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{200D}\u{FE0F}\s]+$/u;

export function isPureEmoji(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && EMOJI_ONLY.test(trimmed);
}

// Used ONLY for a conversation's first message — these are content-free
// greetings where the script's own instruction is just "send the generic
// welcome and ask reservation or takeaway", so a canned reply is a faithful
// stand-in, not a guess.
const NO_INTENT_OPENERS = new Set([
  "hi",
  "hello",
  "hey",
  "hii",
  "heyy",
  "yo",
  "info",
  "info?",
]);

export function isNoIntentOpener(text: string): boolean {
  if (isPureEmoji(text)) return true;
  return NO_INTENT_OPENERS.has(text.trim().toLowerCase());
}

// Used for any NON-first message. Deliberately narrow — "ok", "okay", "yes",
// "no", "sure", "alright" are excluded on purpose, because those are plausible
// real answers to a pending AI question (e.g. "Shall I confirm that?" -> "ok"
// means yes) and must never be silently dropped.
const TRIVIAL_ACKS = new Set([
  "thanks",
  "thank you",
  "thanks!",
  "thank you!",
  "thx",
  "ty",
  "thnx",
  "cheers",
]);

export function isTrivialAck(text: string): boolean {
  if (isPureEmoji(text)) return true;
  return TRIVIAL_ACKS.has(text.trim().toLowerCase());
}

export function cannedWelcome(businessName: string): string {
  return `Hey there! 👋 Welcome to ${businessName} — are you looking to book a table or place a takeaway order?`;
}

type Turn = { role: "user" | "assistant"; content: string };

/**
 * Collapses consecutive same-role turns into one (joined with a newline), in
 * order. Anthropic's Messages API requires strictly alternating user/assistant
 * roles — once bursts are debounced, several stored "user" rows can sit
 * back-to-back with no assistant row between them, which the API would
 * otherwise reject outright.
 */
export function mergeConsecutiveTurns<T extends Turn>(history: T[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n${turn.content}`;
    } else {
      merged.push({ role: turn.role, content: turn.content });
    }
  }
  return merged;
}
