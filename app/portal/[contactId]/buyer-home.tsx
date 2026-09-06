// app/portal/[contactId]/buyer-home.tsx
// Buyer portal home — extracted verbatim from the page's inline buyer render so
// it can be reused both as the standalone buyer view AND inside the dual-journey
// tabbed portal's "Buy" tab. Takes only { contactId }, exactly like SellerHome /
// LifetimeHome, so the dual tab-switcher can render any of the three the same way.
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { resolveContactOwnerAgent } from "@/lib/identity/resolve-contact-owner"
import { selectClientMilestones } from "@/lib/kernel/portal"
import { getPersonaMessagingGuidelines } from "@/lib/buyer-search/persona-inference"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { OfferStatusCard } from "@/app/components/portal/OfferStatusCard"
import { MilestoneProgressBar, type TransactionMilestone } from "@/app/components/portal/MilestoneProgressBar"
import { PortalLiveFeed } from "@/app/components/portal/PortalLiveFeed"
import { NegotiationMirrorPanel } from "@/app/components/negotiation/negotiation-mirror-panel"
import { MilestoneEducationPanel } from "@/app/components/portal/milestone-education-panel"
import { EducationTutorCard } from "@/app/components/portal/education-tutor-card"
import { ContactVendorToolkitCard } from "@/app/components/portal/ContactVendorToolkitCard"
import { FinancialMeaningCard } from "@/app/components/shared/FinancialMeaningCard"
import { BuyerFinancialUploadCard } from "@/app/components/portal/BuyerFinancialUploadCard"
import { BuyerPulseCard } from "@/app/components/portal/BuyerPulseCard"
import { BuyerBrokerAgreementSignCard } from "@/app/components/portal/BuyerBrokerAgreementSignCard"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent } from "@/app/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar"
import {
  Home,
  Search,
  Calendar,
  FileText,
  MessageSquare,
  BookOpen,
  ArrowRight,
  Bell,
  Clock,
} from "lucide-react"
import { RecentUpdatesFeed } from "./components/RecentUpdatesFeed"
import { ClientActionCard } from "./components/ClientActionCard"
import { isBuyerStage, type BuyerStage } from "@/lib/contacts/buyer-stage"

interface BuyerHomeProps {
  contactId: string
  /** When true the buyer home renders inside the dual tabbed portal's "Buy" tab —
   *  its own welcome header + full-page wrapper are suppressed (the dual shell owns
   *  the page chrome) and the not-found redirect is skipped (the page already
   *  resolved the contact). Standalone (default) keeps the original header. */
  embedded?: boolean
}

export default async function BuyerHome({ contactId, embedded = false }: BuyerHomeProps) {
  const supabase = await createClient()

  // Fetch contact basic info
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, contact_type, buyer_stage, agent_id, contact_persona")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact || contactError) {
    if (embedded) return null
    redirect("/portal?error=contact_not_found")
  }

  // Derive persona guidelines for messaging
  const personaGuidelines = contact.contact_persona
    ? getPersonaMessagingGuidelines(contact.contact_persona as any)
    : getPersonaMessagingGuidelines('first_time_buyer')

  // Get active transaction for this buyer.
  // Schema: transactions has `contract_date` (not under_contract_date) and
  // `purchase_price` (list_price lives on listings, not on transactions).
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status, stage, close_date, contract_date, purchase_price")
    .or(`buyer_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  const activeTransaction = transactions?.[0] ?? null

  // Parallel data fetches
  const [
    milestonesResult,
    dealTeamResult,
    agentResult,
    offersResult,
    showingsResult,
    preferencesResult,
    alertsResult,
    savedPropertiesResult,
    messagesResult,
    educationResult,
    vendorAssignmentsResult,
    financialProfileResult,
    recentUpdatesResult,
  ] = await Promise.all([
    // Milestones from transaction. Schema column is completed_at (NOT
    // completed_date — that variant doesn't exist; previous query silently
    // returned undefined for every milestone's completion date).
    activeTransaction
      ? supabase
          .from("transaction_milestones")
          .select("id, milestone_name, milestone_type, target_date, completed_at, status, is_client_visible")
          .eq("transaction_id", activeTransaction.id)
          .order("target_date", { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] }),
    // Deal team members
    activeTransaction
      ? supabase
          .from("deal_team_members")
          .select("id, member_type, external_name:name, external_company:company, external_phone:phone, external_email:email")
          .eq("transaction_id", activeTransaction.id)
      : Promise.resolve({ data: [] }),
    // Primary agent - resolved outside Promise.all via kernel identity function
    Promise.resolve({ data: null }),
    // Offers. Schema: offers.offer_price (NOT offer_amount — that variant
    // doesn't exist; previous query silently returned undefined for every
    // offer's price). listings.property_address also doesn't exist; the
    // canonical address column is `address`.
    supabase
      .from("offers")
      .select("id, listing_id, transaction_id, offer_price, status, created_at, listing:listings(address)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(10),
    // Showings - use scheduled_at column
    supabase
      .from("showings")
      .select("id, listing_id, scheduled_at, status, listing:listings(address)")
      .eq("contact_id", contactId)
      .order("scheduled_at", { ascending: true })
      .limit(5),
    // Property preferences — schema uses inferred_* (AI-derived from buyer signals)
    supabase
      .from("property_preferences")
      .select("id, inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_zip_codes")
      .eq("contact_id", contactId)
      .maybeSingle(),
    // Property alerts
    supabase
      .from("property_alerts")
      .select("id, alert_name, is_active")
      .eq("contact_id", contactId)
      .eq("is_active", true),
    // Saved properties — canonical table is `saved_properties` (NOT
    // `property_interests`, which holds search criteria not saved listings).
    supabase
      .from("saved_properties")
      .select("id, listing_id, external_property_id, source, listing_url, saved_at, notes, list_price, bedrooms, bathrooms, primary_photo_url, property_address, city, state")
      .eq("contact_id", contactId)
      .eq("dismissed", false)
      .order("saved_at", { ascending: false })
      .limit(4),
    // Messages
    supabase
      .from("client_portal_messages")
      .select("id, body, direction, read_at, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(3),
    // Education - resolved outside Promise.all via learning_assignments
    Promise.resolve({ data: [] }),
    // Vendor assignments. `vendors` has NO business_name / vendor_type — the
    // live columns are `name` and `category` (m355 absorbed vendor_directory
    // into vendors, so there is no other relation those names belonged to).
    // PostgREST rejected the whole query. Aliased to the same keys
    // app/actions/portal-seller.ts:getSellerVendors returns, so both portals
    // hand the render an identical vendor shape.
    activeTransaction
      ? supabase
          .from("vendor_assignments")
          .select("id, vendor_id, assignment_type, status, scheduled_date, vendor:vendors(id, business_name:name, vendor_type:category)")
          .eq("transaction_id", activeTransaction.id)
          .limit(3)
      : Promise.resolve({ data: [] }),
    // Buyer financial profile
    supabase
      .from("buyer_financial_profiles")
      .select("pre_approval_amount, down_payment_percent, finance_type, is_cash_buyer")
      .eq("contact_id", contactId)
      .maybeSingle(),
    // Recent transparency updates — kernel fan-out writes here when
    // milestones fire (LISTING_UNDER_CONTRACT, OFFER_ACCEPTED, etc.)
    supabase
      .from("transparency_updates")
      .select("id, title, plain_language_summary, message, next_step, next_step_date, responsible_party, responsible_party_name, update_type, is_visible_to_client, created_at, transaction_id, metadata")
      .eq("contact_id", contactId)
      .eq("is_visible_to_client", true)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  // Resolve agent via kernel identity function (fixes broken contact.agent_id → agents.id lookup)
  const agentInfo = contact.agent_id
    ? await resolveContactOwnerAgent(supabase, contact.agent_id)
    : null

  // National "Buyer Pulse" — what fellow buyers are prioritizing now, distilled (buyer lens) from the
  // SAME weekly market_pulse row the seller portal reads. Net-new buyer-engagement surface; reuses the
  // scraper + gateway + table (no new infra). Renders nothing until the weekly pulse exists.
  // Same provenance line as the seller card (listing/page.tsx): generated_at
  // and source_count from market-pulse-runner.ts:51 say when and from how
  // many threads; insights.generated===false marks the evergreen fallback.
  const { data: pulseRow } = await supabase
    .from("market_pulse")
    .select("insights, generated_at, source_count")
    .eq("scope", "national")
    .order("pulse_week", { ascending: false })
    .limit(1)
    .maybeSingle()
  const buyerPulse = (pulseRow?.insights as Record<string, unknown> | null) ?? null
  const buyerPulseHasInsights = Array.isArray(buyerPulse?.insights) && (buyerPulse!.insights as unknown[]).length > 0
  const buyerPulseGeneratedAt = (pulseRow?.generated_at as string | null) ?? null
  const buyerPulseSourceCount = typeof pulseRow?.source_count === "number" ? (pulseRow.source_count as number) : 0
  const buyerPulseIsDistilled = buyerPulse?.generated !== false

  // Buyer broker agreement awaiting THIS buyer's signature. NAR 2024 blocks
  // showings and offers until one is active (lib/buyer-broker/gate.ts fails
  // closed), and the click-through path is the one most buyers take.
  const { data: unsignedAgreement, error: unsignedAgreementError } = await supabase
    .from("buyer_broker_agreements")
    .select("id, agreement_type, commission_percentage, commission_flat_amount, commission_payer, expiration_date")
    .eq("buyer_contact_id", contactId)
    .in("status", ["draft", "pending_signature"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (unsignedAgreementError) {
    console.error("[buyer-home] unsigned BBA lookup failed:", unsignedAgreementError.message)
  }

  // Post-1043: completion is on learning_assignments (status='completed').
  // The variable name "completedLessonKeys" is kept for downstream stability
  // but the values are now learning_modules.id (uuids).
  let completedLessonKeys: string[] = []
  try {
    const { data: completedAssignments } = await supabase
      .from("learning_assignments")
      .select("module_id")
      .eq("contact_id", contactId)
      .eq("status", "completed")

    completedLessonKeys = (completedAssignments as Array<{ module_id: string }> | null)?.map(a => a.module_id) ?? []
  } catch {
    completedLessonKeys = []
  }

  // Client-visible milestones — the KERNEL decides (by canonical milestone_type,
  // with the is_client_visible flag as the transition fallback). Single source of
  // truth: lib/kernel/portal.ts. Filtering here on milestone_name vs the canonical
  // snake_case set silently dropped every human-named live milestone.
  const milestones = selectClientMilestones<TransactionMilestone>((milestonesResult.data ?? []) as TransactionMilestone[])

  const dealTeamMembers = dealTeamResult.data ?? []
  const primaryAgent = agentInfo
  const offers = offersResult.data ?? []
  const showings = showingsResult.data ?? []
  const preferences = preferencesResult.data
  const alerts = alertsResult.data ?? []
  const savedProperties = savedPropertiesResult.data ?? []
  const messages = messagesResult.data ?? []
  const hasCompletedLessons = completedLessonKeys.length > 0
  // Destructured via the settled result — supabase-js RESOLVES a refused read,
  // so without this a denial is indistinguishable from "no vendors assigned".
  // NOTE: `vendorAssignments` is currently read by nothing in this render; the
  // buyer's vendor surface is <ContactVendorToolkitCard/> below, which fetches
  // its own data. The query is left correct rather than deleted so the block it
  // was fetched for can be wired up without re-deriving the shape.
  const vendorAssignmentsError = (vendorAssignmentsResult as any).error ?? null
  if (vendorAssignmentsError) {
    console.error("[buyer-home] vendor assignments read failed:", vendorAssignmentsError.message ?? vendorAssignmentsError)
  }
  const vendorAssignments = vendorAssignmentsResult.data ?? []
  const financialProfile = financialProfileResult.data ?? null
  const recentUpdates = (recentUpdatesResult as any).data ?? []

  // Computed values
  const contactName = contact.first_name || "there"
  const unreadMessageCount = messages.filter((m: any) => m.direction === "outbound" && !m.read_at).length
  const upcomingShowings = showings.filter((s: any) => new Date(s.scheduled_at) >= new Date())

  // Calculate days under contract if applicable
  let daysUnderContract: number | null = null
  if (activeTransaction?.contract_date) {
    const contractDate = new Date(activeTransaction.contract_date)
    const today = new Date()
    daysUnderContract = Math.floor((today.getTime() - contractDate.getTime()) / (1000 * 60 * 60 * 24))
  }

  // Stage meaning map for buyer journey.
  //
  // TOTAL over the ladder (lib/contacts/buyer-stage.ts:32 — the canonical
  // contacts.buyer_stage vocabulary), so `tsc` refuses a stage with no copy. It
  // used to be `Record<string, …>` with eight of the thirteen states filled in,
  // and the five it omitted — SEARCH_CONFIGURED, SEARCHING, ON_HOLD, DISENGAGED,
  // LIFETIME — silently fell through to the generic "Your Journey" placeholder.
  const STAGE_MEANING: Record<BuyerStage, { headline: string; whatMeans: string; whatNext: string; responsible: string }> = {
    BUYER_CONTACT_CREATED: {
      headline: 'Getting Started',
      whatMeans: "You've been connected with your agent. They're ready to help you find your perfect home.",
      whatNext: "Your agent will reach out to understand your needs and get you set up for success.",
      responsible: 'Your Agent',
    },
    BUYER_FINANCIALLY_VERIFIED: {
      headline: 'Financially Ready',
      whatMeans: "Your purchasing power is confirmed. This gives you a real competitive advantage when you find the right home.",
      whatNext: "Now it's time to search — you can make offers immediately when you find the one.",
      responsible: 'You + Your Agent',
    },
    BUYER_SEARCH_CONFIGURED: {
      headline: 'Your Search Is Set',
      whatMeans: "Your criteria are saved, so new listings that match get to you first instead of after everyone else has seen them.",
      whatNext: "Browse your AI picks and save the ones worth a closer look — your agent works from what you save.",
      responsible: 'You + Your Agent',
    },
    BUYER_SEARCHING: {
      headline: 'Actively Searching',
      whatMeans: "You're reviewing homes as they come on. This is where a clear yes-or-no on each one moves things fastest.",
      whatNext: "Tell your agent which homes you want to see and they'll get showings on the calendar.",
      responsible: 'You + Your Agent',
    },
    BUYER_TOUR_ELIGIBLE: {
      headline: 'Ready to Tour',
      whatMeans: "You're cleared to start visiting homes. Your agent will coordinate showings that match your criteria.",
      whatNext: "Browse saved homes and build your tour list. Your agent will schedule the best times.",
      responsible: 'You + Your Agent',
    },
    BUYER_TOURING: {
      headline: 'Actively Touring',
      whatMeans: "You're seeing homes and gathering real information about what you want. Every showing teaches us more.",
      whatNext: "After each tour, your agent will collect your feedback and sharpen the search.",
      responsible: 'You + Your Agent',
    },
    BUYER_OFFER_ELIGIBLE: {
      headline: 'Ready to Make an Offer',
      whatMeans: "You're positioned to move quickly on the right home. Being ready is a real advantage.",
      whatNext: "When you find the right home, your agent can prepare and submit an offer quickly.",
      responsible: 'Your Agent',
    },
    BUYER_OFFER_SUBMITTED: {
      headline: 'Offer Submitted',
      whatMeans: "Your offer is in the seller's hands. Your agent will keep you updated as soon as there's a response.",
      whatNext: "The seller typically responds within 24–48 hours. Stay ready to negotiate.",
      responsible: 'Seller + Listing Agent',
    },
    BUYER_UNDER_CONTRACT: {
      headline: 'Under Contract!',
      whatMeans: "The seller accepted your offer. You're now in the due diligence period — this is when we verify everything.",
      whatNext: "Inspection, appraisal, and financing are the key milestones ahead. Your team is on it.",
      responsible: 'Your Agent + Team',
    },
    BUYER_ON_HOLD: {
      headline: 'On Hold',
      whatMeans: "Your search is paused. Nothing is lost — your saved homes, criteria and history are all still here.",
      whatNext: "Message your agent whenever you're ready to pick it back up.",
      responsible: 'You',
    },
    BUYER_DISENGAGED: {
      headline: 'Search Paused',
      whatMeans: "We haven't heard from you in a while, so your agent has stopped sending new homes rather than filling your inbox.",
      whatNext: "One message restarts everything exactly where you left off.",
      responsible: 'You',
    },
    BUYER_CLOSED: {
      headline: "You're a Homeowner!",
      whatMeans: "Congratulations — the home is yours. Your agent stays in your corner as a trusted resource for years ahead.",
      whatNext: "Move in, get settled, and know your agent is always here if you need anything.",
      responsible: 'You',
    },
    BUYER_LIFETIME: {
      headline: 'Your Agent, For Life',
      whatMeans: "You're settled in. Your agent keeps an eye on your home's value and the market around it so you're never guessing.",
      whatNext: "Ask anything — a value check, a vendor recommendation, or when it makes sense to move again.",
      responsible: 'Your Agent',
    },
  }

  // isBuyerStage narrows before the lookup, so a row carrying a stage the ladder
  // does not know (a widened CHECK the cache has not absorbed) falls through to
  // the generic copy instead of indexing the map with an unknown key.
  const stageCtx = (isBuyerStage(contact.buyer_stage) ? STAGE_MEANING[contact.buyer_stage] : undefined) || {
    headline: 'Your Journey',
    whatMeans: "Your agent is working to make this process smooth and successful for you.",
    whatNext: "Check in with your agent to understand the current status.",
    responsible: 'Your Agent',
  }

  // Persona wording adjustment — uses getPersonaMessagingGuidelines output
  const personaNote = personaGuidelines.examplePhrases[0] || null
  const personaEmphasis = personaGuidelines.emphasisOn[0] || null

  const body = (
      <div className={embedded ? "max-w-2xl mx-auto px-4 pt-2 pb-12 space-y-5" : "max-w-2xl mx-auto px-4 -mt-4 pb-12 space-y-5"}>

        {/* Recent updates feed — populated by kernel event fan-out (offer
            accepted, listing under contract, milestone completed, etc.).
            Hidden when there's nothing client-visible yet so the home
            doesn't show an empty state on day one. */}
        <RecentUpdatesFeed
          contactId={contactId}
          updates={recentUpdates}
          hideWhenEmpty
        />

        {/* What's Next For You — prominent action panel */}
        <div className="rounded-xl border bg-slate-50 p-5">
          <h2 className="font-semibold text-base mb-1 text-foreground">{"What's Next For You"}</h2>
          <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{stageCtx.whatNext}</p>
          <div className="flex flex-wrap gap-2">
            {/* THREE PHANTOM STAGES. These branches used to compare buyer_stage against
                BUYER_RESEARCHING, BUYER_ACTIVELY_SEARCHING and BUYER_PREPARING_TO_CLOSE —
                none of which contacts_buyer_stage_check admits, so no buyer has ever seen
                one of these buttons and the panel showed only "Message My Agent". Repointed
                to the canonical ladder (lib/contacts/buyer-stage.ts:32):
                  BUYER_RESEARCHING        → BUYER_SEARCH_CONFIGURED  (criteria saved, browsing)
                  BUYER_ACTIVELY_SEARCHING → BUYER_SEARCHING          (same state, real spelling)
                  BUYER_PREPARING_TO_CLOSE → folded into BUYER_UNDER_CONTRACT; the ladder has
                                             no separate closing-prep state for a buyer, and
                                             documents + closing checklist are exactly what
                                             an under-contract buyer needs. */}
            {contact.buyer_stage === 'BUYER_SEARCH_CONFIGURED' && (
              <Button size="sm" asChild>
                <Link href={`/portal/${contactId}/properties`}>Browse AI Picks</Link>
              </Button>
            )}
            {contact.buyer_stage === 'BUYER_SEARCHING' && (
              <>
                <Button size="sm" asChild>
                  <Link href={`/portal/${contactId}/properties`}>Browse AI Picks</Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/portal/${contactId}/showings`}>View My Showings</Link>
                </Button>
              </>
            )}
            {(contact.buyer_stage === 'BUYER_TOURING' || contact.buyer_stage === 'BUYER_TOUR_ELIGIBLE') && (
              <Button size="sm" asChild>
                <Link href={`/portal/${contactId}/showings`}>View My Showings</Link>
              </Button>
            )}
            {(contact.buyer_stage === 'BUYER_OFFER_ELIGIBLE' || contact.buyer_stage === 'BUYER_OFFER_SUBMITTED') && (
              <Button size="sm" asChild>
                <Link href={`/portal/${contactId}/my-offer`}>My Offers</Link>
              </Button>
            )}
            {contact.buyer_stage === 'BUYER_UNDER_CONTRACT' && (
              <>
                <Button size="sm" asChild>
                  <Link href={`/portal/${contactId}/journey`}>Track My Journey</Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/portal/${contactId}/documents`}>My Documents</Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/portal/${contactId}/learn`}>Closing Checklist</Link>
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" asChild>
              <Link href={`/portal/${contactId}/messages`}>Message My Agent</Link>
            </Button>
          </div>
        </div>

        {/* CLIENT-AS-ACTOR (manager-registry.ts:778) — the buyer makes a real
            request (tour a home, find more homes) that flows into the SAME
            manager bench + BBA/approval gates the agent uses, via the gated
            /api/portal/client-action route. Sits beside "What's Next" because
            it IS the next step made actionable. */}
        <ClientActionCard contactId={contactId} audience="buyer" />

        {/* Your Agent Is Working On — transparency section */}
        {activeTransaction && (
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Your Agent Is Working On
            </p>
            {milestones.filter((m: any) => m.status === 'pending').length > 0 ? (
              milestones.filter((m: any) => m.status === 'pending').slice(0, 2).map((m: any) => (
                <div key={m.id} className="flex items-center gap-2 text-sm py-1">
                  <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-foreground">{m.milestone_name?.replace(/_/g, ' ')}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">All milestones are on track</p>
            )}
          </div>
        )}

        {/* Sprint 8 — Negotiation mirror: when an open negotiation strategy
            exists for this contact, show the AI's plain-language explanation
            of what's happening (same data the agent is looking at). Hides
            on empty. */}
        <NegotiationMirrorPanel contactId={contactId} />

        {/* Milestone-gated education (Sprint 7 + migration 1049). Surfaces
            authored learning_modules whose gated_until_milestone matches
            the contact's current milestone (or any earlier one). Locked
            previews show what unlocks next. Hides on empty. */}
        <MilestoneEducationPanel contactId={contactId} />
        <EducationTutorCard contactId={contactId} />

        {/* What This Means — persona-aware */}
        <Card className="shadow-lg border-0">
          <CardContent className="p-5 space-y-4">
            <div>
              <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">What This Means</p>
              <p className="text-sm text-foreground leading-relaxed">{stageCtx.whatMeans}</p>
              {personaNote && (
                <p className="text-xs text-muted-foreground mt-1 italic">{personaNote}</p>
              )}
              {personaEmphasis && (
                <p className="text-xs text-blue-700 mt-1">Focus: {personaEmphasis}</p>
              )}
            </div>
            <div className="border-t pt-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">What Happens Next</p>
              <p className="text-sm text-muted-foreground leading-relaxed">{stageCtx.whatNext}</p>
              <Badge variant="outline" className="text-xs">Responsible: {stageCtx.responsible}</Badge>
            </div>
            {/* Live event stream — every translated kernel event for this
                 contact. Surfaces on every persona's portal automatically. */}
            <PortalLiveFeed contactId={contactId} limit={10} compact hideWhenEmpty />

            {activeTransaction && milestones.length > 0 && (
              <div className="border-t pt-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Milestone Progress</p>
                <MilestoneProgressBar milestones={milestones} contactId={contactId} />
                {activeTransaction.close_date && (
                  <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" />
                    Target closing: {new Date(activeTransaction.close_date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Financial Meaning Card — only renders if real financial data exists */}
        {financialProfile && (
          <FinancialMeaningCard
            financeType={financialProfile.finance_type}
            preApprovalAmount={financialProfile.pre_approval_amount}
            downPaymentPercent={financialProfile.down_payment_percent}
            isCashBuyer={financialProfile.is_cash_buyer}
            personaTone={personaGuidelines.greetingStyle}
            teamHref={`/portal/${contactId}/team`}
          />
        )}

        {/* Buyer self-serve financial upload — pre-approval / POF / lender connect.
            Auto-renders for buyer view; auth-gated to the contact's own portal user. */}
        <BuyerFinancialUploadCard contactId={contactId} />

        {/* Buyer representation agreement awaiting signature — click-through e-sign. */}
        {unsignedAgreement && (
          <BuyerBrokerAgreementSignCard
            agreementId={unsignedAgreement.id}
            agreementType={unsignedAgreement.agreement_type ?? null}
            commissionLine={
              unsignedAgreement.commission_percentage != null
                ? `Compensation: ${unsignedAgreement.commission_percentage}% paid by ${unsignedAgreement.commission_payer ?? "the party named in the document"}.`
                : unsignedAgreement.commission_flat_amount != null
                  ? `Compensation: $${Number(unsignedAgreement.commission_flat_amount).toLocaleString()} paid by ${unsignedAgreement.commission_payer ?? "the party named in the document"}.`
                  : "Compensation terms are set out in the document."
            }
            expirationDate={unsignedAgreement.expiration_date ?? null}
            agentName={primaryAgent?.full_name ?? null}
          />
        )}

        {/* Immediate needs */}
        {(upcomingShowings.length > 0 || offers.filter((o:any) => ['pending','countered'].includes(o.status)).length > 0) && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">Needs Your Attention</p>
            {upcomingShowings.slice(0,2).map((s:any) => (
              <Card key={s.id} className="border-blue-200 bg-blue-50">
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Upcoming Showing</p>
                    <p className="text-xs text-muted-foreground">{s.listing?.address || s.listing?.property_address}</p>
                    <p className="text-xs text-blue-700 font-medium">
                      {new Date(s.scheduled_at).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                    </p>
                  </div>
                  <Link href={`/portal/${contactId}/showings`}>
                    <Button size="sm" variant="outline" className="text-xs">View</Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
            {offers.filter((o:any) => ['pending','countered'].includes(o.status)).map((offer:any) => (
              <Card key={offer.id} className="border-amber-200 bg-amber-50">
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Offer Needs Attention</p>
                    <p className="text-xs text-muted-foreground">{offer.listing?.address || offer.listing?.property_address}</p>
                    <Badge variant="secondary" className="text-xs mt-1">{offer.status}</Badge>
                  </div>
                  <Link href={`/portal/${contactId}/my-offer`}>
                    <Button size="sm" className="text-xs bg-amber-600 hover:bg-amber-700 text-white">View Offer</Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/*
          THE BUYER'S OWN OFFER LEDGER. OfferStatusCard
          (app/components/portal/OfferStatusCard.tsx:76) was imported by this page
          and rendered by nothing — a built component with no surface. The strip
          above it only ever shows offers in `pending`/`countered`, so a buyer
          whose offer was submitted, countered-and-withdrawn, expired or ACCEPTED
          saw no record of it anywhere on their home screen; the accepted case is
          the one that matters most and the one the card leads with.

          COLUMN NAMES ARE MAPPED, NOT ASSUMED. The query above selects
          `offer_price` because that is the live column (see the note at the
          select); the card's Offer contract says `offer_amount`. Handing the raw
          row over would have rendered "N/A" for every price — the card would
          have looked wired and been wrong.
        */}
        <OfferStatusCard
          contactId={contactId}
          offers={(offers as any[]).map((o) => ({
            id: o.id,
            listing_id: o.listing_id ?? null,
            transaction_id: o.transaction_id ?? null,
            offer_amount: o.offer_price ?? null,
            status: o.status,
            created_at: o.created_at,
            listing: o.listing ?? null,
          }))}
        />

        {/* Journey navigation */}
        <div>
          <p className="text-sm font-semibold mb-3">Your Journey</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { href:`/portal/${contactId}/search`, icon:'Search', label:'Find Homes', sub: savedProperties.length>0 ? `${savedProperties.length} saved`:'Search properties' },
              { href:`/portal/${contactId}/messages`, icon:'MessageSquare', label:'Messages', sub: unreadMessageCount>0 ? `${unreadMessageCount} unread`:'Talk to your team' },
              { href:`/portal/${contactId}/documents`, icon:'FileText', label:'Documents', sub:'View and sign' },
              { href:`/portal/${contactId}/learn`, icon:'BookOpen', label:'Learn This Step', sub: hasCompletedLessons ? `${completedLessonKeys.length} lessons done`:'Education for you' },
            ].map(item => (
              <Link key={item.href} href={item.href}>
                <Card className="hover:shadow-md transition-all cursor-pointer border hover:border-blue-300">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.sub}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>

        {/* Saved homes */}
        {savedProperties.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold">Your Saved Homes</p>
              <Link href={`/portal/${contactId}/properties`} className="text-xs text-blue-600">See all</Link>
            </div>
            <div className="space-y-2">
              {savedProperties.slice(0,2).map((p:any) => {
                // EVERY saved home — in-house OR external (RentCast/IDX) — opens OUR in-portal
                // property page (keyed by saved_properties.id, p.id), where the buyer's self-serve
                // tools live (affordability + "help me make an offer" → signals the agent). External
                // saves carry their source URL as a "view full listing" link INSIDE that page, so
                // the buyer self-qualifies in OUR portal instead of leaking to a competitor's.
                const isExternal = !p.listing_id && (!!p.external_property_id || !!p.listing_url)
                return (
                  <Link key={p.id} href={`/portal/${contactId}/properties/${p.id}`}>
                    <Card className="hover:shadow-md transition-all cursor-pointer">
                      <CardContent className="p-3 flex items-center gap-3">
                        {p.primary_photo_url ? (
                          <img src={p.primary_photo_url} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
                        ) : (
                          <div className="w-12 h-12 rounded bg-muted flex items-center justify-center shrink-0">
                            <Home className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{p.property_address}</p>
                          {p.list_price && <p className="text-xs text-muted-foreground">${(p.list_price/1000).toFixed(0)}K{p.bedrooms ? ` - ${p.bedrooms} bed` : ''}{isExternal && p.source ? ` · ${p.source}` : ''}</p>}
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 ml-auto" />
                      </CardContent>
                    </Card>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Buyer Pulse — community sentiment (buyer lens) from the weekly national market_pulse.
             Arms the buyer with what fellow buyers prioritize so they search + compete with confidence. */}
        <BuyerPulseCard pulse={buyerPulse as any} />
        {buyerPulseHasInsights && buyerPulseGeneratedAt && (
          <p className="text-[11px] text-muted-foreground px-1 -mt-4">
            Pulse as of {new Date(buyerPulseGeneratedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            {buyerPulseIsDistilled && buyerPulseSourceCount > 0
              ? ` · distilled from ${buyerPulseSourceCount} buyer-forum thread${buyerPulseSourceCount === 1 ? "" : "s"}`
              : " · evergreen guidance (too few fresh threads to distill this week)"}
          </p>
        )}

        {/* Agent Contact Card */}
        {agentInfo && (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Your Agent</p>
              <div className="flex items-center gap-4">
                <Avatar className="h-14 w-14 shrink-0">
                  <AvatarImage src={agentInfo.profile_image_url ?? undefined} alt={agentInfo.full_name ?? "Agent"} />
                  <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">
                    {agentInfo.full_name ? agentInfo.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase() : "AG"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground truncate">{agentInfo.full_name || "Your Agent"}</p>
                  {agentInfo.email && (
                    <p className="text-xs text-muted-foreground truncate">{agentInfo.email}</p>
                  )}
                  {agentInfo.phone_mobile && (
                    <p className="text-xs text-muted-foreground">{agentInfo.phone_mobile}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <Link href={`/portal/${contactId}/messages`} className="flex-1">
                  <Button size="sm" className="w-full gap-1.5 text-xs">
                    <MessageSquare className="h-4 w-4" />
                    Send Message
                  </Button>
                </Link>
                {agentInfo.phone_mobile ? (
                  <a href={`tel:${agentInfo.phone_mobile}`} className="flex-1">
                    <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs">
                      <Calendar className="h-4 w-4" />
                      Schedule Call
                    </Button>
                  </a>
                ) : (
                  <Link href={`/portal/${contactId}/messages`} className="flex-1">
                    <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs">
                      <Calendar className="h-4 w-4" />
                      Schedule Call
                    </Button>
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Buyer Toolkit — persona+stage-filtered marketplace preview.
             Surfaces lender / inspector / home-warranty / movers / etc.
             tagged for the buyer's persona + current deal stage. */}
        <ContactVendorToolkitCard contactId={contactId} portalView="buyer" />

        {/* My Team */}
        <DealTeamCard
          primaryAgent={primaryAgent ? {
            id: primaryAgent.id,
            first_name: primaryAgent.full_name?.split(" ")[0] ?? null,
            last_name: primaryAgent.full_name?.split(" ").slice(1).join(" ") ?? null,
            phone: primaryAgent.phone_mobile,
            email: primaryAgent.email,
            profile_photo_url: primaryAgent.profile_image_url,
          } : null}
          teamMembers={dealTeamMembers as any[]}
        />

        {/* Property alerts */}
        {alerts.length > 0 && (
          <Card className="bg-emerald-50 border-emerald-200">
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-emerald-900">{alerts.length} Active Property Alert{alerts.length>1?'s':''}</p>
                <p className="text-xs text-emerald-700">New homes matching your criteria are being tracked</p>
              </div>
              <Link href={`/portal/${contactId}/search`}>
                <Button size="sm" variant="outline" className="border-emerald-400 text-xs">View Alerts</Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {/* Education nudge */}
        {!hasCompletedLessons && (
          <Card className="bg-amber-50 border-amber-200">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <BookOpen className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-900">Understand Every Step</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Short lessons explain exactly what is happening at each stage of your journey.
                  </p>
                  <Link href={`/portal/${contactId}/learn`}>
                    <Button size="sm" className="mt-2 bg-amber-600 hover:bg-amber-700 text-white text-xs">
                      Start Learning
                    </Button>
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Help */}
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Have a Question?</p>
              <p className="text-xs text-muted-foreground">Your team responds quickly</p>
            </div>
            <Link href={`/portal/${contactId}/help`}>
              <Button size="sm" variant="outline">Get Help</Button>
            </Link>
          </CardContent>
        </Card>

      </div>
  )

  // Embedded (inside the dual tabbed portal's Buy tab): the dual shell owns the
  // page chrome + header, so return just the buyer body.
  if (embedded) return body

  // Standalone buyer portal — the original full-page render with welcome header.
  return (
    <div className="min-h-screen bg-background">

      {/* Personalized portal header */}
      <div className="bg-gradient-to-br from-blue-700 via-indigo-700 to-blue-800 text-white px-6 pt-8 pb-10">
        <div className="max-w-2xl mx-auto">
          <p className="text-blue-200 text-sm font-medium mb-1">Welcome back</p>
          <h1 className="text-2xl font-bold">{contactName}</h1>
          <div className="inline-flex items-center gap-1.5 mt-2 bg-white/10 rounded-full px-3 py-1">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-sm text-white font-medium">{stageCtx.headline}</span>
          </div>
          {unreadMessageCount > 0 && (
            <div className="mt-3 bg-amber-500/20 border border-amber-400/30 rounded-lg px-3 py-2 flex items-center gap-2">
              <Bell className="h-4 w-4 text-amber-300 shrink-0" />
              <p className="text-sm text-amber-100">
                {unreadMessageCount} new message{unreadMessageCount > 1 ? 's' : ''} from your team
              </p>
            </div>
          )}
        </div>
      </div>

      {body}
    </div>
  )
}
