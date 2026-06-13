import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { CoachingDashboardClient } from "./coaching-dashboard-client"
import { getBuyerCoaching } from "@/lib/intelligence/coaching-engine"
// Weekly Report card is now fed by the OUTCOME-BASED agent-coaching loop (single source
// of truth). getAgentWeeklyReport returns the exact dashboard shape the retired
// getLatestWeeklyReport did ({overall_score, headline, wins, gaps, ...id, created_at}).
import { getAgentWeeklyReport } from "@/lib/kernel/agent-coaching"
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
    getAgentWeeklyReport(agentId),
    supabase
      .from("contacts")
      .select("id, first_name, last_name, buyer_stage, contact_persona")
      .eq("agent_id", agentId)
      .not("buyer_stage", "is", null)
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("listings")
      .select("id, property_address:address, lifecycle_stage, seller:seller_contact_id(contact_persona)")
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
    // seller persona lives on the seller CONTACT (PostgREST embed → array); strip the
    // embed off the listing object so it matches the downstream SellerCoachingItem shape.
    const sellerEmbed = (listing as any).seller
    const sellerPersona = (Array.isArray(sellerEmbed) ? sellerEmbed[0] : sellerEmbed)?.contact_persona ?? null
    const { seller: _omit, ...listingRow } = listing as any
    const coaching = await getSellerCoaching(
      listingRow.lifecycle_stage ?? "pre_listing",
      sellerPersona as any,
      brokerageId
    )
    return { listing: listingRow, coaching }
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
