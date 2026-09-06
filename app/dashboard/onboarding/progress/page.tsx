import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { getAgentProgress } from "@/app/actions/onboarding/progress"
import { ProgressDashboardClient } from "./progress-dashboard-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = 'force-dynamic'

export const metadata = {
  title: "Training Progress | VIP Real Estate AI OS",
  description: "Track your onboarding progress and certifications",
}

export default async function ProgressPage() {
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
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, first_name, last_name")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard")
  }

  // Check feature access
  const hasAccess = await canAccessFeature("training_progress", user.id, userData.brokerage_id)
  if (!hasAccess) {
    redirect("/dashboard")
  }

  // Fetch initial progress data
  const progressResult = await getAgentProgress()

  return (
    <ProgressDashboardClient
      initialData={progressResult.data || null}
      agentName={`${userData.first_name || ""} ${userData.last_name || ""}`.trim() || "Agent"}
    />
  )
}
