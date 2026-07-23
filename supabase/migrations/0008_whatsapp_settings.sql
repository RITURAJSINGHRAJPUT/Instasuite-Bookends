-- Per-business WhatsApp destinations for the reservation-team notifications.
--
-- Previously the reservation-team group id + staff numbers lived only in the
-- self-hosted worker's .env. This moves them into the DB so they can be managed from
-- the dashboard (/whatsapp). The worker reads this table per outbox row's business_id
-- and falls back to its env (WA_GROUP_ID / WA_STAFF_NUMBERS) when a business has no row,
-- so existing setups keep working.

create table if not exists whatsapp_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  group_id text,                                -- reservation-team group (…@g.us); null = none
  staff_numbers text[] not null default '{}',   -- E.164 without the leading + (e.g. 919876543210)
  updated_at timestamptz not null default now()
);

alter table whatsapp_settings enable row level security;

-- Readable by the owning client or any staff, via the businesses ownership chain —
-- mirrors the "own scripts" / "own unavailable_dishes" policy. Writes go through the
-- service-role API (supabaseAdmin) and the worker reads via service role, both of which
-- bypass RLS; this policy is defense-in-depth for the anon key.
drop policy if exists "own whatsapp_settings" on whatsapp_settings;
create policy "own whatsapp_settings" on whatsapp_settings for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = whatsapp_settings.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );
