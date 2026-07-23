-- WhatsApp worker connection status + QR, surfaced on the dashboard's WhatsApp page.
--
-- There is ONE global whatsapp-web.js session (one worker/SIM serves every business), so
-- this is a singleton row (id = 'default'). The self-hosted worker writes its state here
-- on each whatsapp-web.js event plus a ~15s heartbeat; the dashboard reads it (through the
-- gated /api/whatsapp service-role route) to show "scan this QR" / "connected" / offline.

create table if not exists whatsapp_session (
  id text primary key,                         -- singleton: 'default'
  status text not null default 'initializing', -- initializing|qr|authenticated|connected|disconnected|auth_failure
  qr text,                                      -- PNG data URL while status='qr', else null
  phone text,                                   -- linked number once connected
  updated_at timestamptz not null default now()
);

-- RLS on, with NO policy: the QR is effectively a login credential, so this row is
-- service-role only (the worker writes it, the dashboard reads it via the /api/whatsapp
-- route, which is already gated by can(role,"whatsapp")). Never add a select policy —
-- the anon key must never be able to read the QR.
alter table whatsapp_session enable row level security;
