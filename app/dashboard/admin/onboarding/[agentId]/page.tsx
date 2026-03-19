import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentProgress } from "@/app/actions/onboarding/progress"
import { ProgressDashboardClient } from "@/app/dashboard/onboarding/progress/progress-dashboard-client"

export const metadata = {
  title: "Agent Progress | Admin View",
  description: "View agent's onboarding progress",
}

interface PageProps {
  params: Promise<{ agentId: string }>
}

export default async function AdminAgentProgressPage({ params }: PageProps) {
  const { agentId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { data: userData } = await supabase
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

  // Get agent details
  const { data: agentData } = await supabase
    .from("users")
    .select("first_name, last_name, brokerage_id")
    .eq("id", agentId)
    .single()

  // Verify agent is in the same brokerage
  if (!agentData || agentData.brokerage_id !== userData.brokerage_id) {
    redirect("/dashboard/admin/onboarding")
  }

  const agentName = `${agentData.first_name || ""} ${agentData.last_name || ""}`.trim() || "Agent"

  // Fetch agent's progress data
  const progressResult = await getAgentProgress(agentId, userData.brokerage_id)

  return (
    <div className="container max-w-5xl py-8">
      <div className="mb-6 p-4 bg-muted/50 rounded-lg border">
        <p className="text-sm text-muted-foreground">
          Admin View: Viewing progress for <span className="font-medium text-foreground">{agentName}</span>
        </p>
      </div>
      <ProgressDashboardClient
        initialData={progressResult.data || null}
        agentName={agentName}
      />
    </div>
  )
}
