import { Metadata } from "next"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { NewslettersClient } from "./newsletters-client"

export const metadata: Metadata = {
  title: "Newsletters | Marketing Studio",
  description: "Create, manage, and send professional newsletters to your contacts",
}

export default async function NewslettersPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }

  // Resolve agent + brokerage — never throw, fall back to empty strings
  let brokerageId = ""
  let agentId = ""

  try {
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle()

    brokerageId = userData?.brokerage_id ?? ""

    if (brokerageId) {
      const { data: agent } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
      agentId = agent?.id ?? ""
    }
  } catch {
    // non-fatal — page renders with empty state
  }

  // Load stats in parallel — individual failures fall back to empty
  let campaigns: Array<{
    id: string
    status: string
    open_rate: number | null
    campaign_name: string
    subject_line: string
    created_at: string
    send_date: string | null
  }> = []
  let totalSubscribers = 0

  try {
    const [campaignsResult, subscribersResult] = await Promise.all([
      brokerageId
        ? supabase
            .from("newsletter_campaigns")
            .select("id, status, open_rate, campaign_name, subject_line, created_at, send_date")
            .eq("brokerage_id", brokerageId)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as typeof campaigns, error: null }),
      brokerageId
        ? supabase
            .from("newsletter_subscribers")
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId)
            .eq("status", "active")
        : Promise.resolve({ count: 0, error: null }),
    ])

    campaigns = (campaignsResult as { data: typeof campaigns | null }).data ?? []
    totalSubscribers = (subscribersResult as { count: number | null }).count ?? 0
  } catch {
    // non-fatal — renders with empty campaign list
  }

  const activeCampaigns = campaigns.filter((c) => c.status === "scheduled").length
  const sentCampaigns = campaigns.filter((c) => c.status === "sent")
  const avgOpenRate =
    sentCampaigns.length > 0
      ? sentCampaigns.reduce((sum, c) => sum + (c.open_rate ?? 0), 0) / sentCampaigns.length
      : null

  return (
    <NewslettersClient
      userId={user.id}
      agentId={agentId}
      brokerageId={brokerageId}
      campaigns={campaigns}
      stats={{
        activeCampaigns,
        totalSubscribers,
        avgOpenRate,
        totalCampaigns: campaigns.length,
      }}
    />
  )
}
