import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { CoachingDashboardClient } from "./coaching-dashboard-client"
import { getLatestWeeklyReport, getBuyerCoaching } from "@/lib/intelligence/coaching-engine"
import { getSellerCoaching } from "@/lib/seller-coaching/coaching-generator"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Coaching | Dashboard",
  description: "AI-powered strategic coaching and playbooks",
}

export default async function CoachingPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { agentId: rawAgentId, brokerageId: rawBrokerageId } = await getAgentContext()
  const agentId = rawAgentId ?? ""
  const brokerageId = rawBrokerageId ?? ""

  // Fetch data in parallel
  const [
    weeklyReportResult,
    buyerContactsResult,
    activeListingsResult,
    interventionsResult,
    suggestionsResult,
  ] = await Promise.all([
    getLatestWeeklyReport(agentId),
    supabase
      .from("contacts")
      .select("id, first_name, last_name, buyer_stage, contact_persona")
      .eq("agent_id", agentId)
      .not("buyer_stage", "is", null)
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("listings")
      .select("id, property_address, lifecycle_stage, seller_persona")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("proactive_interventions")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .eq("resolved", false)
      .order("severity", { ascending: true }) // critical first
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("smart_assistant_suggestions")
      .select("*")
      .eq("agent_id", agentId)
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5),
  ])

  const buyerContacts = buyerContactsResult.data || []
  const activeListings = activeListingsResult.data || []
  const interventions = interventionsResult.data || []
  const suggestions = suggestionsResult.data || []

  // Fetch coaching content for each buyer and seller
  const buyerCoachingPromises = buyerContacts.map(async (contact) => {
    const coaching = await getBuyerCoaching(
      contact.buyer_stage ?? "",
      contact.contact_persona as any,
      brokerageId
    )
    return { contact, coaching }
  })

  const sellerCoachingPromises = activeListings.map(async (listing) => {
    const coaching = await getSellerCoaching(
      listing.lifecycle_stage ?? "pre_listing",
      listing.seller_persona as any,
      brokerageId
    )
    return { listing, coaching }
  })

  const [buyerCoachingResults, sellerCoachingResults] = await Promise.all([
    Promise.all(buyerCoachingPromises),
    Promise.all(sellerCoachingPromises),
  ])

  return (
    <CoachingDashboardClient
      agentId={agentId}
      brokerageId={brokerageId}
      userId={user.id}
      weeklyReport={weeklyReportResult}
      buyerCoaching={buyerCoachingResults}
      sellerCoaching={sellerCoachingResults}
      interventions={interventions}
      suggestions={suggestions}
    />
  )
}
