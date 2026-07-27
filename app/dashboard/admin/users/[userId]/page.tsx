import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { UserEditForm } from "./user-edit-form"
import { Agent360Panels } from "./agent-360-panels"
import { getAgentProfileForUserAction, type AgentProfile, type OfficeOption } from "@/app/actions/admin/agent-profile"
import { getAgent360Action, type Agent360 } from "@/app/actions/admin/agent-360"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ userId: string }>
}

export default async function UserEditPage({ params }: Props) {
  const { userId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: caller } = await supabase
    .from("users")
    .select("role, user_type, brokerage_id")
    .eq("id", user.id)
    .single()

  const callerRole = caller?.user_type ?? caller?.role ?? ""
  // Same triad as the list page + updateUser action: admin, broker, superadmin.
  if (!["admin", "broker", "superadmin"].includes(callerRole)) redirect("/dashboard")

  // Load target user
  const { data: target } = await supabase
    .from("users")
    .select("id, first_name, last_name, phone, email, user_type, role, status, brokerage_id, created_at")
    .eq("id", userId)
    .single()

  if (!target) notFound()

  // Non-superadmin callers scoped to own brokerage — an unanchored tenant
  // admin gets no cross-tenant reach.
  if (callerRole !== "superadmin" && (!caller?.brokerage_id || target.brokerage_id !== caller.brokerage_id)) {
    redirect("/dashboard/admin/users")
  }

  // Load brokerages for superadmin dropdown
  let brokerages: { id: string; name: string }[] = []
  if (callerRole === "superadmin") {
    const { data } = await supabase
      .from("brokerages")
      .select("id, name")
      .order("name", { ascending: true })
    brokerages = data ?? []
  }

  // People-ops consolidation: the agent's real-estate profile (license / office /
  // commission) + the brokerage's office list, loaded through the admin-gated
  // action so the same authz applies. `agent` is null for non-agent users.
  let agentProfile: AgentProfile | null = null
  let offices: OfficeOption[] = []
  const profileRes = await getAgentProfileForUserAction(userId)
  if (profileRes.ok) {
    agentProfile = profileRes.agent
    offices = profileRes.offices
  }

  // Agent 360 — the manager's full read of this agent (production, goals,
  // payments, gamification). null for non-agent users; the page stays an
  // edit form for them.
  let agent360: Agent360 | null = null
  if (agentProfile) {
    const r360 = await getAgent360Action(userId)
    if (r360.ok) agent360 = r360.data
  }

  return (
    <div className={`p-6 mx-auto space-y-6 ${agent360 ? "max-w-6xl" : "max-w-2xl"}`}>
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/admin/users"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Users
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{agent360 ? "Agent Profile" : "Edit User"}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {target.email}
        </p>
      </div>

      <div className={agent360 ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" : ""}>
        <UserEditForm
          user={target}
          callerRole={callerRole}
          callerBrokerageId={caller?.brokerage_id ?? null}
          brokerages={brokerages}
          agentProfile={agentProfile}
          offices={offices}
        />
        {agent360 && <Agent360Panels data={agent360} targetUserId={userId} />}
      </div>
    </div>
  )
}
