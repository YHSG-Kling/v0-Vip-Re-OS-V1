import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { DealHealthDashboardClient } from "./deal-health-dashboard-client"

export const metadata = {
  title: "Deal Health Dashboard | VIP Real Estate OS",
  description: "Monitor deal health across all active transactions",
}

export default async function DealHealthDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Get user's profile and brokerage
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/onboarding")

  // Gate to broker/admin/manager/tc roles
  const allowedRoles = ["broker", "admin", "manager", "tc"]
  if (!allowedRoles.includes(profile.role ?? "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  // Fetch all deal health scores with transaction info
  const { data: healthScores } = await supabase
    .from("deal_health_scores")
    .select(`
      id,
      transaction_id,
      overall_score,
      risk_level,
      ai_narrative,
      calculated_at,
      transactions (
        id,
        property_address,
        stage,
        contract_price,
        closing_date,
        contact_id,
        agent_user_id,
        contacts (first_name, last_name),
        profiles!transactions_agent_user_id_fkey (first_name, last_name)
      )
    `)
    .eq("brokerage_id", brokerageId)
    .order("overall_score", { ascending: true })

  // Fetch unresolved proactive interventions
  const { data: interventions } = await supabase
    .from("proactive_interventions")
    .select("id, intervention_type, title, description, status, created_at, transaction_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "pending")
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

  return (
    <main className="min-h-screen bg-background p-6">
      <DealHealthDashboardClient
        healthScores={healthScores ?? []}
        interventions={interventions ?? []}
        summary={summary}
        brokerageId={brokerageId}
      />
    </main>
  )
}
