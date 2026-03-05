import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listISACampaigns, getEngagementFeed, getQualificationOutcomes, getGhostRecoveryQueue } from "@/app/actions/ai-isa"
import OutreachClient from "./OutreachClient"

export const metadata = {
  title: "Outreach | VIP Real Estate OS",
  description: "AI ISA campaigns, engagement feed, and ghost recovery queue.",
}

export default async function OutreachPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()

  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/onboarding")

  const brokerageId = profile.brokerage_id

  const { data: agentRow } = await service
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  const agentId = agentRow?.id ?? user.id

  // Parallel fetch all outreach data
  const [campaignsResult, engagementResult, qualificationsResult, ghostResult] = await Promise.all([
    listISACampaigns(brokerageId),
    getEngagementFeed({ brokerageId, limit: 30 }),
    getQualificationOutcomes(brokerageId),
    getGhostRecoveryQueue(brokerageId),
  ])

  const campaigns        = campaignsResult.success ? (campaignsResult as any).campaigns ?? [] : []
  const engagementFeed   = engagementResult.success ? (engagementResult as any).items ?? [] : []
  const qualifications   = qualificationsResult.success ? (qualificationsResult as any).outcomes ?? [] : []
  const ghostQueue       = ghostResult.success ? (ghostResult as any).contacts ?? [] : []

  return (
    <OutreachClient
      campaigns={campaigns}
      engagementFeed={engagementFeed}
      qualifications={qualifications}
      ghostQueue={ghostQueue}
      brokerageId={brokerageId}
      agentId={agentId}
      userId={user.id}
      role={profile.user_type ?? "agent"}
    />
  )
}
