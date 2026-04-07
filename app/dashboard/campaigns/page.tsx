import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { CampaignsHubClient } from "./campaigns-hub-client"
import {
  listMarketingCampaigns,
  getCampaignPerformanceSummary,
} from "@/app/actions/marketing-campaigns"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Campaigns Hub | Dashboard",
  description: "Create, manage and track multi-channel marketing campaigns",
}

export default async function CampaignsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type, first_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const isBrokerOrAdmin = profile.user_type === "broker" || profile.user_type === "admin"

  // Fetch campaigns and summary in parallel
  const [campaignsResult, summaryResult] = await Promise.all([
    listMarketingCampaigns({
      brokerageId: profile.brokerage_id,
      // Agents only see their own campaigns
      agentUserId: isBrokerOrAdmin ? undefined : user.id,
      limit: 50,
    }),
    getCampaignPerformanceSummary(profile.brokerage_id),
  ])

  return (
    <div className="flex flex-col min-h-full">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Campaigns Hub</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Create, manage, and track multi-channel marketing campaigns
        </p>
      </div>
      <CampaignsHubClient
        userId={user.id}
        brokerageId={profile.brokerage_id}
        userRole={profile.user_type ?? "agent"}
        campaigns={campaignsResult.campaigns}
        total={campaignsResult.total}
        summary={summaryResult.success ? summaryResult.summary ?? null : null}
      />
    </div>
  )
}
