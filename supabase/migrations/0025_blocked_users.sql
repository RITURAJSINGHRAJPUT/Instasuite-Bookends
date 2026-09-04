-- A global do-not-reply list. Add an Instagram handle here and NO connected account
-- ever auto-replies to that person again — Aiko, Capiche, and anything connected later.
--
-- Deliberately NOT business-scoped, unlike every other list table here
-- (quick_replies 0020, unavailable_dishes 0007, outlets 0014). The point of the
-- feature is "this person is blocked everywhere", so a business_id would mean adding
-- the same spammer once per brand and forgetting one.
--
-- What a block does and does not do (src/lib/blocklist.ts + the two guards in
-- src/app/api/webhook/route.ts): the guest's message is still stored and still shows
-- in the Inbox — only the AUTOMATED reply is suppressed, and the AI is never called,
-- so a blocked handle costs nothing. Staff can still reply by hand from the Inbox.

create table if not exists blocked_users (
  id uuid primary key default gen_random_uuid(),
  -- Normalized on write by normalizeHandle(): trimmed, leading '@' stripped, lowercased.
  -- Instagram handles are case-insensitive, so storing raw casing would let "@SpamGuy"
  -- and "spamguy" both exist as separate rows while only one of them ever matches.
  username text not null unique,
  reason text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table blocked_users enable row level security;

-- Global list with no ownership chain to walk, and every signed-in role may use it
-- (see ROLE_CAPABILITIES in src/lib/permissions.ts), so SELECT is open to any
-- authenticated user. Writes still go through the service-role API routes, which
-- bypass RLS — hence deliberately no insert/delete policy, same as unavailable_dishes.
drop policy if exists "read blocked_users" on blocked_users;
create policy "read blocked_users" on blocked_users for select to authenticated
  using (true);

create index if not exists idx_blocked_users_created on blocked_users(created_at desc);
