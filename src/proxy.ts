import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 renamed `middleware` to `proxy`. This gates the dashboard behind a
// real Supabase Auth session (previously: one shared password with no identity).
// Public routes (login, the Instagram webhook, the legal pages Meta needs) are
// excluded via the matcher below.
export async function proxy(request: NextRequest) {
  // The response is created up-front so Supabase can write refreshed auth cookies
  // onto it — a refreshed token is lost otherwise.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getUser() revalidates against Supabase — don't trust getSession() in the proxy.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) return response;

  // Not authenticated. API calls get a clean 401; page loads redirect to login.
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("from", pathname + search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on everything EXCEPT: the login page, the auth callback/reset pages, the
  // Instagram webhook (Meta must reach it unauthenticated), the public legal
  // pages, and Next's static assets.
  //
  // auth/reset MUST be excluded: someone resetting a password is not yet
  // authenticated, so gating it would redirect them to /login and make the flow
  // impossible to complete.
  //
  // api/cron MUST be excluded too: an external scheduler authenticates with a
  // Bearer CRON_SECRET, not a session cookie. Left in, the proxy 401s the
  // scheduler before the route's own guard runs — the job would never execute.
  // (Those routes fail closed on their own secret.)
  //
  // The trailing `.+` (not `.*`) is what makes the bare "/" public: for "/" the
  // text after the slash is empty, so `.*` would match and gate the landing
  // page. `.+` requires at least one character, so "/" falls through while
  // "/inbox", "/dashboard", "/settings", "/admin" still match.
  // api/leads IS excluded: it's the public request-access endpoint behind the
  // landing page's form and must be reachable by anonymous visitors. It has its
  // own rate limiting + honeypot (see src/app/api/leads/route.ts) since there's
  // no session to gate it.
  //
  // The `.*\.(png|...)` clause excludes static image assets in public/ (the logo,
  // the favicon). Without it the proxy redirects them to /login: the logo request
  // gets HTML back and renders broken, AND next/image's server-side fetch of the
  // source 400s. It also broke the logo on the login page itself, since a
  // logged-out visitor's image request was redirected too. Images in public/ are
  // inherently public, so gating them was never intended.
  matcher: [
    "/((?!api/webhook|api/cron|api/leads|auth/callback|auth/reset|login|privacy|terms|data-deletion|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif)).+)",
  ],
};
