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
  const { data: userRecord } = await supabase
    .from("users")
    .select("id, user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userRecord?.brokerage_id) redirect("/dashboard/onboarding")

  // Gate to broker/admin/manager/tc roles (or platform superadmin)
  const allowedRoles = ["broker", "broker_owner", "admin", "manager", "tc", "superadmin"]
  if (!allowedRoles.includes(userRecord.user_type ?? "") && userRecord.platform_role !== "superadmin") {
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
      previous_score
    `)
    .eq("brokerage_id", brokerageId)
    .order("overall_score", { ascending: true })

  // Fetch transactions separately to avoid ambiguous relationship
  const { data: transactionsList } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      stage,
      status,
      purchase_price,
      close_date,
      contact_id,
      agent_id
    `)
    .eq("brokerage_id", brokerageId)

  // Fetch contacts and agents separately for lookup
  const contactIds = (transactionsList ?? [])
    .map(t => t.contact_id)
    .filter((id): id is string => !!id)
  
  const agentIds = (transactionsList ?? [])
    .map(t => t.agent_id)
    .filter((id): id is string => !!id)

  const { data: contacts } = contactIds.length > 0
    ? await supabase
        .from("contacts")
        .select("id, first_name, last_name")
        .in("id", contactIds)
    : { data: [] }

  const { data: agents } = agentIds.length > 0
    ? await supabase
        .from("agents")
        .select("id, user_id")
        .in("id", agentIds)
    : { data: [] }

  // Fetch agent user names for display
  const userIds = (agents ?? [])
    .map(a => a.user_id)
    .filter((id): id is string => !!id)

  const { data: agentUsers } = userIds.length > 0
    ? await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("id", userIds)
    : { data: [] }

  // Create lookup maps
  const contactMap = new Map((contacts ?? []).map(c => [c.id, c]))
  const agentMap = new Map((agents ?? []).map(a => [a.id, a]))
  const userMap = new Map((agentUsers ?? []).map(u => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()]))

  // Enrich health scores with transaction data
  const enrichedScores = (healthScores ?? []).map(score => {
    const transaction = (transactionsList ?? []).find(t => t.id === score.transaction_id)
    return {
      ...score,
      transaction: transaction ? {
        ...transaction,
        contact: transaction.contact_id ? contactMap.get(transaction.contact_id) : null,
        agent_user_name: transaction.agent_id ? userMap.get(agentMap.get(transaction.agent_id)?.user_id ?? "") : null,
      } : null,
    }
  })

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
  const scores = enrichedScores ?? []
  const summary = {
    critical: scores.filter(s => s.risk_level === "critical").length,
    at_risk:  scores.filter(s => s.risk_level === "at_risk").length,
    watch:    scores.filter(s => s.risk_level === "watch").length,
    healthy:  scores.filter(s => s.risk_level === "healthy").length,
    total:    scores.length,
  }

  // Convert Maps to plain objects for serialization to client
  const agentNames: Record<string, string> = Object.fromEntries(userMap)

  return (
    <main className="min-h-screen bg-background p-6">
      <DealHealthDashboardClient
        healthScores={(enrichedScores ?? []) as any}
        interventions={interventions ?? []}
        summary={summary}
        brokerageId={brokerageId}
        agentNames={agentNames}
      />
    </main>
  )
}
