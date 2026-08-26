-- Real-time updates for Orders and Review.
--
-- orders/review_items have RLS enabled with NO policy — only the service-role
-- client (the gated /api/orders, /api/review routes) has ever touched them.
-- Supabase Realtime authenticates as the logged-in user, not service-role, and
-- enforces RLS per event — so enabling the publication alone would deliver
-- zero events without a matching SELECT policy. Mirrors the exact pattern
-- 0005_staff_roles.sql already uses for instagram_conversations/messages
-- (staff see everything via public.is_staff(), a client tenant sees only its
-- own business's rows) — both tables already have a direct business_id column,
-- so no extra joins are needed here.

drop policy if exists "own orders" on orders;
create policy "own orders" on orders for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = orders.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );

drop policy if exists "own review items" on review_items;
create policy "own review items" on review_items for select to authenticated
  using (
    exists (select 1 from businesses b
             where b.id = review_items.business_id
               and (b.client_id = auth.uid() or public.is_staff()))
  );

alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table review_items;
