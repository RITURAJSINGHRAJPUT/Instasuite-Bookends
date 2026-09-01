-- The hottest read in the app had no usable index.
--
-- Every AI turn loads a conversation's recent messages (webhook route), the Inbox
-- loads a thread, and /api/conversations now bulk-loads last messages — all of them
-- filter on conversation_id and order by created_at.
--
-- The only existing index on instagram_messages is the PARTIAL unique index from
-- 0002 (conversation_id, instagram_msg_id) WHERE instagram_msg_id IS NOT NULL.
-- Postgres cannot use it for these queries: rows with a NULL mid are excluded from
-- it, so the planner falls back to a sequential scan of the whole table. Harmless at
-- today's row count, linear in cost as history accumulates.

create index if not exists idx_messages_convo_created
  on instagram_messages(conversation_id, created_at desc);
