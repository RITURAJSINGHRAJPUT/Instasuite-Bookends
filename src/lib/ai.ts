import Anthropic from "@anthropic-ai/sdk";

type ChatMessage = { role: "user" | "assistant"; content: string };

export type AIOptions = {
  /** The tenant's script, resolved by the caller from account -> business. */
  systemPrompt: string;
  model?: string;
};

export type AIResult = {
  text: string;
  /** Which provider answered — callers meter usage off this. "none" == Claude couldn't. */
  provider: "claude" | "none";
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * True when Claude could not produce a usable reply (paused key, outage, or refusal)
   * and `text` is a safe holding message. The caller should hand the conversation to a
   * human rather than keep auto-replying. We deliberately do NOT fall back to weaker
   * models — a wrong or garbled reply to a real customer is worse than a brief holding
   * message plus a human stepping in.
   */
  unavailable: boolean;
};

// The Anthropic key is a PLATFORM credential (we pay, then bill the tenant), not
// per-tenant — so this client holds no tenant state and is safe to share. What must
// never be module-scope is the system prompt: that is per-tenant, always passed in.
const anthropic = new Anthropic();
const DEFAULT_CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

// Shown to the guest whenever Claude can't answer. Paired with a human handoff by the
// caller (see webhook), so "our team will get back to you" is truthful.
const OUTAGE_MESSAGE = "Thanks for your message! Our team will get back to you shortly.";

// Conversation-hygiene rules appended to EVERY tenant's system prompt. Without them a
// model can treat each turn fresh — re-asking for details the guest already gave — or
// narrate its reasoning; these pull it back toward tracking state and staying coherent.
const REPLY_GUARD = [
  "Reply with only the message to send to the guest — no preamble, no quotes, no explanation of your reasoning.",
  "Track what the guest has already told you. Never ask again for a detail they have already given (name, date, time, party size, contact, outlet, or order items). Acknowledge what you have and ask only for what is still missing.",
  "Once you have everything needed to place a reservation or takeaway order, confirm it back to the guest and proceed to the hand-off — do not repeat the request for details.",
  "Write only in clear, natural English (or the language the guest is writing in). Never insert stray words or characters from an unrelated language mid-message.",
].join("\n");

// A safe holding-message result. Every non-answer path returns this shape so the caller
// can uniformly detect an outage via `unavailable` and hand off to a human.
const outageResult = (): AIResult => ({
  text: OUTAGE_MESSAGE,
  provider: "none",
  model: null,
  inputTokens: null,
  outputTokens: null,
  unavailable: true,
});

export async function getAIResponse(
  messages: ChatMessage[],
  options: AIOptions
): Promise<AIResult> {
  const system = `${options.systemPrompt}\n\n${REPLY_GUARD}`;
  const claudeModel = options.model || DEFAULT_CLAUDE_MODEL;

  // The API rejects a history that opens with an assistant turn, which is reachable
  // when a human starts the thread from the dashboard's send route.
  const history = [...messages];
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) return outageResult();

  try {
    const res = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: 1024,
      system,
      messages: history,
    });

    if (res.stop_reason === "refusal") {
      // Claude declined — hand to a human rather than push a canned answer.
      return {
        text: "Our team will be happy to help! Let me connect you.",
        provider: "claude",
        model: claudeModel,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
        unavailable: true,
      };
    }

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (text) {
      return {
        text,
        provider: "claude",
        model: claudeModel,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
        unavailable: false,
      };
    }
    console.warn("Claude returned no text — serving a holding message.");
  } catch (err) {
    // Paused/invalid key, rate limit, outage, etc. No weak-model fallback: send a safe
    // holding message and let the caller hand the conversation to a human.
    console.warn("Claude call failed — serving a holding message:", (err as Error).message);
  }

  return outageResult();
}

// Reshape arbitrary business notes (uploaded doc) into the app's DM-agent script
// format. NOT via getAIResponse: that path caps output at 1024 tokens (a full script
// is larger) and returns a guest-facing holding message on failure rather than throwing.
// Fills the editor for human review — never auto-saved.
const REFORMAT_SYSTEM = (businessName: string) => `You convert a business's raw notes into a system-prompt "script" that governs an AI assistant answering that business's Instagram DMs. The business is "${businessName}".

Reshape the user's content into a clear Markdown script with these sections:
- **Persona** — who the assistant is (the voice of ${businessName}) and its goal.
- **What it can help with** — the topics it should handle.
- **Facts it may state** — menu, prices, hours, locations, booking/links, policies. Use ONLY facts present in the source. Never invent a price, item, hour, address, or link. If the source lacks something, omit it (or note the assistant should offer to connect a human).
- **Rules** — always include: never volunteer prices unless the customer explicitly asks (then answer); never make up facts; hand off to a human when unsure or asked something out of scope; stay in character.
- **Tone** — concise, warm, on-brand.

Preserve every real detail from the source; reorganize, don't discard. Output ONLY the script in Markdown — no preamble, no commentary, no code fences around the whole thing.`;

export async function reformatToScript(sourceText: string, businessName: string): Promise<string> {
  const res = await anthropic.messages.create({
    model: DEFAULT_CLAUDE_MODEL,
    max_tokens: 8192,
    system: REFORMAT_SYSTEM(businessName),
    messages: [{ role: "user", content: sourceText }],
  });

  if (res.stop_reason === "refusal") {
    throw new Error("The model declined to reformat this file.");
  }
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("The model returned an empty script.");
  return text;
}
