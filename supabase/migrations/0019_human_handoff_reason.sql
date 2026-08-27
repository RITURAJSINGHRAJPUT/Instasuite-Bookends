-- Track WHY a conversation was handed to a human, so the Inbox can nudge staff
-- to use "Log order" specifically for the case that actually needs it.
--
-- Today mode flips to "human" for two different reasons (src/app/api/webhook/route.ts):
--   - the Claude call failed/came back empty ("outage") — nothing was captured, and if
--     staff then finish a reservation/order by typing directly in the chat, it never runs
--     detectHandoff/captureOrder, so it silently never appears in Orders.
--   - the AI flagged a REVIEW matter ("review") — already has its own row in review_items,
--     so no extra nudge is needed there.
-- Without recording which one happened, the Inbox can't tell "this human takeover might be
-- an unlogged order" apart from "this is a complaint being handled in Review".

alter table instagram_conversations
  add column if not exists human_handoff_reason text;
