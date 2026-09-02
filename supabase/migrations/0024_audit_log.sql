-- Activity log — who did what, and when.
--
-- Roles exist and several people share the dashboard, but nothing recorded WHICH of
-- them confirmed an order, edited a brand's AI script, deleted a conversation or
-- changed a teammate's role. Written by every mutating API route via logAudit()
-- (src/lib/audit.ts) and read only by the super-admin Activity page.
--
-- Scope: USER actions only. The webhook and the cron routes are system events with
-- no session behind them, and /api/leads is anonymous — none of them write here.

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Nulled (not cascaded) when a user is deleted: the row must outlive the actor.
  actor_id uuid references profiles(id) on delete set null,
  -- Snapshotted as text on purpose. A join alone would make a deleted user's whole
  -- trail unreadable, which is the opposite of what an audit log is for. The role is
  -- the role AT THE TIME, so someone demoted later doesn't retroactively look junior.
  actor_email text not null,
  actor_role text not null,
  action text not null,          -- '<resource>.<verb>', e.g. 'order.confirm', 'script.update'
  target_type text,              -- 'order' | 'script' | 'user' | 'conversation' | ...
  target_id text,
  target_label text,             -- human-readable, e.g. "Capiche DM script"
  created_at timestamptz not null default now()
);

-- The page's default view is "newest first"; the second index backs the per-user filter.
create index if not exists audit_log_created on audit_log(created_at desc);
create index if not exists audit_log_actor on audit_log(actor_id, created_at desc);

-- RLS on with NO policy — service-role only, same as orders / review_items / leads.
-- Rows name staff members and the things they touched; the anon key must never read them.
alter table audit_log enable row level security;
