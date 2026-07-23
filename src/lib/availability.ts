import { supabaseAdmin } from "@/lib/supabase";

// Renders the currently-86'd dishes for a business into a system-prompt block the AI
// obeys. tenant.ts appends it AFTER the menu, so "overrides the menu" lands correctly.
//
// Returns "" on empty OR any error — availability must NEVER break a reply. The
// active-window math is done here in JS (UTC vs now()) rather than in SQL, so a single
// missing table or a malformed row degrades to "no restrictions" instead of throwing.

type Row = {
  dish: string;
  outlet: string | null;
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

export async function getUnavailableBlock(businessId: string): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin
      .from("unavailable_dishes")
      .select("dish, outlet, note, starts_at, ends_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });

    if (error || !data || data.length === 0) return "";

    const now = Date.now();
    const active = (data as Row[]).filter(
      (r) =>
        new Date(r.starts_at).getTime() <= now &&
        (r.ends_at == null || new Date(r.ends_at).getTime() > now)
    );
    if (active.length === 0) return "";

    const lines = active.map((r) => {
      const where = r.outlet?.trim() ? r.outlet.trim() : "all outlets";
      const until = r.ends_at ? `until ${istTime(r.ends_at)}` : "until further notice";
      const note = r.note?.trim() ? ` — ${r.note.trim()}` : "";
      return `- ${r.dish} — ${where} (${until})${note}`;
    });

    return [
      "## Temporarily Unavailable (overrides the menu)",
      "These items are 86'd right now. Do NOT offer, recommend, or confirm them. If a guest asks for one, say it's temporarily unavailable today and suggest a similar item. A line applies only to the outlet it names (or to all outlets).",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}
