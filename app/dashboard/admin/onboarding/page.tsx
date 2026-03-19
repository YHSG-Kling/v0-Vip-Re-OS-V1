import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { AdminOnboardingOsClient } from "./admin-onboarding-os-client"

export const metadata = {
  title: "Onboarding Operations | Admin OS",
  description: "Command center for agent onboarding, training, and adoption metrics",
}

export default async function AdminOnboardingOsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const service = createServiceClient()
  const { data: userData } = await service
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard")
  }

  // Only admins and brokers can access this page
  if (!["admin", "broker"].includes(userData.user_type || "")) {
    redirect("/dashboard")
  }

  // Fetch adoption metrics
  const { data: adoptionMetrics } = await service
    .from("agent_onboarding")
    .select("completion_percentage, status")
    .eq("brokerage_id", userData.brokerage_id)

  // Fetch setup blockers (incomplete integrations)
  const { data: integrations } = await service
    .from("brokerage_integrations")
    .select("integration_type, is_configured")
    .eq("brokerage_id", userData.brokerage_id)

  // Fetch training progress
  const { data: trainingProgress } = await service
    .from("agent_courses")
    .select("status, completion_percentage")
    .eq("brokerage_id", userData.brokerage_id)

  // Fetch provider readiness
  const { data: providers } = await service
    .from("brokerage_integrations")
    .select("integration_type, is_configured, configured_at")
    .eq("brokerage_id", userData.brokerage_id)

  // Fetch health metrics
  const { data: recentOnboardings } = await service
    .from("agent_onboarding")
    .select("id, status, completion_percentage, created_at")
    .eq("brokerage_id", userData.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(10)

  const avgCompletion = adoptionMetrics?.length 
    ? Math.round(adoptionMetrics.reduce((sum, m) => sum + (m.completion_percentage || 0), 0) / adoptionMetrics.length)
    : 0

  const stalledCount = adoptionMetrics?.filter(m => m.status === "stalled").length || 0
  
  const configuredIntegrations = integrations?.filter(i => i.is_configured).length || 0
  const totalIntegrations = integrations?.length || 0

  return (
    <AdminOnboardingOsClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      userRole={userData.user_type || "user"}
      adoptionMetrics={{
        avgCompletion,
        activeAgents: adoptionMetrics?.filter(m => m.status === "in_progress").length || 0,
        completedAgents: adoptionMetrics?.filter(m => m.status === "completed").length || 0,
        stalledCount,
      }}
      setupBlockers={integrations?.filter(i => !i.is_configured) || []}
      trainingProgress={trainingProgress || []}
      providers={providers || []}
      recentOnboardings={recentOnboardings || []}
    />
  )
}
