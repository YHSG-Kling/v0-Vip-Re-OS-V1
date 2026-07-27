import { createClient } from "@/lib/supabase/server"
import { EducationLibrary } from "@/app/components/features/education/EducationLibrary"
import { EducationEditor } from "@/app/components/features/education/EducationEditor"
import { ProgressDashboard } from "@/app/components/features/education/ProgressDashboard"
import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export default async function EducationPage() {
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
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user?.id ?? "")
    .maybeSingle()

  if (!profile?.brokerage_id || profile.user_type !== "admin") {
    redirect("/dashboard")
  }

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Education Management</h1>
        <p className="text-gray-600">Create, manage, and track educational resources for your brokerage</p>
      </div>

      <ProgressDashboard brokerageId={profile.brokerage_id} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <EducationEditor brokerageId={profile.brokerage_id} />
        </div>
        <div>
          <EducationLibrary brokerageId={profile.brokerage_id} />
        </div>
      </div>
    </div>
  )
}
