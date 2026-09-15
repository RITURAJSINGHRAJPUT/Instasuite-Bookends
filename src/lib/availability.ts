import { supabaseAdmin } from "@/lib/supabase";

// Renders the currently-86'd dishes AND the currently-closed outlets for a business into a
// system-prompt block the AI obeys. tenant.ts appends it AFTER the menu, so "overrides the menu"
// lands correctly.
//
// Returns "" on empty OR any error — availability must NEVER break a reply. The active-window math
// is done here in JS (UTC vs now()) rather than in SQL, so a single missing table or a malformed
// row degrades to "no restrictions" instead of throwing.

type DishRow = {
  dish: string;
  outlet: string | null;
  note: string | null;
  starts_at: string;
  ends_at: string | null;
};

type OutletRow = {
  outlet: string;
  note: string | null;
  starts_at: string;
  ends_at: string | null;
};

// Display-only, in IST (the app serves India; the rest of the codebase runs UTC).
function istTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A row is active while it has started and hasn't ended.
function isActive(r: { starts_at: string; ends_at: string | null }, now: number): boolean {
  return (
    new Date(r.starts_at).getTime() <= now &&
    (r.ends_at == null || new Date(r.ends_at).getTime() > now)
  );
}

// Does an order's outlet fall under an ACTIVE closure from the Unavailable tab?
//
// This exists because the Unavailable tab and the Closed Days feature write to two different
// tables, and only one of them was ever enforced. `closed_days` has isClosedOn() gating the
// webhook; `unavailable_outlets` had nothing but the prompt block above — and the prompt lost.
// On 15 Sep, with Piplod marked closed, the agent offered Piplod as an option in its very first
// reply, confirmed it when the guest picked it, and a colleague had to interrupt with "Piplod is
// closed today". Same lesson as the takeaway flag: the prompt states the rule, the code is what
// makes it true.
//
// Never throws and answers FALSE on any error — a lookup failure must not block a real booking.

/**
 * Outlet names are free text on both sides, so this compares the DISTINCTIVE part and
 * deliberately ignores the city.
 *
 * Naive substring matching would be actively dangerous here: "Piplod, Surat" and "Vesu, Surat"
 * share "Surat", so matching on any common token would shut every Surat outlet the moment one
 * of them closed.
 */
function sameOutlet(closure: string, ordered: string): boolean {
  const key = (v: string) =>
    v.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const a = key(closure);
  const b = key(ordered);
  if (!a || !b) return false;
  // Either direction: the dropdown stores "Uni, Ahmedabad" while the agent writes
  // "University Road, Ahmedabad", and "Piplod, Surat" may arrive as bare "Piplod".
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export async function isOutletUnavailable(
  businessId: string,
  outlet: string | null,
  whenIso: string | null
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("unavailable_outlets")
      .select("outlet, starts_at, ends_at")
      .eq("business_id", businessId);
    if (error) return false;

    const rows = ((data ?? []) as OutletRow[]).filter((r) => r.outlet?.trim());
    if (!rows.length) return false;

    // An order with no pinned date (parseAbsDate refuses "today"/"Saturday") is one the guest
    // means imminently, so it is judged against NOW. A dated one is judged against its own
    // time — a booking for next week must not be blocked by a closure ending tonight.
    const at = whenIso ? new Date(whenIso).getTime() : Date.now();
    if (Number.isNaN(at)) return false;

    // A business with a single outlet can't have an order "somewhere else", so an outlet
    // closure covers it whatever the agent called it. Beshak's outlet is stored as "Dumas road
    // Surat" but the agent writes "Beshak Surat" — no name match would ever succeed there.
    const { data: outlets } = await supabaseAdmin
      .from("outlets")
      .select("id")
      .eq("business_id", businessId);
    const soleOutlet = (outlets ?? []).length === 1;

    return rows.some(
      (r) => isActive(r, at) && (soleOutlet || (outlet ? sameOutlet(r.outlet, outlet) : false))
    );
  } catch {
    return false;
  }
}

export async function getUnavailableBlock(businessId: string): Promise<string> {
  try {
    const now = Date.now();

    const [dishesRes, outletsRes] = await Promise.all([
      supabaseAdmin
        .from("unavailable_dishes")
        .select("dish, outlet, note, starts_at, ends_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("unavailable_outlets")
        .select("outlet, note, starts_at, ends_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: true }),
    ]);

    const dishes = (dishesRes.error ? [] : ((dishesRes.data ?? []) as DishRow[])).filter((r) =>
      isActive(r, now)
    );
    const outlets = (outletsRes.error ? [] : ((outletsRes.data ?? []) as OutletRow[])).filter((r) =>
      isActive(r, now)
    );

    const sections: string[] = [];

    // Closed outlets first — a closure overrides everything (including any dish lines for that outlet).
    if (outlets.length > 0) {
      const lines = outlets.map((r) => {
        const until = r.ends_at ? `until ${istTime(r.ends_at)}` : "until further notice";
        const note = r.note?.trim() ? ` — ${r.note.trim()}` : "";
        return `- ${r.outlet.trim()} (${until})${note}`;
      });
      sections.push(
        [
          "## Closed Outlets (overrides everything)",
          "These outlets are fully closed right now. Do NOT take reservations, takeaway orders, or bookings for them, and do not suggest visiting them. If a guest asks about one, say that outlet is closed (until the time shown, if any) and offer another outlet if one is open.",
          ...lines,
        ].join("\n")
      );
    }

    if (dishes.length > 0) {
      const lines = dishes.map((r) => {
        const where = r.outlet?.trim() ? r.outlet.trim() : "all outlets";
        const until = r.ends_at ? `until ${istTime(r.ends_at)}` : "until further notice";
        const note = r.note?.trim() ? ` — ${r.note.trim()}` : "";
        return `- ${r.dish} — ${where} (${until})${note}`;
      });
      sections.push(
        [
          "## Temporarily Unavailable (overrides the menu)",
          "These items are 86'd right now. Do NOT offer, recommend, or confirm them. If a guest asks for one, say it's temporarily unavailable today and suggest a similar item. A line applies only to the outlet it names (or to all outlets).",
          ...lines,
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  } catch {
    return "";
  }
}
