-- Not every brand takes takeaway. Beshak is dine-in reservations only — its script says so
-- in Part 1 — but the canned welcome in src/lib/message-triage.ts is hardcoded for every
-- tenant and offered one anyway, on the very first greeting, one second in and without ever
-- consulting the script. The agent then had to contradict itself half a minute later.
--
-- A flag rather than a check on the name: Beshak may add takeaway later, and a new brand may
-- launch without it. Read in src/lib/tenant.ts (which renders it into the system prompt) and
-- enforced in the webhook, which refuses to capture a takeaway order for a business that
-- doesn't do them — the prompt states the rule, the code is what makes it true.

alter table businesses
  add column if not exists takeaway_enabled boolean not null default true;

-- `default true` leaves Capiche and Aiko exactly as they were; only Beshak opts out.
update businesses set takeaway_enabled = false where name = 'Beshak';
