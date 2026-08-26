import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext, getOwnedConversation } from "@/lib/ownership";
import { can } from "@/lib/permissions";

// Lets staff log an order/reservation they handled manually in the chat (typed
// their own reply instead of letting the AI produce the structured handoff
// line) — otherwise a real booking is invisible on /orders forever, since
// capture there normally only happens by parsing the AI's own RESERVATION/
// TAKEAWAY line. No DM is ever sent from here: whatever staff already told
// the guest in the conversation stands; this only creates the record.

function buildDetails(fields: {
  kind: string;
  outlet: string;
  guestsOrItems: string;
  contact: string;
  scheduledAt: string | null;
}): string {
  const parts: string[] = [];
  if (fields.outlet.trim()) parts.push(`Outlet: ${fields.outlet.trim()}`);
  if (fields.scheduledAt) {
    const d = new Date(fields.scheduledAt);
    const dateLabel = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
    const timeLabel = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
    parts.push(`Date: ${dateLabel}`);
    parts.push(fields.kind === "reservation" ? `Time: ${timeLabel}` : `Pickup: ${timeLabel}`);
  }
  if (fields.guestsOrItems.trim()) {
    parts.push(fields.kind === "reservation" ? `Guests: ${fields.guestsOrItems.trim()}` : `Items: ${fields.guestsOrItems.trim()}`);
  }
  if (fields.contact.trim()) parts.push(`Contact: ${fields.contact.trim()}`);
  return parts.join(" · ");
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const conversation = await getOwnedConversation(id, ctx);
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const kind = String(body?.kind ?? "");
  if (kind !== "reservation" && kind !== "takeaway") {
    return Response.json({ error: "kind must be 'reservation' or 'takeaway'" }, { status: 400 });
  }
  const customerName = String(body?.customer_name ?? "").trim() || conversation.name || conversation.username || "Guest";
  const outlet = String(body?.outlet ?? "");
  const guestsOrItems = String(body?.guests_or_items ?? "");
  const contact = String(body?.contact ?? "");
  const scheduledAtInput = body?.scheduled_at ? String(body.scheduled_at) : null;
  const scheduledAt = scheduledAtInput ? new Date(scheduledAtInput).toISOString() : null;
  const alreadyConfirmed = !!body?.already_confirmed;

  const { data: account } = await supabaseAdmin
    .from("instagram_accounts")
    .select("business_id")
    .eq("id", conversation.instagram_account_id)
    .maybeSingle<{ business_id: string }>();
  if (!account) return Response.json({ error: "Instagram account unavailable" }, { status: 502 });

  const details = buildDetails({ kind, outlet, guestsOrItems, contact, scheduledAt: scheduledAtInput });
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      business_id: account.business_id,
      conversation_id: conversation.id,
      igsid: conversation.igsid,
      instagram_account_id: conversation.instagram_account_id,
      kind,
      customer_name: customerName,
      details: details || "Logged manually — no further detail captured.",
      scheduled_at: scheduledAt,
      status: alreadyConfirmed ? "confirmed" : "pending",
      confirmed_at: alreadyConfirmed ? now : null,
      // Manual entries have no AI-emitted handoff line to hash — a random key
      // is fine here since duplicate-prevention only matters for the AI's own
      // retry-prone capture path.
      dedupe_key: `manual:${randomUUID()}`,
    })
    .select("id, kind, status")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data, { status: 201 });
}
