import { redirect }                from "next/navigation"
import { createClient }             from "@/lib/supabase/server"
import { BuyerOverviewClient }      from "./buyer-overview-client"
import { SellerLifetimeOverview }   from "./seller-lifetime-overview"
import { getBuyerEnabledGates }     from "@/app/actions/buyer-lifecycle-core"
import { checkBuyerOfferEligibility } from "@/app/actions/buyer-lifecycle-core"
import { ContactQuickActions }      from "@/components/contact/ContactQuickActions"
import { AddressingCard }           from "@/components/contact/AddressingCard"
import { StrategySessionCard }      from "@/components/contact/StrategySessionCard"
import { LastPromiseCard }          from "@/components/contact/LastPromiseCard"
import { InvestorDealsPanel }        from "@/components/contact/investor-deals-panel"
import { BuyerBrokerAgreementPanel } from "@/components/contact/buyer-broker-agreement-panel"
import { WorkflowRunsPanel }         from "./components/workflow-runs-panel"
import { EnrichmentPanel }          from "./components/enrichment-panel"
import { FollowupCard }            from "./components/followup-card"
import { SmartDripCard }           from "./components/smart-drip-card"
import { LeadHistoryCard }        from "./components/lead-history-card"
import { VoiceNoteCard }          from "./components/voice-note-card"
import { IsaOutreachCard }        from "./components/isa-outreach-card"
import { SegmentMemberships }      from "./components/segment-memberships"
import { ShowingRoutePlanner }     from "./showing-route-planner"
import { CampaignBundleSendCard, type BundleOption } from "./components/campaign-bundle-send-card"
import { listCampaignBundles }      from "@/app/actions/campaign-bundles"
import { AgentActionDispositionQueue } from "@/app/components/agent/AgentActionDispositionQueue"
import { getAgentPortalStream }     from "@/app/actions/portal-stream"
import { getInboxMessages }         from "@/app/actions/inbox"
import { assertCanActOnContact }    from "@/lib/auth/contact-access"
import { getBuyerTours }             from "@/app/actions/tour-planner"
import { getBuyerJourney, getBuyerUpdateHistory } from "@/app/actions/buyer-execution"
import { getCollaborativeSearches, getConsensus } from "@/app/actions/collaborative-search"
import { loadConversationDrafts }    from "@/app/actions/ai-reply-coach"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge }                    from "@/components/ui/badge"
import { Route, PanelsTopLeft }     from "lucide-react"
import Link                         from "next/link"

/**
 * CONSOLIDATED agent-facing contact dashboard — the SINGLE entry point for every contact type:
 *   - buyer_stage set         → BuyerOverviewClient (offers / search / tours / alerts)
 *   - no buyer_stage          → SellerLifetimeOverview (identity / listings / transactions /
 *                                activities) + a deep-link to the full /crm workspace for any
 *                                seller-side advanced tools that aren't surfaced here yet
 * Quick-action panel (Run investigation / Verify email / Verify address) renders for ALL types.
 *
 * ROUTE-PARITY VERDICT (vs the /crm?contact= workspace) — a blanket redirect to
 * /crm?contact=[id] was CONSIDERED and REJECTED, because real things genuinely
 * depend on this standalone route:
 *   · it is the ONLY mount of the buyer journey hub (BuyerOverviewClient) and
 *     the PARENT of a live sub-tree — /offers, /offers/new, /tours, /search,
 *     /listings/new, /alerts — whose pages gate-redirect BACK here (e.g.
 *     ?gate=offer_not_eligible) and whose entry points render only here;
 *   · /dashboard/buyers/[contactId] already PERMANENTLY redirects INTO this
 *     route as "the unified agent-facing view" (the platform's prior keep-one
 *     decision), and the agent-assistant tool-call rail emits review URLs into
 *     this sub-tree;
 *   · the concierge panels (quick actions / addressing memory / strategy
 *     session / last promise / investor deals / AI showing plan) mount only here.
 * The honest parity fix instead: an explicit cross-link into the full CRM
 * workspace (tabs: portal, unified inbox, channel controls, credit, videos,
 * transactions, activity) rendered below, so neither surface is a dead end and
 * nothing was deleted or orphaned.
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
  // intent:"read" — this is the read path; the gate's default is "write"
  // (fail-closed), which would wrongly refuse a read_only act-as investigator
  // and non-impersonating platform staff from VIEWING the page.
  const gate = await assertCanActOnContact(contactId, { intent: "read" })
  if (!gate.ok) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">{gate.error}</p>
      </div>
    )
  }

  // Load minimal data for initial render + decide which view to mount
  const [contactResult, profileResult, interestsResult, enabledGates, offerGate, segmentsResult] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", contactId).single(),
    supabase.from("users").select("first_name, last_name").eq("id", user.id).maybeSingle(),
    supabase.from("property_interests").select("*").eq("contact_id", contactId).maybeSingle(),
    getBuyerEnabledGates(contactId),
    // THE OFFER GATE IS DECIDED HERE, ON THE SERVER.
    // buyer-overview-client.tsx used to import isOfferAllowed from gating-helpers and call
    // it inside JSX — its own comment said "isOfferAllowed is async; server should
    // pre-compute". Two things were wrong with that. It passed `currentStage` where the
    // function takes a contactId, and it used the returned PROMISE as the condition: a
    // promise is always truthy, so the "make an offer" path rendered OPEN for every buyer
    // regardless of lifecycle state or financial verification. It also pulled server-only
    // gating code (and the service-role client) into a CLIENT bundle, which is what finally
    // broke the production build.
    checkBuyerOfferEligibility(contactId),
    // Segment memberships — opened and closed by
    // lib/marketing/segment-membership.ts, reached from the workflow
    // add_to_segment / remove_from_segment steps and from the X on each badge
    // below (app/actions/contacts/segment-membership.ts). ACTIVE memberships
    // only: `removed_at IS NULL` is the same filter the campaign sender uses to
    // resolve recipients, so what this page shows is exactly who a
    // segment-targeted campaign would reach.
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

  // ── BUYER OVERVIEW DATA ────────────────────────────────────────────────────
  //
  // NINE PROPS WERE HARDCODED [] / null AT THE ONLY MOUNT OF BuyerOverviewClient.
  // Every one of them had a real loader sitting unused, and the component reads
  // them all: the Tours tab said "0 tours on file / No upcoming tours scheduled"
  // for a buyer with tours, while the sibling route /crm/contacts/[id]/tours
  // rendered those same rows correctly. Same data, same page, two answers.
  //
  // Loaded AFTER contact resolves and only when buyer_stage is set — the same
  // condition that mounts the component — so a seller or a sphere contact does
  // not pay for six queries it will never render.
  let buyerTours: any[] = []
  let buyerNextTour: any = null
  let buyerJourney: any = null
  let buyerProfile: any = null
  let buyerDrafts: any[] = []
  let collabSearches: any[] = []
  let activeCollabSearch: any = null
  let collabConsensus: any = null
  // Multi-party update trail: the lender/agent/admin actions that moved this
  // buyer's gates. Loaded with the rest of the buyer block so a seller or sphere
  // contact does not pay for it.
  let buyerUpdates: Array<{
    eventType: string
    actorId: string
    actorRole: string
    timestamp: Date
    metadata: Record<string, unknown>
  }> = []
  let buyerUpdatesError: string | null = null

  if (contact.buyer_stage) {
    const [toursRes, journeyRes, finProfileRes, searchesRes, convRes, updatesRes] = await Promise.all([
      getBuyerTours(contactId),
      getBuyerJourney({ contactId, userId: user.id, source: "agent_action" }),
      supabase
        .from("buyer_financial_profiles")
        .select("id, contact_id, verified, is_cash_buyer, finance_type, pre_approval_amount, updated_at")
        .eq("contact_id", contactId)
        .maybeSingle(),
      getCollaborativeSearches(contactId),
      // The coaching panel drafts hang off a CONVERSATION, not the contact, so
      // resolve the contact's most recent thread first.
      supabase
        .from("conversations")
        .select("id")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
      // Who moved this buyer's gates, and when. The lender confirmation, the
      // admin override, the agent advance and the search reconfiguration each
      // write a `buyer.*` row to `activities` at the moment they happen — and
      // nothing had ever read them back. An agent looking at a buyer whose
      // financing gate had been OVERRIDDEN could not see that it had been, by
      // whom, or on what grounds. This is that trail.
      getBuyerUpdateHistory({ contactId, limit: 25 }),
    ])

    buyerTours = toursRes.success ? (toursRes.tours ?? []) : []

    // A refused or failed read is NOT "no activity". getBuyerUpdateHistory
    // returns {success:false,error} for both, and an empty trail rendered for a
    // refusal would tell the agent nobody has touched this buyer's gates when
    // the truth is we could not look.
    if ((updatesRes as any)?.success) {
      buyerUpdates = ((updatesRes as any).updates ?? []) as typeof buyerUpdates
    } else {
      buyerUpdatesError = ((updatesRes as any)?.error as string) || "Could not load the update trail"
    }

    // NEXT TOUR is derived, not separately queried — one source, so the count and
    // the "next tour" line can never disagree. Soonest tour still ahead of today
    // that has not been cancelled.
    const today = new Date().toISOString().slice(0, 10)
    buyerNextTour =
      buyerTours
        .filter((t: any) => t?.tour_date && t.tour_date >= today && t.status !== "cancelled")
        .sort((a: any, b: any) => String(a.tour_date).localeCompare(String(b.tour_date)))[0] ?? null

    // Pass the STATUS object, not the wrapper: the component reads
    // journey.nextSteps, and BuyerJourneyStatus is what carries it.
    buyerJourney = (journeyRes as any)?.success ? (journeyRes as any).journey : null
    buyerProfile = finProfileRes.data ?? null

    // getCollaborativeSearches returns [] when COLLABORATIVE_SEARCH_ENABLED is
    // off, so an unavailable feature reads as "no searches" rather than an error.
    collabSearches = Array.isArray(searchesRes) ? searchesRes : []
    activeCollabSearch = collabSearches[0] ?? null
    if (activeCollabSearch?.id) {
      const c = await getConsensus(activeCollabSearch.id)
      collabConsensus = Array.isArray(c) && c.length > 0 ? c : null
    }

    const conversationId = (convRes.data as { id: string } | null)?.id
    if (conversationId) {
      const draftsRes = await loadConversationDrafts(conversationId)
      buyerDrafts = draftsRes.success ? (draftsRes.drafts ?? []) : []
    }
  }

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

  // ── THIS CONTACT'S PORTAL EVENT STREAM + UNIFIED MESSAGE THREAD ────────────
  //
  // Two agent-facing reads that existed with no caller anywhere in the tree:
  //
  //   · getAgentPortalStream({ contactId }) — the agent view of
  //     portal_event_stream (agent_copy + suggested action + disposition
  //     state). Its sibling getOpenAgentActions is mounted on the agent
  //     dashboard as a BROKERAGE-WIDE queue, and <AgentActionDispositionQueue>
  //     documents a `compact` mode "used inside a contact's CRM panel" that
  //     nothing rendered. This is that panel: the same three-way disposition,
  //     scoped to the one contact whose record you are looking at.
  //
  //   · getInboxMessages({ contactId }) — the kernel's universal inbox merged
  //     across messages / client_portal_messages / voice_calls / chat /
  //     vendor / ISA lanes for ONE contact. Nothing read it; the app-shell
  //     inbox slide-out reads `conversations` directly and covers only the
  //     conversation-threaded channels.
  //
  // Both actions gate themselves (session + the contact must be in the
  // caller's brokerage) and RETURN their refusals, so a refusal is reported
  // rather than rendered as an empty stream.
  const [portalStreamResult, contactInboxResult, bundlesResult] = await Promise.all([
    getAgentPortalStream({ contactId, limit: 25 }),
    getInboxMessages({ contactId, limit: 25 }),
    // Saved campaign bundles the caller may dispatch. The action resolves the
    // caller's own agent/team/brokerage policy scope, so this list is already
    // narrowed to bundles they are allowed to see.
    listCampaignBundles(),
  ])
  const portalStreamRows = portalStreamResult.success ? (portalStreamResult.rows ?? []) : []
  const portalStreamError = portalStreamResult.success ? null : (portalStreamResult.error ?? "Portal stream unavailable")
  const contactMessages = contactInboxResult.success ? (contactInboxResult.messages ?? []) : []
  const contactInboxError = contactInboxResult.success ? null : (contactInboxResult.error ?? "Messages unavailable")
  const sendableBundles: BundleOption[] = bundlesResult.success
    ? bundlesResult.bundles
        .filter((b) => b.is_active && b.items.length > 0)
        .map((b) => ({ id: b.id, name: b.name, description: b.description, stepCount: b.items.length }))
    : []

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      {/* Route parity: explicit cross-link to the full CRM workspace (portal /
          unified inbox / channel-control tabs live there) — see the verdict in
          the header comment for why this is a link, not a redirect. */}
      <div className="px-4 pt-3">
        <Link
          href={`/crm?contact=${contactId}`}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <PanelsTopLeft className="h-3.5 w-3.5" />
          Open in full CRM workspace (portal, inbox, channels, credit, activity)
        </Link>
      </div>

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

      {/* Segment memberships — opened by the workflow "add to segment" step, and
          closable HERE. The badges used to be read-only, which was the visible
          face of a real defect: contact_segments.removed_at was read by the
          campaign sender and written by nothing, so a contact added to a
          marketing segment received its campaigns forever. */}
      {contactSegments.length > 0 && (
        <SegmentMemberships contactId={contactId} segments={contactSegments} />
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

      {/* This contact's portal event stream — the agent side (agent_copy,
          suggested action, disposition state), with the same Done / Do now /
          AI do it / Dismiss controls the dashboard queue uses. */}
      <div className="px-4 pt-3">
        {portalStreamError ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Portal activity</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-destructive">
                This contact&apos;s portal stream could not be read, so nothing below is a reading of
                it: {portalStreamError}
              </p>
            </CardContent>
          </Card>
        ) : portalStreamRows.length > 0 ? (
          <AgentActionDispositionQueue
            rows={portalStreamRows}
            compact
            title="Portal activity for this contact"
          />
        ) : null}
      </div>

      {/* Unified message thread for this contact — every channel the kernel
          merges (sms / email / voice / portal / chat / vendor / AI ISA), not
          just the conversation-threaded ones. Read-only here; replies go
          through the inbox, which this links to. */}
      <div className="px-4 pt-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Messages</CardTitle>
            <CardDescription>
              Every channel on record for this contact, newest first
            </CardDescription>
          </CardHeader>
          <CardContent>
            {contactInboxError ? (
              <p className="text-sm text-destructive">
                Messages could not be loaded, so this is not a reading of the thread:{" "}
                {contactInboxError}
              </p>
            ) : contactMessages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages on record yet.</p>
            ) : (
              <ol className="space-y-2">
                {contactMessages.slice(0, 12).map((m) => (
                  <li key={`${m.source_table}-${m.id}`} className="rounded-lg border px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge variant="outline" className="text-[11px]">{m.channel}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {m.direction === "inbound" ? "from contact" : "to contact"}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {new Date(m.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-sm line-clamp-3">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Chain runs against this contact — the orchestrator's contact-card surface.
          Without it a run paused on an approval gate had no way to be approved,
          and a failed run no way to be resumed or cancelled. */}
      <div className="px-4 pt-3">
        <WorkflowRunsPanel contactId={contactId} />
      </div>

      {/* Dispatch a saved multi-channel campaign bundle at this contact — the
          send side of the bundle builder, which had none. */}
      <div className="px-4 pt-3">
        <CampaignBundleSendCard contactId={contactId} bundles={sendableBundles} />
      </div>

      {/* Smart drip — enroll this contact into the brokerage's compliance-gated
          sequence of the chosen cadence (restored lane F1; the sequence's steps
          carry the content, so the door is honest about missing sequences). */}
      <div className="px-4 pt-3">
        <SmartDripCard contactId={contactId} />
      </div>

      {/* ── Lane H2: the three contact routes that had no door ─────────────────
          Each is the sole implementation of its capability and each was on the
          census's "route handler nothing in the tree addresses" list. The routes
          stay the implementation — these cards only call them and read what
          comes back. Ordered context-then-action: where this person came from,
          then what you do about it. */}

      {/* Lead lineage — the sole reader of the contact_lead_history view
          (migration 039). NOT the brief's one-sentence provenance line: this is
          a row per lead, with source family/channel/subtype, qualification
          summary and the ISA handoff. */}
      <div className="px-4 pt-3">
        <LeadHistoryCard contactId={contactId} />
      </div>

      {/* Dictate the note after a showing or a call — parsed into a written
          note, a sentiment read and the follow-up tasks the agent actually
          named. Distinct from the hands-free voice COMMAND lane
          (app/actions/voice-assistant.ts), which writes a plain contact_notes
          row; see the card header for that comparison. */}
      <div className="px-4 pt-3">
        <VoiceNoteCard contactId={contactId} />
      </div>

      {/* ISA follow-up / direct mail — compliance-gated outbound. The route's
          own activity description ("Operator triggered direct mail from CRM
          contact record") named this surface; every consent and sender gate
          stays on the server and every refusal is printed. */}
      <div className="px-4 pt-3">
        <IsaOutreachCard contactId={contactId} />
      </div>

      {/* Stated future re-contact date — the suppression the reactivation
          cadences already check for and nothing could set. */}
      <div className="px-4 pt-3">
        <FollowupCard
          contactId={contactId}
          initialFollowupAt={contact.next_followup_at ?? null}
          initialReason={contact.next_followup_reason ?? null}
        />
      </div>

      {/* Enrichment + detected life changes. The enrichment lane has always
          written household income, ownership, social profiles, public/court/
          property records and life events onto the contact row, and none of it
          was displayed anywhere — so a detected divorce or relocation, the whole
          point of the feature, reached no agent. This is that surface, plus the
          two manual controls (enrich now / check for changes) and the
          acknowledgement that stops a change re-surfacing forever. */}
      <div className="px-4 pt-3">
        <EnrichmentPanel contactId={contactId} />
      </div>

      {/* Buyer broker agreement — the NAR 2024 gate that blocks showings and offers
          until an agreement is signed. Draft → send for e-signature → record signature
          → cancel all live here; without it a drafted BBA could never reach `active`. */}
      {contact.buyer_stage && (
        <div className="px-4 pt-3">
          <BuyerBrokerAgreementPanel contactId={contactId} />
        </div>
      )}

      {/* Investor off-market deal finder — buyer-side match against our scraped off-market inventory.
          Regular buyers get MLS matches; investors get off-market. Shown only for investor contacts. */}
      {contact.contact_type === "investor" && (
        <div className="px-4 pt-3">
          <InvestorDealsPanel contactId={contactId} />
        </div>
      )}

      {/* THE WRITER FOR THE CARD BELOW. smart_showing_recommendations had exactly one
          writer in the product — app/actions/ai-predictions.ts:optimizeShowingRoute —
          and it had no caller, so the "AI Showing Plan" card underneath has never had
          a row to render for anyone. This is that caller; see the component header. */}
      {contact.buyer_stage && (
        <div className="px-4 pt-3">
          <ShowingRoutePlanner contactId={contactId} />
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

      {/* ── Gate-change trail ──────────────────────────────────────────────
          Rendered only when there is something to say: a real trail, or a real
          failure to read one. Silence here means "nothing has moved this
          buyer's gates", which is a true and useful answer on its own. */}
      {contact.buyer_stage && (buyerUpdates.length > 0 || buyerUpdatesError) && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Gate changes</CardTitle>
            <CardDescription>
              Lender confirmations, admin overrides and stage advances recorded against this buyer
            </CardDescription>
          </CardHeader>
          <CardContent>
            {buyerUpdatesError ? (
              <p className="text-sm text-destructive">{buyerUpdatesError}</p>
            ) : (
              <ol className="space-y-2">
                {buyerUpdates.map((u, i) => (
                  <li key={`${u.eventType}-${i}`} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {u.eventType.replace(/^buyer\./, "")}
                    </Badge>
                    <span className="text-muted-foreground">
                      {u.actorRole !== "unknown" ? u.actorRole : "actor unrecorded"}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {u.timestamp.toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}

      {contact.buyer_stage ? (
        <BuyerOverviewClient
          buyerId={contactId}
          contact={contact}
          journey={buyerJourney}
          profile={buyerProfile}
          partners={[]}
          drafts={buyerDrafts}
          propertyInterests={interestsResult.data ?? null}
          brokerageId={brokerageId}
          agentUserId={user.id}
          agentName={agentName}
          collaborativeSearches={collabSearches}
          activeSearch={activeCollabSearch}
          consensus={collabConsensus}
          tours={buyerTours}
          nextTour={buyerNextTour}
          dualAgencyListings={[]}
          enabledGates={enabledGates}
          offerAllowed={offerGate.allowed}
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
