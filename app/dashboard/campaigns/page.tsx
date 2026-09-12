import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

// KEEP-ONE: this hub is a REDIRECT, not a surface. The campaign command center
// lives at /dashboard/marketing/studio?tab=campaigns; per-sequence launch/pause/
// duplicate/delete plus the batch Activate/Pause strip live at
// /dashboard/campaigns/sequences (SequencesListClient). A parallel
// ./components/os/ panel set (command strip, ops radar, action stack, sequence
// control, launch queue, repurpose queue, performance feedback, batch actions)
// was imported by nothing and duplicated all of that job-for-job, so it was
// removed rather than mounted — mounting it would have created a SECOND
// campaign surface, which is the drift this consolidation exists to end.
// Notably the live per-row toggle gates activation behind
// precheckSequenceCompliance(); the removed panels called the raw launch
// actions and would have re-opened a path around that gate.
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
