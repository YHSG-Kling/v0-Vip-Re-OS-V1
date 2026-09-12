import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import {
  listISACampaigns,
  getChannelFeatureFlags,
  getEngagementFeed,
  getQualificationOutcomes,
  getGhostRecoveryQueue,
} from "@/app/actions/ai-isa"
import { ISACampaignsClient } from "./components/ISACampaignsClient"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "ISA Campaigns | VIP Real Estate AI OS",
  description: "Manage AI Inside Sales Agent outreach campaigns.",
}

export default async function ISACampaignsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Resolve brokerage_id from user profile
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground text-sm">
        No brokerage associated with your account.
      </div>
    )
  }

  const brokerageId = profile.brokerage_id

  // Fetch all 4 tabs' data in parallel
  const [campaignResult, flags, engagementResult, qualResult, ghostResult] = await Promise.all([
    listISACampaigns(brokerageId),
    getChannelFeatureFlags(),
    getEngagementFeed({ brokerageId, limit: 100 }),
    getQualificationOutcomes(brokerageId),
    getGhostRecoveryQueue(brokerageId),
  ])

  return (
    <main className="container mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground text-balance">ISA Campaigns</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage automated AI outreach campaigns across email, SMS, video, and direct mail channels.
        </p>
      </div>

      <ISACampaignsClient
        brokerageId={brokerageId}
        initialCampaigns={campaignResult.campaigns}
        initialStats={campaignResult.stats}
        videoEnabled={flags.video_campaigns}
        directMailEnabled={flags.direct_mail_campaigns}
        initialEngagement={engagementResult.items}
        initialOutcomes={qualResult.outcomes}
        initialQualStats={qualResult.stats}
        initialChartData={qualResult.chartData}
        initialGhosts={ghostResult.ghosts}
      />
    </main>
  )
}
