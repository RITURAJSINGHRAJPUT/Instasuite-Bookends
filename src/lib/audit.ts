import { supabaseAdmin } from "@/lib/supabase";
import type { SessionUser } from "@/lib/supabase-server";

// Activity log writer — one call per successful mutation, from every write route.
//
// Read back by the super-admin Activity page (/activity, the `audit` capability).
// Server-only: it uses the service-role client, and audit_log is RLS-on with no
// policy so nothing else can reach it.

export type AuditEntry = {
  /** '<resource>.<verb>' — e.g. "order.confirm". The page filters on the prefix. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Human-readable name for the thing acted on. Falls back to the id when absent. */
  targetLabel?: string | null;
};

/**
 * Record that `user` performed `entry.action`.
 *
 * Call it AFTER the write succeeds — a row claiming an action that then failed is
 * worse than no row at all.
 *
 * Never throws and never rejects. An audit log that can take down the action it is
 * logging is a liability, so a failure here degrades to a console warning and the
 * user's request carries on. Same discipline as captureOrder/captureReview in the
 * webhook, which swallow their own insert errors for exactly this reason.
 *
 * The actor's email and role are written as text rather than left to a join: the
 * FK is `on delete set null`, so this snapshot is what keeps a departed user's
 * trail readable, and the role is the one they held AT THE TIME.
 */
export async function logAudit(user: SessionUser, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("audit_log").insert({
      actor_id: user.id,
      actor_email: user.email ?? "unknown",
      actor_role: user.role,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      target_label: entry.targetLabel ?? null,
    });
    if (error) console.warn(`audit_log insert failed (${entry.action}):`, error.message);
  } catch (err) {
    console.warn(`logAudit threw (${entry.action}):`, (err as Error).message);
  }
}
