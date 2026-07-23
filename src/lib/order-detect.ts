import crypto from "node:crypto";

// Detects the structured "handoff line" the AI appends when it finalizes a reservation or
// takeaway, so the webhook can (a) strip it from what the guest sees and (b) capture a real
// order row. Pure and synchronous — it runs in the reply path and must never throw.
//
// Reservation line (pipe-delimited; the script instructs the AI to emit exactly this):
//   RESERVATION | Outlet: <outlet> | Name: <name> | Date: <date> | Time: <time> | Guests: <n> | Contact: <number or ->
// Takeaway line (existing "Team Handoff Note Format" in the script):
//   TAKEAWAY [Outlet]–[City] / [Items] / Name:<name> | Contact:<number> | Pickup:<time>

const RESERVATION_RE = /^[ \t]*RESERVATION\s*\|.*$/im;
const TAKEAWAY_RE = /^[ \t]*TAKEAWAY\b.*$/im;

export type OrderKind = "reservation" | "takeaway";
export type DetectedOrder = {
  kind: OrderKind;
  /** The exact handoff line (used for the dedupe key). */
  line: string;
  /** Guest name parsed from the line, if present. */
  customer: string | null;
  /** A clean, human-readable summary for the dashboard + confirmation message. */
  summary: string;
};

// Parse `Key: value | Key: value` pairs out of a line. The reservation line is fully
// pipe-delimited so this yields every field; the takeaway line only partially matches
// (brackets/slashes break the key), which is fine — its customer falls back to the profile.
function parseFields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split("|")) {
    const m = part.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

export function detectHandoff(reply: string): DetectedOrder | null {
  const r = reply.match(RESERVATION_RE);
  if (r) {
    const line = r[0].trim();
    const f = parseFields(line);
    const summary =
      [
        f["outlet"] && `Outlet: ${f["outlet"]}`,
        f["date"] && `Date: ${f["date"]}`,
        f["time"] && `Time: ${f["time"]}`,
        f["guests"] && `Guests: ${f["guests"]}`,
        f["contact"] && f["contact"] !== "-" && `Contact: ${f["contact"]}`,
      ]
        .filter(Boolean)
        .join(" · ") || line.replace(/^RESERVATION\s*\|?\s*/i, "").trim();
    return { kind: "reservation", line, customer: f["name"] || null, summary };
  }

  const t = reply.match(TAKEAWAY_RE);
  if (t) {
    const line = t[0].trim();
    const f = parseFields(line);
    const summary =
      [
        f["outlet"] && `Outlet: ${f["outlet"]}`,
        f["items"] && `Items: ${f["items"]}`,
        f["pickup"] && `Pickup: ${f["pickup"]}`,
        f["contact"] && f["contact"] !== "-" && `Contact: ${f["contact"]}`,
      ]
        .filter(Boolean)
        .join(" · ") || line.replace(/^TAKEAWAY\s*\|?\s*/i, "").trim();
    return { kind: "takeaway", line, customer: f["name"] || null, summary };
  }

  return null;
}

// Remove the handoff line from the reply so the guest sees only the clean confirmation.
export function stripHandoff(reply: string): string {
  return reply
    .replace(RESERVATION_RE, "")
    .replace(TAKEAWAY_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Backs the orders.dedupe_key unique constraint — a verbatim re-emission collapses to one
// order; an edited one (different line) captures anew.
export function dedupeKey(kind: string, conversationId: string, line: string): string {
  const hash = crypto.createHash("sha1").update(line).digest("hex");
  return `${kind}:${conversationId}:${hash}`;
}
