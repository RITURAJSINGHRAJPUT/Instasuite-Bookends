// Role-based access — the single source of truth for "who can see/use what".
//
// Pure, framework-agnostic module (no next/headers, no server-only imports) so it
// can be imported from BOTH the server (API gates, getContext, /api/me) and the
// client (Sidebar nav, page guards). The server gates are the real lock; the
// client uses this only to hide what a user can't reach.
//
// Mirrors the SQL side: profiles.role CHECK and public.is_staff() in
// supabase/migrations/0005_staff_roles.sql. Keep the role lists in sync.

export const FEATURES = [
  "overview",
  "inbox",
  "orders",
  "unavailable",
  "businesses",
  "scripts",
  "settings",
  "admin",
  "users",
] as const;
export type Feature = (typeof FEATURES)[number];

export type Role = "super_admin" | "admin" | "manager" | "agent" | "client";

// What each role can reach. super_admin has everything; admin has everything but
// Users (can't manage teammates); manager runs the day-to-day (no Settings/Admin);
// agent works the Inbox only; client is the legacy own-scoped tenant.
// `orders` tracks `overview`: it reads the same overview-gated analytics endpoint,
// so its viewers must be a subset of overview's or they'd 404 on their own page.
export const ROLE_CAPABILITIES: Record<Role, Feature[]> = {
  super_admin: ["overview", "inbox", "orders", "unavailable", "businesses", "scripts", "settings", "admin", "users"],
  admin: ["overview", "inbox", "orders", "unavailable", "businesses", "scripts", "settings", "admin"],
  manager: ["overview", "inbox", "orders", "unavailable", "businesses", "scripts"],
  agent: ["inbox"],
  client: ["overview", "inbox", "orders", "unavailable", "businesses", "scripts", "settings"],
};

// Staff = roles that operate the OPERATOR's data (everyone except the legacy
// `client` tenant). getContext gives staff the full account set; client stays
// scoped to its own. Must match public.is_staff() in the migration.
const STAFF_ROLES: Role[] = ["super_admin", "admin", "manager", "agent"];

export function isStaff(role: string | null | undefined): boolean {
  return !!role && (STAFF_ROLES as string[]).includes(role);
}

/** Capabilities for a role. Unknown/invalid roles get nothing (fail closed). */
export function capabilitiesFor(role: string | null | undefined): Feature[] {
  return ROLE_CAPABILITIES[role as Role] ?? [];
}

/** The one check every gate calls. Unknown role → false. */
export function can(role: string | null | undefined, feature: Feature): boolean {
  return capabilitiesFor(role).includes(feature);
}

// The nav destination for each feature. Also the reverse map used to guard a page
// by its URL (featureForPath).
export const FEATURE_ROUTE: Record<Feature, string> = {
  overview: "/dashboard",
  inbox: "/inbox",
  orders: "/orders",
  unavailable: "/unavailable",
  businesses: "/businesses",
  scripts: "/scripts",
  settings: "/settings",
  admin: "/admin",
  users: "/users",
};

// Order used to choose a landing page: the first capability a role has, top-down.
// An agent has no Overview, so it lands on Inbox rather than a page it'd be denied.
const LANDING_ORDER: Feature[] = [
  "overview",
  "inbox",
  "orders",
  "unavailable",
  "businesses",
  "scripts",
  "settings",
  "admin",
  "users",
];

export function firstAllowedRoute(role: string | null | undefined): string {
  const caps = capabilitiesFor(role);
  const first = LANDING_ORDER.find((f) => caps.includes(f));
  return first ? FEATURE_ROUTE[first] : "/login";
}

/**
 * Which feature guards a given app path (longest-prefix match). Used by the page
 * guard in the (app) layout. Returns null for paths that aren't feature pages
 * (those aren't blocked).
 */
export function featureForPath(pathname: string): Feature | null {
  let best: Feature | null = null;
  let bestLen = -1;
  for (const [feature, route] of Object.entries(FEATURE_ROUTE) as [Feature, string][]) {
    if ((pathname === route || pathname.startsWith(`${route}/`)) && route.length > bestLen) {
      best = feature;
      bestLen = route.length;
    }
  }
  return best;
}

// For the Users page role picker: the assignable roles with a one-line summary of
// what each unlocks. Ordered least → most privileged.
export const ROLE_OPTIONS: { role: Role; label: string; description: string }[] = [
  { role: "agent", label: "Agent", description: "Inbox only — read and reply to conversations." },
  { role: "manager", label: "Manager", description: "Inbox, Businesses, AI Scripts and Overview." },
  { role: "admin", label: "Admin", description: "Everything except managing users." },
  { role: "super_admin", label: "Super admin", description: "Full access, including user management." },
  { role: "client", label: "Client", description: "Legacy tenant — sees only their own data." },
];

// Roles that get a billing subscription. Staff help run the operator's account and
// aren't metered separately, so provisioning skips the subscription for them.
export function needsSubscription(role: string | null | undefined): boolean {
  return role === "client";
}
