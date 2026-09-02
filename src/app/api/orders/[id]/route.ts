import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getContext } from "@/lib/ownership";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { resolveAccountByIgId } from "@/lib/tenant";
import { sendAndStore } from "@/lib/outbound";

// Edit a captured order's details. Exists because a booking often changes on a phone
// call ("as discussed over the call...") — before this, staff could only Confirm the
// stale row as-is or Cancel it, so the guest was told one thing while Orders showed
// another. Updates the record only; the guest is messaged ONLY when notify is true.

function updateText(kind: string, details: string): string {
  const parts = details?.trim()
    ? details.trim().split(" · ").map((s) => `· ${s.trim()}`).join("\n")
    : "";
  const block = parts ? `\n\n${parts}\n\n` : " ";
  return kind === "reservation"
    ? `Your reservation has been updated.${block}Please let us know if anything doesn't look right.`
    : `Your order has been updated.${block}Please let us know if anything doesn't look right.`;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(ctx.user.role, "orders")) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const notify = body?.notify === true;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, kind, details, status, igsid, instagram_account_id, conversation_id")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      kind: string;
      details: string;
      status: string;
      igsid: string | null;
      instagram_account_id: string | null;
      conversation_id: string | null;
    }>();
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });

  // Same ownership rule as confirm/cancel: the order's own account must be one the
  // caller can act on (works even if the chat was deleted).
  if (!order.instagram_account_id || !ctx.accountIds.includes(order.instagram_account_id)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (order.status === "cancelled") {
    return Response.json({ error: "This order is cancelled and can't be edited." }, { status: 409 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof body?.customer_name === "string" && body.customer_name.trim()) {
    updates.customer_name = body.customer_name.trim();
  }
  if (typeof body?.details === "string") updates.details = body.details.trim();
  if (typeof body?.kind === "string" && ["reservation", "takeaway"].includes(body.kind)) {
    updates.kind = body.kind;
  }
  if (body?.scheduled_at === null) {
    updates.scheduled_at = null;
  } else if (typeof body?.scheduled_at === "string" && body.scheduled_at) {
    const d = new Date(body.scheduled_at);
    if (isNaN(d.getTime())) return Response.json({ error: "Invalid date/time" }, { status: 400 });
    updates.scheduled_at = d.toISOString();
  }
  if (!Object.keys(updates).length) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: updated, error } = await supabaseAdmin
    .from("orders")
    .update(updates)
    .eq("id", id)
    .select("id, kind, customer_name, details, status, scheduled_at")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!updated) return Response.json({ error: "Not found" }, { status: 404 });

  // Logged here, not after the notify block below: the edit is already committed at
  // this point and three of the paths below return early, so logging later would
  // silently miss real edits.
  await logAudit(ctx.user, {
    action: "order.update",
    targetType: "order",
    targetId: id,
    targetLabel: updated.kind ?? order.kind,
  });

  if (!notify) return Response.json({ ...updated, notified: false });

  if (!order.igsid) {
    return Response.json({ ...updated, notified: false, notifyError: "No saved recipient to message." });
  }

  const { data: acc } = await supabaseAdmin
    .from("instagram_accounts")
    .select("ig_account_id")
    .eq("id", order.instagram_account_id)
    .maybeSingle<{ ig_account_id: string }>();
  const resolved = acc && (await resolveAccountByIgId(acc.ig_account_id));
  if (!resolved) {
    return Response.json({ ...updated, notified: false, notifyError: "Instagram account unavailable." });
  }

  const message = updateText(updated.kind, updated.details);
  const sent = await sendAndStore({
    conversationId: order.conversation_id,
    igsid: order.igsid,
    text: message,
    accessToken: resolved.accessToken,
  });

  // The order edit itself stands either way — only the guest notification failed.
  if (!sent.ok) {
    return Response.json({
      ...updated,
      notified: false,
      notifyError: sent.error?.message || "Instagram rejected the message.",
    });
  }

  return Response.json({ ...updated, notified: true });
}
