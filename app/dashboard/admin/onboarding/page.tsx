import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { AdminOnboardingOsClient } from "./admin-onboarding-os-client"
import { OnboardingCurriculumEditor } from "./onboarding-curriculum-editor"

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
  // brokerage_integrations real cols: provider_type, status (connected/error/not_configured),
  // last_health_check_at — not integration_type/is_configured/configured_at.
  const { data: integrations } = await service
    .from("brokerage_integrations")
    .select("provider_type, status")
    .eq("brokerage_id", userData.brokerage_id)

  // Training progress = agents' Academy module completion on the CANONICAL rail
  // (learning_assignments). The legacy agent_courses table had no runtime writer, so this
  // panel always showed 0% completed — this reflects real agent coursework, mapped to the
  // panel's {status, score} shape (status CHECK: passed|in_progress|not_started).
  const { data: trainingRows } = await service
    .from("learning_assignments")
    .select("status, quiz_score")
    .eq("brokerage_id", userData.brokerage_id)
    .not("agent_user_id", "is", null)
  const trainingProgress = (trainingRows || []).map((r: { status: string | null; quiz_score: number | null }) => ({
    status: r.status === "completed" ? "passed" : r.status === "in_progress" ? "in_progress" : "not_started",
    score: r.quiz_score,
  }))

  // Fetch provider readiness
  const { data: providers } = await service
    .from("brokerage_integrations")
    .select("provider_type, status, last_health_check_at")
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
  
  const configuredIntegrations = integrations?.filter(i => i.status === "connected").length || 0
  const totalIntegrations = integrations?.length || 0

  return (
    <div className="space-y-6">
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
        setupBlockers={integrations?.filter(i => i.status !== "connected") || []}
        trainingProgress={trainingProgress || []}
        providers={providers || []}
        recentOnboardings={recentOnboardings || []}
      />
      {/* Curriculum authoring — the write surface the monitoring console lacked */}
      <div className="px-4 sm:px-6 pb-6">
        <OnboardingCurriculumEditor />
      </div>
    </div>
  )
}
