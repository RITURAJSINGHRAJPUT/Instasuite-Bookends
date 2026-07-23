-- "Unavailable" dishes — staff mark a dish 86'd at an outlet, for today or a custom
-- window. The AI agent reads the active rows (src/lib/availability.ts injects them into
-- the tenant's system prompt) and stops offering those dishes until the window ends.
--
-- Outlets and dishes are free text (they exist only as prose inside scripts.content),
-- so `dish` and `outlet` are plain text; `outlet` NULL means "all outlets". A row is
-- ACTIVE while: starts_at <= now() AND (ends_at IS NULL OR ends_at > now()).

create table if not exists unavailable_dishes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  dish text not null,
  outlet text,                 -- NULL = all outlets
  note text,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,         -- NULL = until further notice (cleared manually)
  created_at timestamptz not null default now()
);

create index if not exists idx_unavailable_business_ends
  on unavailable_dishes(business_id, ends_at);

alter table unavailable_dishes enable row level security;

-- Readable by the owning client or any staff, via the businesses ownership chain —
-- mirrors the "own scripts" policy in 0005. Writes go through the service-role API
-- (supabaseAdmin), which bypasses RLS, so there is deliberately no insert/delete policy.
drop policy if exists "own unavailable_dishes" on unavailable_dishes;
create policy "own unavailable_dishes" on unavailable_dishes for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = unavailable_dishes.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );
