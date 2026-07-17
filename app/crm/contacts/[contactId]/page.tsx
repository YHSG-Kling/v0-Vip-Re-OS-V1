import { redirect }                from "next/navigation"
import { createClient }             from "@/lib/supabase/server"
import { BuyerOverviewClient }      from "./buyer-overview-client"
import { SellerLifetimeOverview }   from "./seller-lifetime-overview"
import { getBuyerEnabledGates }     from "@/app/actions/buyer-lifecycle-core"
import { ContactQuickActions }      from "@/components/contact/ContactQuickActions"
import { AddressingCard }           from "@/components/contact/AddressingCard"
import { StrategySessionCard }      from "@/components/contact/StrategySessionCard"
import { LastPromiseCard }          from "@/components/contact/LastPromiseCard"
import { InvestorDealsPanel }        from "@/components/contact/investor-deals-panel"
import { assertCanActOnContact }    from "@/lib/auth/contact-access"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge }                    from "@/components/ui/badge"
import { Route }                    from "lucide-react"

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
  const [contactResult, profileResult, interestsResult, enabledGates, segmentsResult] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", contactId).single(),
    supabase.from("users").select("first_name, last_name").eq("id", user.id).maybeSingle(),
    supabase.from("property_interests").select("*").eq("contact_id", contactId).maybeSingle(),
    getBuyerEnabledGates(contactId),
    // Segment memberships — written by the workflow "add to segment" step
    // (lib/workflow/adapters/segment-ops.ts). Active memberships only.
    supabase
      .from("contact_segments")
      .select("id, segment_id, added_at")
      .eq("contact_id", contactId)
      .is("removed_at", null)
      .order("added_at", { ascending: false })
      .limit(12),
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
  const contactSegments = segmentsResult.error
    ? []
    : ((segmentsResult.data ?? []) as Array<{ id: string; segment_id: string; added_at: string }>)

  // Latest AI showing plan (smart_showing_recommendations). The writer keys on
  // lead_id (leads class) with contact_id optional, so match either the contact
  // directly or any of the contact's leads (leads.contact_id → contacts.id).
  let showingRec: {
    id: string
    recommended_properties: unknown
    showing_route: Record<string, unknown> | null
    suggested_order: unknown
    total_drive_time: number | null
    recommended_day: string | null
    why_these_properties: string | null
    created_at: string
  } | null = null
  if (contact.buyer_stage) {
    const { data: leadRows } = await supabase
      .from("leads")
      .select("id")
      .eq("contact_id", contactId)
    const leadIds = (leadRows ?? []).map((l: { id: string }) => l.id)
    const targetFilter = leadIds.length > 0
      ? `contact_id.eq.${contactId},lead_id.in.(${leadIds.join(",")})`
      : `contact_id.eq.${contactId}`
    const { data: recRows } = await supabase
      .from("smart_showing_recommendations")
      .select("id, recommended_properties, showing_route, suggested_order, total_drive_time, recommended_day, why_these_properties, created_at")
      .or(targetFilter)
      .order("created_at", { ascending: false })
      .limit(1)
    showingRec = recRows?.[0] ?? null
  }

  const recommendedProperties: Array<Record<string, unknown>> = Array.isArray(showingRec?.recommended_properties)
    ? (showingRec!.recommended_properties as Array<Record<string, unknown>>)
    : []
  const suggestedOrder: string[] = Array.isArray(showingRec?.suggested_order)
    ? (showingRec!.suggested_order as unknown[]).filter((s): s is string => typeof s === "string")
    : []

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

      {/* Segment memberships — added by campaign workflow "add to segment" steps */}
      {contactSegments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
          <span className="text-xs text-muted-foreground">Segments</span>
          {contactSegments.map((s) => (
            <Badge key={s.id} variant="secondary" className="text-xs font-mono">
              {s.segment_id.slice(0, 8)}
            </Badge>
          ))}
        </div>
      )}

      {/* Addressing memory ("call me Bill") + the auto-prepared strategy session
          for this client's current moment — the concierge pair on every contact. */}
      <div className="grid gap-3 px-4 pt-3 lg:grid-cols-2">
        <AddressingCard
          contactId={contactId}
          firstName={contact.first_name ?? null}
          lastName={contact.last_name ?? null}
          initialPreferredName={contact.preferred_name ?? null}
          initialPronunciation={contact.name_pronunciation ?? null}
          initialSalutationStyle={contact.salutation_style ?? null}
        />
        <StrategySessionCard contactId={contactId} />
        <LastPromiseCard
          contactId={contactId}
          initialPromise={contact.last_promise ?? null}
          initialPromiseAt={contact.last_promise_at ?? null}
        />
      </div>

      {/* Investor off-market deal finder — buyer-side match against our scraped off-market inventory.
          Regular buyers get MLS matches; investors get off-market. Shown only for investor contacts. */}
      {contact.contact_type === "investor" && (
        <div className="px-4 pt-3">
          <InvestorDealsPanel contactId={contactId} />
        </div>
      )}

      {/* Latest AI showing plan — smart_showing_recommendations (route optimizer output) */}
      {contact.buyer_stage && showingRec && (
        <div className="px-4 pt-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Route className="h-4 w-4 text-primary" />
                AI Showing Plan
                {showingRec.recommended_day && (
                  <Badge variant="outline" className="text-xs">
                    {new Date(showingRec.recommended_day).toLocaleDateString()}
                  </Badge>
                )}
                {showingRec.total_drive_time != null && (
                  <Badge variant="secondary" className="text-xs">
                    ~{Math.round(showingRec.total_drive_time)} min drive
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                Generated {new Date(showingRec.created_at).toLocaleDateString()}
                {showingRec.why_these_properties ? ` — ${showingRec.why_these_properties}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {recommendedProperties.length > 0 ? (
                <ol className="space-y-2">
                  {recommendedProperties.map((p, i) => (
                    <li key={i} className="flex items-start gap-3 p-2 rounded-md border text-sm">
                      <span className="text-xs font-bold text-muted-foreground w-5 text-center mt-0.5">
                        {typeof p.order === "number" ? p.order : i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{typeof p.address === "string" ? p.address : "Property"}</p>
                        <p className="text-xs text-muted-foreground">
                          {[
                            typeof p.arrivalTime === "string" ? `Arrive ${p.arrivalTime}` : null,
                            typeof p.durationMinutes === "number" ? `${p.durationMinutes} min` : null,
                            typeof p.why_first === "string" ? p.why_first : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : suggestedOrder.length > 0 ? (
                <ol className="space-y-1.5">
                  {suggestedOrder.map((address, i) => (
                    <li key={i} className="flex items-center gap-3 text-sm">
                      <span className="text-xs font-bold text-muted-foreground w-5 text-center">{i + 1}</span>
                      <span className="truncate">{address}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">No properties in this plan.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

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
