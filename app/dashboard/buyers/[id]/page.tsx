import { redirect }             from "next/navigation"
import { createClient }          from "@/lib/supabase/server"
import { BuyerOverviewClient }   from "./buyer-overview-client"

// Heavy data (journey, financials, tours, collaborative search) is loaded
// lazily from the client via SWR/server-actions to avoid cascading server
// calls on every page render that were causing memory exhaustion.

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BuyerDetailPage({ params }: PageProps) {
  const { id: buyerId } = await params
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Load only the minimal data required for initial render
  const [contactResult, profileResult, interestsResult] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", buyerId).single(),
    supabase.from("users").select("first_name, last_name").eq("id", user.id).maybeSingle(),
    supabase.from("property_interests").select("*").eq("contact_id", buyerId).maybeSingle(),
  ])

  const { data: contact, error: contactError } = contactResult

  if (contactError || !contact) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">Buyer not found</p>
      </div>
    )
  }

  const brokerageId = contact.brokerage_id ?? ""
  const agentProfile = profileResult.data
  const agentName = `${agentProfile?.first_name ?? ""} ${agentProfile?.last_name ?? ""}`.trim() || "Agent"

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      <BuyerOverviewClient
        buyerId={buyerId}
        contact={contact}
        journey={null}
        profile={null}
        partners={[]}
        drafts={[]}
        propertyInterests={interestsResult.data ?? null}
        brokerageId={brokerageId}
        agentUserId={user.id}
        agentName={agentName}
        collaborativeSearches={[]}
        activeSearch={null}
        consensus={null}
        tours={[]}
        nextTour={null}
        dualAgencyListings={[]}
      />
    </div>
  )
}
