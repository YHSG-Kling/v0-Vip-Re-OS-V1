import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { AdminOnboardingOsClient } from "./admin-onboarding-os-client"
import { OnboardingCurriculumEditor } from "./onboarding-curriculum-editor"
import { getBrokerageProviderReadiness } from "@/lib/platform/provider-posture"
import { loadOnboardingRoster } from "@/lib/onboarding/onboarding-roster"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

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


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
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

  // ONE roster for both broker-facing onboarding surfaces (this console and the
  // /dashboard/onboarding/admin/agents table). It also derives `isStalled`
  // honestly: agent_onboarding.status can only be in_progress|completed|paused,
  // so the old `status === "stalled"` filter here was permanently 0.
  const roster = await loadOnboardingRoster(service, userData.brokerage_id)

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

  // Provider readiness — derived from the canonical provider registry (the same
  // engine the fleet posture uses), scoped to this brokerage. Reads BOTH the
  // tenant's own connections AND platform-provided/keyless capabilities, so a
  // solo admin relying on platform keys sees their live capability set instead
  // of an empty 0% panel (raw brokerage_integrations was blind to those).
  const providerReadiness = await getBrokerageProviderReadiness(service, userData.brokerage_id)

  // Fetch health metrics
  const { data: recentOnboardings } = await service
    .from("agent_onboarding")
    .select("id, status, completion_percentage, created_at")
    .eq("brokerage_id", userData.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(10)

  return (
    <div className="space-y-6">
      <AdminOnboardingOsClient
        userId={user.id}
        brokerageId={userData.brokerage_id}
        userRole={userData.user_type || "user"}
        adoptionMetrics={{
          avgCompletion: roster.avgCompletion,
          activeAgents: roster.inProgressCount,
          completedAgents: roster.completedCount,
          stalledCount: roster.stalledCount,
          stalledAgentIds: roster.agents.filter((a) => a.isStalled).map((a) => a.agentId),
        }}
        setupBlockers={integrations?.filter(i => i.status !== "connected") || []}
        trainingProgress={trainingProgress || []}
        providerReadiness={providerReadiness}
        recentOnboardings={recentOnboardings || []}
      />
      {/* Curriculum authoring — the write surface the monitoring console lacked */}
      <div id="onboarding-curriculum" className="px-4 sm:px-6 pb-6">
        <OnboardingCurriculumEditor />
      </div>
    </div>
  )
}
