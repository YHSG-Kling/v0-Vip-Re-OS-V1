import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { ReputationClient } from "./reputation-client"

export const dynamic = "force-dynamic"

export default async function ReputationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId } = await getAgentContext()

  const [
    { data: reviews },
    { data: reviewRequests },
    { data: recentClosings },
  ] = await Promise.all([
    supabase
      .from("agent_reviews")
      .select("id, rating, review_text, platform, source_url, is_published, response_text, response_at, created_at, contact_id, transaction_id")
      .eq("agent_id",     agentId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("review_requests")
      .select("id, contact_id, contact_name, platform, status, sent_at, completed_at, review_url, created_at")
      .eq("agent_id",     agentId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("transactions")
      .select("id, property_address, close_date, contact_id, contacts(id, first_name, last_name, email, phone)")
      .eq("agent_id",  agentId)
      .eq("status",    "closed")
      .gte("close_date", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0])
      .order("close_date", { ascending: false })
      .limit(10),
  ])

  return (
    <ReputationClient
      agentId={agentId}
      brokerageId={brokerageId}
      userId={user.id}
      reviews={reviews || []}
      reviewRequests={reviewRequests || []}
      recentClosings={recentClosings || []}
    />
  )
}
