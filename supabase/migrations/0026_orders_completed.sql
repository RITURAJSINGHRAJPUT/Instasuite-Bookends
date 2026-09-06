-- A terminal "it actually happened" state, distinct from 'confirmed'.
--
-- 'confirmed' answers "did we TELL the guest yes?" — it's set by the Confirm button, which
-- DMs them. It says nothing about whether they turned up. So a table served last Tuesday and
-- a table booked for tonight both sat on the board looking identical, and staff had no way to
-- clear the finished one off it.
--
-- 'completed' answers "is this DONE?" — set by hand from Orders, and deliberately sends NO
-- message: the guest is standing in front of you at that point, a DM is noise. Terminal, like
-- 'cancelled', but the good ending.
--
--   pending ──confirm (DMs guest)──> confirmed ──mark done (silent)──> completed
--      └──────────────── cancel (DMs guest) ────────────────> cancelled
--
-- Marking done straight from 'pending' is allowed on purpose: a walk-in the AI captured but
-- nobody clicked Confirm on still happened, and DMing "✅ confirmed!" after the fact to get it
-- off the board would be worse than useless.

-- Column-level check from 0010, so Postgres named it <table>_<column>_check.
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('pending', 'confirmed', 'cancelled', 'completed'));

-- Separate from confirmed_at, which must keep meaning "when the guest was told" — the two
-- diverge by hours or days, and the feedback cron keys off scheduled_at, not either of these.
alter table orders add column if not exists completed_at timestamptz;
