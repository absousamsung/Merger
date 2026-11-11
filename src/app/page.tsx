// page.tsx — admin gate: unauthenticated visitors see the login form,
// authenticated ones get the dashboard (spec 9: dashboard page is protected).
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifySession, passwordConfigured } from "@/lib/auth";
import LoginGate from "@/components/dashboard/LoginGate";
import Dashboard from "@/components/dashboard/Dashboard";

export const dynamic = "force-dynamic";

export default async function Page() {
  const cookieStore = await cookies();
  const authed = verifySession(cookieStore.get(ADMIN_COOKIE)?.value);
  if (!authed || !passwordConfigured()) {
    return <LoginGate passwordConfigured={passwordConfigured()} />;
  }
  return <Dashboard />;
}
