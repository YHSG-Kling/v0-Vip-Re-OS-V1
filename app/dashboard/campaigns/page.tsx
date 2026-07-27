import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export default async function CampaignsHubRedirect() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userRow?.brokerage_id) redirect("/dashboard/onboarding")

  redirect("/dashboard/marketing/studio?tab=campaigns")
}
