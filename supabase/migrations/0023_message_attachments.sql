-- Story replies, story mentions, and shared posts/reels.
--
-- Until now the webhook dropped any message without text before storing anything
-- (`if (!messaging?.message?.text) continue;`), so a guest who shared a post with
-- no caption was never stored, never shown to staff, and never replied to. And a
-- story reply lost the one piece of context that makes it make sense — the story
-- it was about.
--
-- JSONB rather than fixed columns: Instagram puts this data in two different
-- places (message.reply_to.story vs message.attachments[]) and the payload shape
-- varies by media type. A normalised array keeps unexpected shapes instead of
-- discarding them (see src/lib/attachments.ts).
--
-- Note: only Meta's CDN URL is stored, not the media itself. Those are short-lived
-- signed links, so thumbnails in older chats WILL expire — the Inbox renders a
-- placeholder for that case by design.

alter table instagram_messages add column if not exists attachments jsonb;
