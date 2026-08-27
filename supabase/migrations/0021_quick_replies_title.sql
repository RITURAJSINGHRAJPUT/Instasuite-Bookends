-- A short internal label per quick reply, shown in the management page and the
-- Inbox popover so staff can scan the list without reading full message text.
-- Purely a UI label — never sent to the guest, only `message` is.

alter table quick_replies add column if not exists title text not null default '';
