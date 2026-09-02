// Normalises the media Instagram attaches to an inbound DM — story replies, story
// mentions, shared posts/reels, and plain image/video/audio uploads.
//
// Pure and synchronous, and it must never throw: it runs inside the webhook's
// message path, where an exception would cost the guest their reply. Every branch
// is defensive about shape.
//
// Instagram puts this data in TWO different places, which is the main thing this
// module exists to hide from callers:
//   - a reply to OUR story  -> message.reply_to.story  ({ id, url }), sent alongside
//                              the guest's own text
//   - everything else       -> message.attachments[]   ({ type, payload: { url } })

export type MediaKind =
  | "story_reply"
  | "story_mention"
  | "post"
  | "reel"
  | "image"
  | "video"
  | "audio"
  | "other";

export type Media = {
  kind: MediaKind;
  /** Meta's CDN URL. SHORT-LIVED — expect it to expire within about a day. */
  url: string | null;
  /** Present on some shares (post caption / reel title). */
  title?: string | null;
  /** The raw `type` string when we didn't recognise it, so nothing is lost. */
  rawType?: string;
};

// Meta's `attachments[].type` -> our kind. Anything not listed becomes "other"
// WITH its raw type preserved, so an unanticipated shape shows up in the data
// rather than vanishing — we can fold it in properly once we've seen a real one.
const TYPE_MAP: Record<string, MediaKind> = {
  story_mention: "story_mention",
  share: "post",
  ig_reel: "reel",
  reel: "reel",
  image: "image",
  video: "video",
  audio: "audio",
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Every piece of media on an inbound message, normalised. Returns [] for a plain
 * text message — callers can treat "no media" and "text only" identically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseIncomingMedia(message: any): Media[] {
  const out: Media[] = [];
  try {
    // A reply to one of OUR stories. Carries the guest's text separately, so this
    // is additive rather than an alternative to it.
    const story = message?.reply_to?.story;
    if (story) {
      out.push({ kind: "story_reply", url: str(story.url), title: null });
    }

    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    for (const a of attachments) {
      const rawType = typeof a?.type === "string" ? a.type : "";
      const kind = TYPE_MAP[rawType] ?? "other";
      out.push({
        kind,
        url: str(a?.payload?.url),
        title: str(a?.payload?.title),
        ...(kind === "other" ? { rawType: rawType || "unknown" } : {}),
      });
    }
  } catch {
    // Never let a malformed payload break the reply path.
    return out;
  }
  return out;
}

/** True when the message carries anything beyond plain text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hasMedia(message: any): boolean {
  return parseIncomingMedia(message).length > 0;
}

const LABELS: Record<MediaKind, string> = {
  story_reply: "replied to your story",
  story_mention: "mentioned you in their story",
  post: "shared a post",
  reel: "shared a reel",
  image: "sent a photo",
  video: "sent a video",
  audio: "sent a voice message",
  other: "sent an attachment",
};

/**
 * A short bracketed descriptor for the AI's history, e.g. "[replied to your story]".
 *
 * The model otherwise sees a story reply as a context-free remark, and an
 * attachment-only message as an EMPTY turn — which the webhook's
 * `.filter(m => m.content.length > 0)` drops, leaving an empty history that makes
 * getAIResponse fall back to the outage message. Returns "" when there's no media.
 */
export function describeMedia(media: Media[]): string {
  if (!media.length) return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const m of media) {
    const label = LABELS[m.kind] ?? LABELS.other;
    if (seen.has(label)) continue;
    seen.add(label);
    parts.push(label);
  }
  return `[${parts.join(", ")}]`;
}
