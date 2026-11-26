import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AIQualityDashboardClient } from "./ai-quality-dashboard-client"
import { createServiceClient } from "@/lib/supabase/service"
import { getWeeklyMetrics } from "@/lib/intelligence/feedback-aggregator"
import { getCalibrationLog } from "@/lib/intelligence/prompt-calibrator"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Quality & Learning | Dashboard",
  description: "Monitor AI performance and quality metrics",
}

export default async function AIQualityPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Check user type - only admin/broker/superadmin can access
  const { data: userData } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!userData || !isAdminOrBroker({ user_type: userData.user_type })) {
    return <RoleGateNotice surface="AI quality" audience="your broker, brokerage admins, team leads and the compliance officer" />
  }

  // Get agent context for brokerage. Lane 90A (89D P1-4, owner ruling): a
  // tenant-admin seat has already passed the roster gate above but may hold
  // NO agents row (live 2026-09-29: admin 2, compliance_officer 1, team_lead 1,
  // tc 1 seats without one) — this page is brokerage-scoped, so the seat's
  // own users.brokerage_id is the scope, not a reason to bounce. Admin seats
  // are NOT provisioned agents rows for this (ruling).
  const { data: agent } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const brokerageId = agent?.brokerage_id ?? userData.brokerage_id ?? null
  if (!brokerageId) {
    redirect("/dashboard/onboarding")
  }

  const serviceSupabase = createServiceClient()

  // Calculate this week's Monday
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisWeekStart = new Date(now)
  thisWeekStart.setDate(now.getDate() - daysToSubtract)
  thisWeekStart.setHours(0, 0, 0, 0)

  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  // Fetch data in parallel
  const [thisWeekMetrics, lastWeekMetrics, calibrationLog, agentStats] = await Promise.all([
    getWeeklyMetrics(brokerageId, thisWeekStart),
    getWeeklyMetrics(brokerageId, lastWeekStart),
    getCalibrationLog(brokerageId, 20),
    // Agent personalization - agents with > 10 feedbacks in last 30 days
    (async () => {
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      const { data } = await serviceSupabase.rpc("get_agent_feedback_stats", {
        p_brokerage_id: brokerageId,
        p_since: thirtyDaysAgo.toISOString(),
      })

      // If RPC doesn't exist, fall back to raw query
      if (!data) {
        const { data: feedbackData } = await serviceSupabase
          .from("ai_feedback_log")
          .select("agent_id, rating")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", thirtyDaysAgo.toISOString())

        if (!feedbackData) return []

        // Group by agent and calculate stats
        const agentMap = new Map<string, { total: number; positive: number }>()
        for (const f of feedbackData) {
          const existing = agentMap.get(f.agent_id) || { total: 0, positive: 0 }
          existing.total++
          if (f.rating === 1) existing.positive++
          agentMap.set(f.agent_id, existing)
        }

        // Filter agents with > 10 feedbacks and get their names
        const qualifiedAgents = Array.from(agentMap.entries())
          .filter(([_, stats]) => stats.total > 10)
          .map(([agentId, stats]) => ({
            agent_id: agentId,
            total: stats.total,
            positive: stats.positive,
            approval_rate: Math.round((stats.positive / stats.total) * 100),
          }))

        // Get agent names
        if (qualifiedAgents.length > 0) {
          const { data: agents } = await serviceSupabase
            .from("agents")
            .select("id, users(first_name, last_name)")
            .in(
              "id",
              qualifiedAgents.map((a) => a.agent_id)
            )

          const agentNameMap = new Map(
            agents?.map((a) => [
              a.id,
              [(a.users as any)?.first_name, (a.users as any)?.last_name].filter(Boolean).join(" "),
            ]) || []
          )

          return qualifiedAgents.map((a) => ({
            ...a,
            agent_name: agentNameMap.get(a.agent_id) || "Unknown",
          }))
        }

        return []
      }

      return data
    })(),
  ])

  return (
    <AIQualityDashboardClient
      thisWeekMetrics={thisWeekMetrics}
      lastWeekMetrics={lastWeekMetrics}
      calibrationLog={calibrationLog}
      agentStats={agentStats}
      thisWeekStart={thisWeekStart.toISOString()}
      lastWeekStart={lastWeekStart.toISOString()}
    />
  )
}
