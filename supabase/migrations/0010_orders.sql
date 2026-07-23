-- Orders & reservations as a real, confirmable ledger.
--
-- Reservations are now taken IN Instagram (no TableCheck). When the AI finalizes a
-- reservation or takeaway it appends a structured handoff line; the webhook parses that
-- line and inserts ONE row here (status 'pending'). Staff confirm from the Orders page,
-- which flips the row to 'confirmed' and DMs the customer a confirmation — hence the FK to
-- the conversation (it carries the igsid + account needed to send the reply).

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  -- The conversation this order came from: gives the customer's igsid + the account token
  -- used to send the confirmation DM.
  conversation_id uuid not null references instagram_conversations(id) on delete cascade,
  kind text not null check (kind in ('reservation', 'takeaway')),
  customer_name text,
  details text not null,               -- parsed, human-readable summary of the handoff line
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled')),
  -- Anti-dup: insert-first, treat a 23505 as "already captured, skip" (same pattern the
  -- webhook uses for duplicate inbound messages). Shape: `${kind}:${conversationId}:${sha1(line)}`.
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create unique index if not exists orders_dedupe_key on orders(dedupe_key);
create index if not exists orders_business_created on orders(business_id, created_at desc);

-- RLS on, with NO policy: touched only by the service-role client (webhook insert, the
-- gated /api/orders route reads/updates). Rows carry a customer's name/details, so the
-- anon key must never read them. Same reasoning as `leads` / `whatsapp_outbox`.
alter table orders enable row level security;
