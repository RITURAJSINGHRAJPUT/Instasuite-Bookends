-- Closed days — a day the outlet simply isn't open.
--
-- The existing closure tables (0007 dishes, 0013 outlets) are INSTANT windows: starts_at/ends_at
-- timestamptz, read as "is this shut right now". That answers the wrong question for a booking.
-- A guest asking on Sunday for a table on Tuesday needs "are you open on the DATE I named", and
-- no amount of start/end instants expresses "every Tuesday, forever".
--
-- So: a calendar day in IST, stored as a `date` rather than a timestamptz. A closed day has no
-- hours; turning it into an instant would only invite the timezone bugs the rest of the codebase
-- already works to avoid.
--
-- Two shapes, one table:
--   weekday = 2            -> closed EVERY Tuesday (a standing rule)
--   on_date = 2026-12-25   -> closed on that one date (a festival, a private event)
-- Exactly one is set per row; the CHECK below makes a half-filled row impossible rather than
-- leaving the reader of the code to guess which field wins.
--
-- `outlet` is free text matching the same column on unavailable_outlets, and NULL means every
-- outlet of the business — consistent with 0007's `outlet` semantics, and what Beshak wants
-- (one outlet today, but the rule is about the brand, not the address).

create table if not exists closed_days (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  outlet text,                                       -- NULL = every outlet of this business
  weekday smallint check (weekday between 0 and 6),  -- 0=Sunday … 2=Tuesday, in IST
  on_date date,                                      -- a single IST calendar date
  note text,
  created_at timestamptz not null default now(),
  constraint closed_days_one_kind check ((weekday is null) <> (on_date is null))
);

create index if not exists idx_closed_days_business on closed_days(business_id);

-- Same posture as every sibling table: RLS on, SELECT-only policy for the owning client or any
-- staff member. Writes go through the service-role API (supabaseAdmin), which bypasses RLS, so
-- there is deliberately no insert/delete policy.
alter table closed_days enable row level security;

drop policy if exists "own closed_days" on closed_days;
create policy "own closed_days" on closed_days for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = closed_days.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );

-- Beshak is closed every Tuesday. Seeded here rather than clicked in, mirroring how 0027 set
-- takeaway_enabled for the same brand. Resolved by name -> id so it stays re-runnable, and
-- guarded by NOT EXISTS so re-applying this migration can't stack duplicate rules.
insert into closed_days (business_id, outlet, weekday, note)
select b.id, null, 2, 'Weekly closure'
  from businesses b
 where b.name = 'Beshak'
   and not exists (
     select 1 from closed_days c
      where c.business_id = b.id and c.weekday = 2 and c.outlet is null
   );
