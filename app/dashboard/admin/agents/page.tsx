import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { AgentOffboardingClient } from "./agent-offboarding-client"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "superadmin"])

/**
 * Agent off-boarding — the admin user-management surface for deactivating an agent without
 * orphaning their book. Loads the brokerage roster; the client drives the gated preview +
 * reassign/archive flow (app/actions/agent-deactivation).
 */
export default async function AgentOffboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id || !ADMIN_ROLES.has(u.user_type ?? "")) redirect("/dashboard")

  const svc = createServiceClient()
  const { data: agents } = await svc
    .from("agents")
    .select("id, is_active, users(first_name, last_name, email)")
    .eq("brokerage_id", u.brokerage_id)
    .limit(500)

  const roster = (agents ?? []).map((a) => {
    const ur = Array.isArray((a as { users?: unknown }).users)
      ? ((a as { users: Array<{ first_name?: string; last_name?: string; email?: string }> }).users[0] ?? null)
      : ((a as { users?: { first_name?: string; last_name?: string; email?: string } | null }).users ?? null)
    const name = [ur?.first_name, ur?.last_name].filter(Boolean).join(" ") || ur?.email || (a as { id: string }).id.slice(0, 8)
    return { id: (a as { id: string }).id, name, isActive: (a as { is_active: boolean | null }).is_active !== false }
  }).sort((x, y) => Number(y.isActive) - Number(x.isActive) || x.name.localeCompare(y.name))

  return <AgentOffboardingClient roster={roster} />
}
