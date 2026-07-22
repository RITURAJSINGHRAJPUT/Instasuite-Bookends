-- WhatsApp order/reservation confirmations — a durable outbox.
--
-- The web app (webhook) detects a captured takeaway order or a shared TableCheck
-- reservation link and inserts ONE row here. A self-hosted whatsapp-web.js worker
-- (running on a machine the operator controls — NOT on Render, since Chrome can't
-- run there without Docker) polls this table over the service-role key and sends
-- each confirmation to the reservation-team WhatsApp group + staff numbers.
--
-- Decoupled on purpose: the worker only makes OUTBOUND connections (Supabase +
-- WhatsApp), so it needs no public URL and works behind NAT. If the worker is down,
-- rows queue and flush when it returns — a WhatsApp failure can never affect an
-- Instagram reply.

create table if not exists whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  kind text not null check (kind in ('takeaway', 'reservation')),
  -- Anti-spam key. Insert-first, treat a 23505 unique violation as "already queued,
  -- skip" — the same idempotency pattern the webhook uses for duplicate inbound
  -- messages. Shape: `${kind}:${conversationId}:${sha1(body)}` so a verbatim
  -- re-emission collapses to one notification, but an EDITED order re-notifies.
  dedupe_key text not null,
  account_username text,
  customer_name text,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index if not exists whatsapp_outbox_dedupe_key
  on whatsapp_outbox(dedupe_key);

-- The poller's query: oldest pending first.
create index if not exists whatsapp_outbox_status_created
  on whatsapp_outbox(status, created_at);

-- RLS on, with NO policy at all: this is an internal queue touched only by the
-- service-role client (webhook insert, worker read/update), which bypasses RLS.
-- Same reasoning as `leads` in 0004 — it keeps the anon key from ever reading or
-- writing it. Do NOT add a select policy: rows can contain a customer's name and
-- contact details from the order handoff line.
alter table whatsapp_outbox enable row level security;
