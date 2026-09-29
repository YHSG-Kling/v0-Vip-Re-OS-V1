import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
// Gated doors (session tenant) — the router module is server-only since 2026-09-03.
import { getActiveSessions, getAgentMetrics } from "@/app/actions/coordination"
import { CoordinationDashboardClient } from "./coordination-dashboard-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Agent Coordination | VIP RE OS",
  description: "Monitor and manage AI agent sessions",
}

export default async function CoordinationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    redirect("/login")
  }
  
  const { brokerageId, role } = await getAgentContext()
  
  // Tenant-admin surface. Lane 89D: this read `role !== 'broker' && role !==
  // 'admin'` — two spellings out of the six-role roster (CLAUDE.md §4), so a
  // broker_owner / broker_admin / compliance_officer who reached this page from
  // the broker, admin and superadmin sidebars (all three link it) was bounced
  // to /dashboard with no explanation. ONE roster predicate (isAdminOrBroker
  // reads TENANT_ADMIN_USER_TYPES), and the refusal says so in place.
  if (!isAdminOrBroker({ user_type: role })) {
    return (
      <RoleGateNotice
        surface="AI Coordination"
        audience="your broker, brokerage admins, team leads and compliance officer"
      />
    )
  }
  
  // Fetch initial data
  const [sessionsResult, metricsResult] = await Promise.all([
    getActiveSessions(),
    getAgentMetrics(7),
  ])
  
  // Get recent escalations
  const { data: recentEscalations } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('brokerage_id', brokerageId!)
    .eq('status', 'escalated')
    .order('ended_at', { ascending: false })
    .limit(10)
  
  // Get agent names for display
  const agentIds = [
    ...new Set(sessionsResult.sessions.map((s: any) => s.assigned_agent_id).filter(Boolean)),
    ...new Set((recentEscalations || []).map((e: any) => e.assigned_agent_id).filter(Boolean)),
  ]
  
  let agentNames: Record<string, string> = {}
  if (agentIds.length > 0) {
    const { data: agents } = await supabase
      .from('agents')
      .select('id, users(first_name, last_name)')
      .in('id', agentIds)

    agentNames = (agents || []).reduce((acc, a) => {
      acc[a.id] = [(a.users as any)?.first_name, (a.users as any)?.last_name].filter(Boolean).join(" ")
      return acc
    }, {} as Record<string, string>)
  }
  
  return (
    <CoordinationDashboardClient
      brokerageId={brokerageId ?? ""}
      initialSessions={sessionsResult.sessions}
      initialMetrics={metricsResult}
      recentEscalations={recentEscalations || []}
      agentNames={agentNames}
    />
  )
}
