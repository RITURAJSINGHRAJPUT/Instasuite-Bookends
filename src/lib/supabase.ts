import { createClient, SupabaseClient } from "@supabase/supabase-js";

// SERVICE-ROLE CLIENT — bypasses RLS entirely.
//
// Only safe where there is no user context and ownership is established by
// construction: the webhook (which resolves the tenant from entry[0].id) and
// admin tasks. Anywhere a logged-in user drives the query, use the per-request
// user-scoped client instead (see supabase-server.ts) so RLS is load-bearing,
// AND still pass an explicit ownership predicate.

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _admin;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    // Indexing the client by an arbitrary prop key needs a widened view of it; Record<>
    // keeps that local instead of casting the whole client to `any`.
    return (getSupabaseAdmin() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/** @deprecated Use `supabaseAdmin` (explicit) or the user-scoped server client. */
export const supabase = supabaseAdmin;
