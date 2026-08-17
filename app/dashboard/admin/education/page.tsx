import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getEducationModules } from "@/app/actions/admin/license-tracking"
import { EducationContentClient } from "./education-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const metadata = {
  title: "Education Content | Admin",
}

export default async function AdminEducationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")
  if (!isAdminOrBroker({ user_type: profile.user_type ?? "" })) {
    redirect("/dashboard")
  }

  const { modules } = await getEducationModules(profile.brokerage_id)

  return (
    <div className="container max-w-4xl py-6">
      <EducationContentClient
        brokerageId={profile.brokerage_id}
        initialModules={modules}
      />
    </div>
  )
}
