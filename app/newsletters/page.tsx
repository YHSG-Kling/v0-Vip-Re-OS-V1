import { Metadata } from "next"
import Link from "next/link"
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

  // Resolve agent + brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId: string = userData?.brokerage_id ?? ""

  const { data: agent } = brokerageId
    ? await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
    : { data: null }

  const agentId: string = agent?.id ?? ""

  // Load real stats in parallel
  const [campaignsResult, subscribersResult] = await Promise.all([
    brokerageId
      ? supabase
          .from("newsletter_campaigns")
          .select("id, status, open_rate, campaign_name, subject_line, created_at, send_date")
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    brokerageId
      ? supabase
          .from("newsletter_subscribers")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "active")
      : Promise.resolve({ count: 0 }),
  ])

  const campaigns = (campaignsResult as { data: Array<{
    id: string
    status: string
    open_rate: number | null
    campaign_name: string
    subject_line: string
    created_at: string
    send_date: string | null
  }> | null }).data ?? []
  const totalSubscribers = (subscribersResult as { count: number | null }).count ?? 0

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
