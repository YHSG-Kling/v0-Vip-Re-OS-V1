import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { TeamMembersClient } from "./members-client"

export const dynamic = "force-dynamic"

const MANAGER_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead", "team_manager"])

/**
 * Team Members & Splits — the management surface for the team_members write path. A broker/admin/
 * team-lead assigns agents to a team with a split % and source-of-funds; the Finance Manager's
 * commission waterfall then splits by it. Loads teams + brokerage agents server-side; the client
 * manages membership via the gated actions.
 */
export default async function TeamMembersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id || !MANAGER_ROLES.has(u.user_type ?? "")) redirect("/dashboard/team")

  const svc = createServiceClient()
  const [{ data: teams }, { data: agents }] = await Promise.all([
    svc.from("teams").select("id, name, team_split_percent").eq("brokerage_id", u.brokerage_id).is("deleted_at", null).order("name"),
    svc.from("agents").select("id, users(first_name, last_name)").eq("brokerage_id", u.brokerage_id).limit(500),
  ])
  const agentOptions = (agents ?? []).map((a) => {
    const u = Array.isArray((a as { users?: unknown }).users)
      ? ((a as { users: Array<{ first_name?: string; last_name?: string }> }).users[0] ?? null)
      : ((a as { users?: { first_name?: string; last_name?: string } | null }).users ?? null)
    return { id: (a as { id: string }).id, name: [u?.first_name, u?.last_name].filter(Boolean).join(" ") || (a as { id: string }).id.slice(0, 8) }
  })

  return <TeamMembersClient teams={(teams ?? []).map((t) => ({ id: t.id, name: t.name }))} agents={agentOptions} />
}
