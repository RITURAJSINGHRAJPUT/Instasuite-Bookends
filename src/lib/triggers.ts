import crypto from "node:crypto";

// Detects, from an AI reply, whether the agent just captured a takeaway order or
// shared a reservation link — the two "notify the reservation team" signals.
//
// Pure and synchronous by design: this runs inside the webhook's reply path, so it
// must never do I/O and never throw. It returns a small descriptor; the caller
// queues it to `whatsapp_outbox` and a self-hosted worker does the actual sending.

// The agent emits a structured Team Handoff Note when an order is placed
// (src/lib/script.ts:100):
//   TAKEAWAY [Outlet]–[City] / [Items] / Name:[Name] | Contact:[Number] | Pickup:[Time]
// Require one of the handoff fields on the same line so a stray mention of the word
// "takeaway" in guest-facing prose can't trigger a false order. `m` anchors ^ to a
// line start; `.` never crosses the newline, so the match is exactly that one line.
export const TAKEAWAY_RE = /^[ \t]*TAKEAWAY\b.*(?:Name:|Contact:|Pickup:).*/im;

// The only reservation signal that exists: the agent shared a TableCheck link
// (matches RESERVATION_RE in src/app/api/analytics/accounts/route.ts). Reservations
// complete off-platform, so a shared link is the closest thing to "a booking began".
export const TABLECHECK_RE = /https?:\/\/(?:www\.)?tablecheck\.com\/\S+/i;

export type DetectedOrder = {
  kind: "takeaway" | "reservation";
  /** The exact detected text — the handoff line or the booking URL. */
  body: string;
};

export function detectOrder(reply: string): DetectedOrder | null {
  // Takeaway first: the handoff line is the more specific, higher-value signal.
  const takeaway = reply.match(TAKEAWAY_RE);
  if (takeaway) return { kind: "takeaway", body: takeaway[0].trim() };

  const reservation = reply.match(TABLECHECK_RE);
  if (reservation) return { kind: "reservation", body: reservation[0].trim() };

  return null;
}

// The anti-spam key backing whatsapp_outbox's unique constraint. Hashing the body
// means a verbatim re-emission collapses to one notification, while an EDITED order
// (different items / name / pickup) produces a new key and re-notifies — the kitchen
// needs the amendment. Scoped per conversation so two guests placing the same order
// don't collide.
export function dedupeKey(kind: string, conversationId: string, body: string): string {
  const hash = crypto.createHash("sha1").update(body).digest("hex");
  return `${kind}:${conversationId}:${hash}`;
}
