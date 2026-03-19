import { redirect }             from "next/navigation"
import { createClient }          from "@/lib/supabase/server"
import { getBuyerJourney }       from "@/app/actions/buyer-execution"
import { loadFinancialProfile, loadMortgageBrokers } from "@/app/actions/buyer-financial"
import { getCollaborativeSearches, getConsensus } from "@/app/actions/collaborative-search"
import { getBuyerTours } from "@/app/actions/tour-planner"
import { BuyerOverviewClient }   from "./buyer-overview-client"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BuyerDetailPage({ params }: PageProps) {
  const { id: buyerId } = await params
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Load contact — verify agent owns this contact OR is broker/admin in same brokerage
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", buyerId)
    .single()

  if (contactError || !contact) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">Buyer not found</p>
      </div>
    )
  }

  const brokerageId = contact.brokerage_id ?? ""

  // Parallel loads
  const [journeyResult, financialResult, partnersResult, draftsResult, interestsResult, profileResult, collaborativeSearchResult, toursResult] =
    await Promise.all([
      getBuyerJourney({ contactId: buyerId, userId: user.id, source: "agent_dashboard" }),
      loadFinancialProfile({ contactId: buyerId }),
      loadMortgageBrokers({ agentUserId: user.id }),
      supabase
        .from("ai_message_drafts")
        .select("id, draft_body, draft_subject, suggested_tone, confidence_score, channel, created_at, status")
        .eq("contact_id", buyerId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("property_interests")
        .select("*")
        .eq("contact_id", buyerId)
        .maybeSingle(),
      // Load agent profile for agentName
      supabase
        .from("users")
        .select("full_name, first_name, last_name")
        .eq("id", user.id)
        .maybeSingle(),
      // Collaborative search
      getCollaborativeSearches(buyerId),
      // Tours
      getBuyerTours(buyerId),
    ])

  const agentProfile = profileResult.data
  const agentName = agentProfile?.full_name
    ?? `${agentProfile?.first_name ?? ""} ${agentProfile?.last_name ?? ""}`.trim()
    ?? "Agent"

  // Collaborative search computed values
  const collaborativeSearches = (collaborativeSearchResult as any)?.searches || []
  const activeSearch = collaborativeSearches[0] || null
  const tours = (toursResult as any)?.tours || []
  const nextTour = tours.sort((a: any, b: any) =>
    new Date(a.tour_date).getTime() - new Date(b.tour_date).getTime()
  ).find((t: any) => new Date(t.tour_date) >= new Date())

  // If activeSearch exists, fetch consensus
  const consensusResult = activeSearch ? await getConsensus(activeSearch.id) : null
  const consensus = (consensusResult as any)?.consensus || null

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      <BuyerOverviewClient
        buyerId={buyerId}
        contact={contact}
        journey={journeyResult.journey ?? null}
        profile={financialResult.profile ?? null}
        partners={partnersResult.partners ?? []}
        drafts={draftsResult.data ?? []}
        propertyInterests={interestsResult.data ?? null}
        brokerageId={brokerageId}
        agentUserId={user.id}
        agentName={agentName}
        collaborativeSearches={collaborativeSearches}
        activeSearch={activeSearch}
        consensus={consensus}
        tours={tours}
        nextTour={nextTour}
      />
    </div>
  )
}
