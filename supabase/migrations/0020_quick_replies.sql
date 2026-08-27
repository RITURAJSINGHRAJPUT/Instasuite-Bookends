-- Pre-written messages staff can tap to send instantly from the Inbox composer,
-- scoped per business (Aiko vs Capiche each keep their own list). Mirrors
-- unavailable_dishes (0007_unavailable_dishes.sql) exactly: a business-scoped
-- list of independent rows, RLS read-only (all writes go through the service-role
-- client in the /api/quick-replies routes).

create table if not exists quick_replies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

alter table quick_replies enable row level security;

create policy "own quick_replies" on quick_replies for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = quick_replies.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );

create index if not exists idx_quick_replies_business on quick_replies(business_id);
