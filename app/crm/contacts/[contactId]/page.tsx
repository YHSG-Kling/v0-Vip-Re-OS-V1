import { redirect }                from "next/navigation"
import { createClient }             from "@/lib/supabase/server"
import { BuyerOverviewClient }      from "./buyer-overview-client"
import { SellerLifetimeOverview }   from "./seller-lifetime-overview"
import { getBuyerEnabledGates }     from "@/app/actions/buyer-lifecycle-core"
import { ContactQuickActions }      from "@/components/contact/ContactQuickActions"
import { assertCanActOnContact }    from "@/lib/auth/contact-access"

/**
 * CONSOLIDATED agent-facing contact dashboard — the SINGLE entry point for every contact type:
 *   - buyer_stage set         → BuyerOverviewClient (offers / search / tours / alerts)
 *   - no buyer_stage          → SellerLifetimeOverview (identity / listings / transactions /
 *                                activities) + a deep-link to the full /crm workspace for any
 *                                seller-side advanced tools that aren't surfaced here yet
 * Quick-action panel (Run investigation / Verify email / Verify address) renders for ALL types.
 */
interface PageProps {
  params: Promise<{ contactId: string }>
}

export default async function ContactDetailPage({ params }: PageProps) {
  const { contactId } = await params
  // Defensive: contactId flows into PostgREST .or() filters downstream — a non-UUID would either
  // fragment the OR or get rejected for a uuid-typed column with a misleading error. Reject early.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">Invalid contact id</p>
      </div>
    )
  }
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Defense-in-depth on the consolidated read path. RLS on the contacts table already gates
  // cross-brokerage reads, but routing the access decision through the canonical helper means a
  // future refactor that swaps to createServiceClient (RLS bypass) can't silently expose every
  // contact in the DB. Same gate the write-side quick-action server actions run.
  const gate = await assertCanActOnContact(contactId)
  if (!gate.ok) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">{gate.error}</p>
      </div>
    )
  }

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

  const brokerageId  = contact.brokerage_id ?? ""
  const agentProfile = profileResult.data
  const agentName    = `${agentProfile?.first_name ?? ""} ${agentProfile?.last_name ?? ""}`.trim() || "Agent"

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      {/* AI quick actions — server-action-gated to the contact's owning agent / brokerage / platform */}
      <div className="p-4 pb-0">
        <ContactQuickActions
          contactId={contactId}
          hasEmail={!!contact.email}
          hasAddress={!!contact.mailing_address}
          emailVerified={contact.email_verified ?? null}
          addressVerified={contact.mailing_address_verified ?? null}
          contactType={contact.contact_type ?? null}
          buyerStage={contact.buyer_stage ?? null}
        />
      </div>

      {contact.buyer_stage ? (
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
      ) : (
        /* Seller / lifetime / prospect — consolidated detail surface on this same route */
        <SellerLifetimeOverview
          contactId={contactId}
          contact={contact}
          brokerageId={brokerageId}
        />
      )}
    </div>
  )
}
