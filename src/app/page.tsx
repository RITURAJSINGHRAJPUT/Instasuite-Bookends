import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/supabase-server";
import { firstAllowedRoute } from "@/lib/permissions";
import Landing from "./landing";

// Signed-in visitors land on the first section their role can use (an agent
// has no Overview, so it goes to /inbox rather than a denied page; unknown
// roles fall back to /login via firstAllowedRoute). Signed-out visitors get
// the public marketing page instead of being bounced to /login.
export default async function Home() {
  const user = await getSessionUser();
  if (user) redirect(firstAllowedRoute(user.role));
  return <Landing />;
}
