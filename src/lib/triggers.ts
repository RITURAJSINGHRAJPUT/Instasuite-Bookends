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
  /**
   * Normalized outlet key for per-outlet WhatsApp routing (e.g. "vesu"), or null when it
   * can't be determined. Takeaway is exact (parsed from `[Outlet]–[City]`); reservation is
   * best-effort from the TableCheck URL slug. A null outlet routes to the business default.
   */
  outlet: string | null;
};

// Reduce whatever the AI emits for an outlet ("Vesu–Surat", "Vesu, Surat", "Vesu") to a
// stable routing key: the leading location word before any city separator, lowercased. The
// dashboard normalizes user-entered outlet names the same way, so keys match on exact
// equality (the worker does no fuzzy matching).
export function normalizeOutlet(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw
    .split(/[–—\-,/|]/)[0] // leading location, before any city separator
    .replace(/[[\]()]/g, "") // drop stray brackets/parens if the AI kept the template literal
    .trim()
    .toLowerCase();
  return first || null;
}

// TAKEAWAY line shape: `TAKEAWAY [Outlet]–[City] / [Items] / …`. Capture the whole token
// between "TAKEAWAY" and the first "/" (this survives literal brackets and the `–[City]`
// suffix); normalizeOutlet then reduces it to the leading outlet key.
const TAKEAWAY_OUTLET_RE = /^[ \t]*TAKEAWAY\s+([^/]+?)\s*\//i;
// TableCheck booking slugs look like `…capiche-<outlet>-<city>…` (Uni is `…-university`).
const TABLECHECK_OUTLET_RE = /capiche-([a-z]+)/i;

function outletForTakeaway(line: string): string | null {
  const m = line.match(TAKEAWAY_OUTLET_RE);
  return m ? normalizeOutlet(m[1]) : null;
}

function outletForReservation(url: string): string | null {
  const m = url.match(TABLECHECK_OUTLET_RE);
  return m ? m[1].toLowerCase() : null;
}

export function detectOrder(reply: string): DetectedOrder | null {
  // Takeaway first: the handoff line is the more specific, higher-value signal.
  const takeaway = reply.match(TAKEAWAY_RE);
  if (takeaway) {
    const body = takeaway[0].trim();
    return { kind: "takeaway", body, outlet: outletForTakeaway(body) };
  }

  const reservation = reply.match(TABLECHECK_RE);
  if (reservation) {
    const body = reservation[0].trim();
    return { kind: "reservation", body, outlet: outletForReservation(body) };
  }

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
