import { redirect }            from "next/navigation"
import { createClient }         from "@/lib/supabase/server"
import { BuyerOverviewClient }  from "./buyer-overview-client"
import { getBuyerEnabledGates } from "@/app/actions/buyer-lifecycle-core"

/**
 * Agent-facing CRM contact dashboard. Unified entry point for buyers, sellers,
 * and lifetime contacts — all of whom are rows in the contacts table.
 *
 * View selection by contact lifecycle:
 *   - buyer_stage set         → BuyerOverviewClient (offers / search / tours / alerts)
 *   - seller stage / listing  → fallback to /crm?contact= (full CRM workspace owns
 *                               the seller flow today; buyer-side is the rebuilt path)
 *   - no stage / lifetime     → /crm?contact= fallback
 *
 * Heavy data is loaded lazily from the client via SWR/server-actions to avoid
 * cascading server calls on every page render.
 */
interface PageProps {
  params: Promise<{ contactId: string }>
}

export default async function ContactDetailPage({ params }: PageProps) {
  const { contactId } = await params
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Load minimal data for initial render + decide which view to mount
  const [contactResult, profileResult, interestsResult, enabledGates] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", contactId).single(),
    supabase.from("users").select("first_name, last_name").eq("id", user.id).maybeSingle(),
    supabase.from("property_interests").select("*").eq("contact_id", contactId).maybeSingle(),
    getBuyerEnabledGates(contactId),
  ])

  const { data: contact, error: contactError } = contactResult

  if (contactError || !contact) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">Contact not found</p>
      </div>
    )
  }

  // Buyer-stage contacts get the buyer overview workspace. All other contacts
  // (sellers, lifetime, prospects) route to the CRM workspace which owns the
  // full record view + cross-stage tools.
  if (!contact.buyer_stage) {
    redirect(`/crm?contact=${contactId}`)
  }

  const brokerageId  = contact.brokerage_id ?? ""
  const agentProfile = profileResult.data
  const agentName    = `${agentProfile?.first_name ?? ""} ${agentProfile?.last_name ?? ""}`.trim() || "Agent"

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      <BuyerOverviewClient
        buyerId={contactId}
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
        enabledGates={enabledGates}
      />
    </div>
  )
}
