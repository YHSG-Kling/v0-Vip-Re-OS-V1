import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { DealHealthDashboardClient } from "./deal-health-dashboard-client"

export const metadata = {
  title: "Deal Health Dashboard | VIP Real Estate OS",
  description: "Monitor deal health across all active transactions",
}

/**
 * Deal Health Dashboard Page — Layer 6 Transaction Orchestration
 * 
 * Schema source of truth:
 *   - deal_health_scores: overall_score, risk_level, ai_narrative, scored_at, flags
 *   - deal_health_components: component_category, points_earned, points_possible, detail
 *   - transactions: property_address, stage, purchase_price, close_date, agent_id
 *   - agents: linked via transactions.agent_id
 *   - contacts: linked via transactions.contact_id
 *   - proactive_interventions: issue_detected, severity, ai_recommendation
 */
export default async function DealHealthDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Get user's record from users table (not profiles)
  // Schema: users.id, users.role, users.brokerage_id
  const { data: userRecord } = await supabase
    .from("users")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userRecord?.brokerage_id) redirect("/onboarding")

  // Gate to broker/admin/manager/tc roles
  const allowedRoles = ["broker", "admin", "manager", "tc"]
  if (!allowedRoles.includes(userRecord.role ?? "")) {
    redirect("/dashboard")
  }

  const brokerageId = userRecord.brokerage_id

  // Fetch all deal health scores with transaction info
  // Schema: deal_health_scores uses scored_at (not calculated_at)
  // Schema: transactions uses purchase_price and close_date
  // Schema: transactions.agent_id links to agents table, agents.user_id links to users
  const { data: healthScores } = await supabase
    .from("deal_health_scores")
    .select(`
      id,
      transaction_id,
      overall_score,
      risk_level,
      ai_narrative,
      scored_at,
      flags,
      score_delta,
      previous_score,
      transactions!inner (
        id,
        property_address,
        stage,
        status,
        purchase_price,
        close_date,
        contact_id,
        agent_id,
        contacts (first_name, last_name),
        agents!transactions_agent_id_fkey (
          id,
          user_id
        )
      )
    `)
    .eq("brokerage_id", brokerageId)
    .order("overall_score", { ascending: true })

  // Fetch agent user names separately for display
  const agentIds = healthScores
    ?.map(s => s.transactions?.agents?.user_id)
    .filter((id): id is string => !!id) ?? []
  
  const uniqueAgentIds = [...new Set(agentIds)]
  const { data: agentUsers } = uniqueAgentIds.length > 0 
    ? await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("id", uniqueAgentIds)
    : { data: [] }

  // Create a lookup map for agent names
  const agentNameMap = new Map(
    (agentUsers ?? []).map(u => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()])
  )

  // Fetch unresolved proactive interventions
  // Schema: proactive_interventions uses issue_detected, severity, ai_recommendation (not intervention_type, title, description)
  const { data: interventions } = await supabase
    .from("proactive_interventions")
    .select("id, issue_detected, severity, ai_recommendation, resolved, created_at, transaction_id")
    .eq("brokerage_id", brokerageId)
    .eq("resolved", false)
    .not("transaction_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(10)

  // Calculate summary stats
  const scores = healthScores ?? []
  const summary = {
    critical: scores.filter(s => s.risk_level === "critical").length,
    at_risk:  scores.filter(s => s.risk_level === "at_risk").length,
    watch:    scores.filter(s => s.risk_level === "watch").length,
    healthy:  scores.filter(s => s.risk_level === "healthy").length,
    total:    scores.length,
  }

  // Convert Map to plain object for serialization to client
  const agentNames: Record<string, string> = Object.fromEntries(agentNameMap)

  return (
    <main className="min-h-screen bg-background p-6">
      <DealHealthDashboardClient
        healthScores={healthScores ?? []}
        interventions={interventions ?? []}
        summary={summary}
        brokerageId={brokerageId}
        agentNames={agentNames}
      />
    </main>
  )
}
