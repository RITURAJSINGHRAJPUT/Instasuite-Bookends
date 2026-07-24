-- Per-OUTLET WhatsApp destinations.
--
-- One Instagram account / one business serves several physical outlets (Piplod, Vesu,
-- Ambli, Uni …); the guest picks the outlet in-chat and the AI stamps it into the order
-- (the `TAKEAWAY [Outlet]–[City] / …` handoff line — see src/lib/script.ts). Because every
-- outlet shares one business_id, the business-level `whatsapp_settings` (0008) can't send
-- each outlet's confirmation to a different WhatsApp group.
--
-- This adds outlet-level routes. The webhook stamps a normalized `outlet` key onto each
-- outbox row; the worker prefers the matching outlet route and falls back to the
-- business-level `whatsapp_settings`, then its env — so an outlet with no route configured
-- keeps delivering exactly as before (nothing is ever dropped).

-- The order's outlet (normalized, e.g. 'vesu'); null when it couldn't be determined.
alter table whatsapp_outbox add column if not exists outlet text;

create table if not exists whatsapp_outlet_routes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  outlet text not null,                          -- normalized routing key, e.g. 'vesu'
  label text,                                    -- display name, e.g. 'Vesu, Surat'
  group_id text,                                 -- reservation-team group (…@g.us); null = none
  staff_numbers text[] not null default '{}',    -- E.164 without the leading + (e.g. 919876543210)
  updated_at timestamptz not null default now(),
  unique (business_id, outlet)
);

create index if not exists whatsapp_outlet_routes_business
  on whatsapp_outlet_routes(business_id);

-- Readable by the owning client or any staff via the businesses ownership chain — mirrors
-- the "own whatsapp_settings" policy in 0008. Writes go through the service-role API and the
-- worker reads via service role, both of which bypass RLS; this is defense-in-depth for the
-- anon key.
alter table whatsapp_outlet_routes enable row level security;

drop policy if exists "own whatsapp_outlet_routes" on whatsapp_outlet_routes;
create policy "own whatsapp_outlet_routes" on whatsapp_outlet_routes for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = whatsapp_outlet_routes.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );
