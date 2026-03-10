// lib/kernel/portal.ts
// LAYER 0 — Portal-facing display functions.
// Reads milestone timeline and lifetime education track for contact portal.
// Source of truth: lifecycle_events only. Does NOT query activities.

import { createClient } from "@/lib/supabase/server"
import { getEducationDelivery } from "./education"
import { processKernelEvent } from "./notification-engine"
import { KernelEvent } from "./events"
import type { AgeSegment } from "./education"
import type { SupabaseClient } from "@supabase/supabase-js"

// ─── PORTAL VIEW TYPES ────────────────────────────────────────────────────────

export type PortalView = 'buyer' | 'seller' | 'lifetime'

export interface NavItem {
  label: string
  href: string
  icon?: string
}

// ─── PORTAL SHELL KERNEL FUNCTIONS ────────────────────────────────────────────

/**
 * Determines the portal view type for a contact.
 * Decision logic:
 * 1. If buyer_stage = 'BUYER_LIFETIME' → 'lifetime'
 * 2. Else if contact has closed transaction AND no active transaction → 'lifetime'
 * 3. Else if contact_type = 'seller' OR contact has active listing → 'seller'
 * 4. Else → 'buyer'
 */
export async function determinePortalView(
  supabase: SupabaseClient,
  contactId: string
): Promise<PortalView> {
  try {
    // Fetch contact with related data
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("contact_type, buyer_stage, agent_id")
      .eq("id", contactId)
      .single()

    if (contactError || !contact) {
      console.error("[Portal] Contact not found:", contactId)
      return 'buyer' // Default fallback
    }

    // Check for lifetime status via buyer_stage
    if (contact.buyer_stage === 'BUYER_LIFETIME') {
      return 'lifetime'
    }

    // Check for closed transaction with no active transaction
    const { data: transactions } = await supabase
      .from("transactions")
      .select("id, status")
      .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)

    const hasClosedTransaction = transactions?.some(t => 
      t.status === 'closed' || t.status === 'completed'
    )
    const hasActiveTransaction = transactions?.some(t => 
      t.status !== 'closed' && t.status !== 'completed' && t.status !== 'cancelled'
    )

    if (hasClosedTransaction && !hasActiveTransaction) {
      return 'lifetime'
    }

    // Check for seller status
    if (contact.contact_type === 'seller') {
      return 'seller'
    }

    // Check for active listing
    const { data: listings } = await supabase
      .from("listings")
      .select("id, listing_status")
      .eq("contact_id", contactId)
      .in("listing_status", ["active", "pending", "coming_soon"])

    if (listings && listings.length > 0) {
      return 'seller'
    }

    return 'buyer'
  } catch (error) {
    console.error("[Portal] Error determining portal view:", error)
    return 'buyer' // Default fallback on error
  }
}

/**
 * Determines which portal modules are enabled for a contact.
 * Reads from contact_portal_modules table if available.
 * Returns all modules enabled as graceful fallback if table not accessible.
 */
export async function determinePortalModules(
  supabase: SupabaseClient,
  contactId: string
): Promise<Record<string, boolean>> {
  try {
    const { data: modules, error } = await supabase
      .from("contact_portal_modules")
      .select("module_key, is_enabled")
      .eq("contact_id", contactId)

    if (error) {
      // Table may not exist yet — graceful fallback
      console.warn("[Portal] contact_portal_modules not accessible, enabling all modules")
      return {}
    }

    if (!modules || modules.length === 0) {
      return {} // No specific overrides, all enabled by default
    }

    const moduleMap: Record<string, boolean> = {}
    for (const m of modules) {
      moduleMap[m.module_key] = m.is_enabled
    }
    return moduleMap
  } catch (error) {
    console.warn("[Portal] Error fetching portal modules:", error)
    return {} // All enabled by default
  }
}

/**
 * Logs portal access to portal_access_logs table.
 * Emits PORTAL_ACCESSED kernel event.
 * Fails silently if table not accessible.
 */
export async function logPortalAccess(
  supabase: SupabaseClient,
  contactId: string,
  moduleKey: string,
  action: string,
  agentId?: string
): Promise<void> {
  try {
    // Insert access log
    await supabase
      .from("portal_access_logs")
      .insert({
        contact_id: contactId,
        module_key: moduleKey,
        action,
        agent_id: agentId,
        accessed_at: new Date().toISOString(),
      })

    // Emit kernel event
    await processKernelEvent({
      eventType: KernelEvent.PORTAL_ACCESSED,
      entityType: "contact",
      entityId: contactId,
      agentId: agentId ?? null,
      brokerageId: null,
      metadata: { moduleKey, action },
    }).catch(() => {}) // Non-blocking
  } catch (error) {
    // Fail silently — portal_access_logs table may not exist yet
    console.warn("[Portal] Unable to log portal access:", error)
  }
}

/**
 * Builds the navigation items for a portal view.
 * Respects module enable/disable settings.
 */
export function buildPortalNav(
  view: PortalView,
  modules: Record<string, boolean>,
  contactId: string
): NavItem[] {
  const isEnabled = (key: string) => modules[key] !== false

  const basePath = `/portal/${contactId}`

  if (view === 'buyer') {
    const items: NavItem[] = [
      { label: "Home", href: basePath, icon: "home" },
      { label: "My Journey", href: `${basePath}/journey`, icon: "route" },
      { label: "Messages", href: `${basePath}/messages`, icon: "message-square" },
      { label: "Calendar", href: `${basePath}/calendar`, icon: "calendar" },
      { label: "Documents", href: `${basePath}/documents`, icon: "file-text" },
      { label: "Properties", href: `${basePath}/properties`, icon: "building" },
      { label: "Smart Search", href: `${basePath}/search`, icon: "search" },
      { label: "Showings", href: `${basePath}/showings`, icon: "eye" },
      { label: "Offers", href: `${basePath}/offers`, icon: "dollar-sign" },
      { label: "Learn", href: `${basePath}/learn`, icon: "graduation-cap" },
      { label: "My Team", href: `${basePath}/team`, icon: "users" },
      { label: "Vendors", href: `${basePath}/vendors`, icon: "briefcase" },
      { label: "Help", href: `${basePath}/help`, icon: "help-circle" },
    ]
    return items.filter(item => isEnabled(item.label.toLowerCase().replace(/ /g, '_')))
  }

  if (view === 'seller') {
    const items: NavItem[] = [
      { label: "Home", href: basePath, icon: "home" },
      { label: "My Journey", href: `${basePath}/journey`, icon: "route" },
      { label: "Messages", href: `${basePath}/messages`, icon: "message-square" },
      { label: "Calendar", href: `${basePath}/calendar`, icon: "calendar" },
      { label: "Documents", href: `${basePath}/documents`, icon: "file-text" },
      { label: "My Listing", href: `${basePath}/listing`, icon: "home" },
      { label: "Offers", href: `${basePath}/offers`, icon: "dollar-sign" },
      { label: "Insights", href: `${basePath}/insights`, icon: "bar-chart" },
      { label: "Learn", href: `${basePath}/learn`, icon: "graduation-cap" },
      { label: "My Team", href: `${basePath}/team`, icon: "users" },
      { label: "Vendors", href: `${basePath}/vendors`, icon: "briefcase" },
      { label: "Help", href: `${basePath}/help`, icon: "help-circle" },
    ]
    return items.filter(item => isEnabled(item.label.toLowerCase().replace(/ /g, '_')))
  }

  // Lifetime view
  const items: NavItem[] = [
    { label: "Home", href: basePath, icon: "home" },
    { label: "My History", href: `${basePath}/history`, icon: "clock" },
    { label: "Market Updates", href: `${basePath}/market-updates`, icon: "trending-up" },
    { label: "Resources", href: `${basePath}/resources`, icon: "book-open" },
    { label: "Referrals", href: `${basePath}/referrals`, icon: "share-2" },
    { label: "Documents", href: `${basePath}/documents`, icon: "file-text" },
    { label: "Learn", href: `${basePath}/learn`, icon: "graduation-cap" },
    { label: "Help", href: `${basePath}/help`, icon: "help-circle" },
  ]
  return items.filter(item => isEnabled(item.label.toLowerCase().replace(/ /g, '_')))

// ─── PORTAL MILESTONE ─────────────────────────────────────────────────────────

export interface PortalMilestone {
  eventType: string
  description: string
  date: string
  metadata: Record<string, any>
}

// Event types that are system-internal and must never surface to the portal
const EXCLUDED_EVENT_PREFIXES = [
  "lifecycle.noop",
  "system.",
  "internal.",
  "cron.",
  "audit.",
  "compliance.",
]

// Produce a human-readable summary from an event_type string and metadata
function describeEvent(eventType: string, metadata: Record<string, any>): string {
  const type = eventType.toLowerCase()

  // buyer journey
  if (type === "buyer.inquiry")        return "Buyer inquiry submitted"
  if (type === "buyer.pre_approved")   return "Pre-approval obtained"
  if (type === "buyer.touring")        return "Property tours started"
  if (type === "buyer.offer_made")     return `Offer submitted${metadata?.address ? ` on ${metadata.address}` : ""}`
  if (type === "buyer.under_contract") return `Under contract${metadata?.address ? ` — ${metadata.address}` : ""}`
  if (type === "buyer.inspection")     return "Home inspection completed"
  if (type === "buyer.appraisal")      return "Appraisal ordered"
  if (type === "buyer.clear_to_close") return "Clear to close received"
  if (type === "buyer.closed")         return `Purchase closed${metadata?.address ? ` — ${metadata.address}` : ""}`

  // seller journey
  if (type === "seller.inquiry")       return "Seller inquiry submitted"
  if (type === "seller.listed")        return `Property listed${metadata?.address ? ` — ${metadata.address}` : ""}`
  if (type === "seller.offer_received") return "Offer received"
  if (type === "seller.under_contract") return "Property under contract"
  if (type === "seller.inspection")    return "Inspection completed by buyer"
  if (type === "seller.appraisal")     return "Property appraisal completed"
  if (type === "seller.clear_to_close") return "Clear to close received"
  if (type === "seller.closed")        return `Sale closed${metadata?.address ? ` — ${metadata.address}` : ""}`

  // transaction events
  if (type === "transaction.created")       return "Transaction opened"
  if (type === "transaction.docs_sent")     return "Documents sent for signature"
  if (type === "transaction.docs_signed")   return "Documents signed"
  if (type === "transaction.title_ordered") return "Title ordered"
  if (type === "transaction.title_clear")   return "Title cleared"
  if (type === "transaction.closing_scheduled") return `Closing scheduled${metadata?.closing_date ? ` for ${metadata.closing_date}` : ""}`
  if (type === "transaction.closed")        return "Transaction closed"

  // lifecycle. prefix strip
  const label = eventType
    .replace(/^lifecycle\./, "")
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())

  return label
}

// ─── FUNCTION 1: getPortalMilestones ─────────────────────────────────────────

/**
 * Returns the milestone timeline for a contact's portal view.
 * Queries lifecycle_events filtered to buyer.*, seller.*, and transaction.*
 * event types only. System/internal events are excluded.
 * Results are sorted newest-first.
 */
export async function getPortalMilestones(params: {
  contactId: string
}): Promise<PortalMilestone[]> {
  const supabase = await createClient()

  const { data: events, error } = await supabase
    .from("lifecycle_events")
    .select("event_type, metadata, created_at")
    .eq("entity_id", params.contactId)
    .or(
      [
        "event_type.like.buyer.%",
        "event_type.like.seller.%",
        "event_type.like.transaction.%",
      ].join(","),
    )
    .order("created_at", { ascending: false })

  if (error || !events) return []

  const milestones: PortalMilestone[] = []

  for (const evt of events) {
    // Skip system/internal events
    const isExcluded = EXCLUDED_EVENT_PREFIXES.some((prefix) =>
      evt.event_type.startsWith(prefix),
    )
    if (isExcluded) continue

    const metadata = (evt.metadata ?? {}) as Record<string, any>

    milestones.push({
      eventType: evt.event_type,
      description: describeEvent(evt.event_type, metadata),
      date: evt.created_at,
      metadata,
    })
  }

  return milestones
}

// ─── FUNCTION 2: getLifetimeTrack ─────────────────────────────────────────────

export interface LifetimeTrackSegment {
  segment: "pre-journey" | "active-journey" | "post-journey"
  completed: boolean
  lessons: Array<{ title: string; format: string }>
}

type JourneyPhase = "pre" | "active" | "post"

// Determine the contact's current phase by inspecting their lifecycle_events
async function resolveJourneyPhase(
  contactId: string,
): Promise<{ phase: JourneyPhase; journeyType: "buyer" | "seller" }> {
  const supabase = await createClient()

  const { data: events } = await supabase
    .from("lifecycle_events")
    .select("event_type")
    .eq("entity_id", contactId)
    .or("event_type.like.buyer.%,event_type.like.seller.%")
    .order("created_at", { ascending: false })

  if (!events || events.length === 0) {
    return { phase: "pre", journeyType: "buyer" }
  }

  const types = events.map((e) => e.event_type)

  // Determine journey type from first event prefix
  const journeyType: "buyer" | "seller" = types.some((t) => t.startsWith("seller."))
    ? "seller"
    : "buyer"

  // Check for closed event — post phase
  const closedEvent = journeyType === "buyer" ? "buyer.closed" : "seller.closed"
  if (types.includes(closedEvent)) {
    return { phase: "post", journeyType }
  }

  // buyer./seller. events exist but not closed — active phase
  return { phase: "active", journeyType }
}

/**
 * Returns the full lifetime education track for a contact.
 * Derives the current journey phase from lifecycle_events, then builds
 * all three segments (pre / active / post) with lessons from getEducationDelivery.
 * Segments prior to the current phase are marked completed = true.
 */
export async function getLifetimeTrack(params: {
  contactId: string
  persona: string
}): Promise<LifetimeTrackSegment[]> {
  const { phase, journeyType } = await resolveJourneyPhase(params.contactId)

  // Default age segment — actual preference read by getEducationPlan per contact;
  // getEducationDelivery is a static lookup so we pass a neutral default here
  const ageSegment: AgeSegment = "30-50"

  const segments: Array<{ id: "pre-journey" | "active-journey" | "post-journey"; journeyPhase: "pre" | "active" | "post" }> = [
    { id: "pre-journey",    journeyPhase: "pre" },
    { id: "active-journey", journeyPhase: "active" },
    { id: "post-journey",   journeyPhase: "post" },
  ]

  const phaseOrder: Record<JourneyPhase, number> = { pre: 0, active: 1, post: 2 }
  const currentOrder = phaseOrder[phase]

  const track: LifetimeTrackSegment[] = []

  for (const seg of segments) {
    // Delivery config drives which formats are used for this age segment
    const delivery = getEducationDelivery({ ageSegment })
    const segOrder = phaseOrder[seg.journeyPhase]

    // Lessons per segment — sourced from the canonical lesson map in education.ts
    // using the delivery config's primary and secondary formats
    const lessons = buildLessonsForSegment({
      journeyType,
      journeyPhase: seg.journeyPhase,
      persona: params.persona,
      primaryFormat: delivery.primaryFormat,
      secondaryFormat: delivery.secondaryFormat,
    })

    track.push({
      segment: seg.id,
      completed: segOrder < currentOrder,
      lessons,
    })
  }

  return track
}

// ─── LESSON MAP ──────────────────────────────────────────────────────────────

/**
 * Returns a flat list of lesson stubs for a given segment.
 * Titles and formats are derived from the canonical plan; these are not DB rows.
 */
function buildLessonsForSegment(params: {
  journeyType: "buyer" | "seller"
  journeyPhase: "pre" | "active" | "post"
  persona: string
  primaryFormat: string
  secondaryFormat: string
}): Array<{ title: string; format: string }> {
  const { journeyType, journeyPhase, persona, primaryFormat, secondaryFormat } = params

  if (journeyType === "buyer") {
    if (journeyPhase === "pre") {
      return [
        { title: "Are You Ready to Buy?",            format: primaryFormat },
        { title: "Understanding Your Credit Score",  format: secondaryFormat },
        { title: "How Much Home Can You Afford?",    format: primaryFormat },
        { title: "The Pre-Approval Process",         format: primaryFormat },
        { title: "Finding the Right Neighborhood",   format: secondaryFormat },
        ...(persona === "first_time_buyer"
          ? [{ title: "First-Time Buyer Programs",   format: primaryFormat }]
          : []),
        ...(persona === "military"
          ? [{ title: "VA Loan Benefits",            format: primaryFormat }]
          : []),
        ...(persona === "foreclosure"
          ? [{ title: "Buying After Foreclosure",    format: primaryFormat }]
          : []),
      ]
    }

    if (journeyPhase === "active") {
      return [
        { title: "Making a Competitive Offer",       format: primaryFormat },
        { title: "What Happens After Offer Accepted", format: secondaryFormat },
        { title: "Home Inspection Walkthrough",       format: primaryFormat },
        { title: "Appraisal Explained",               format: secondaryFormat },
        { title: "Final Walk-Through Checklist",      format: "checklist" },
        { title: "Closing Day — What to Expect",      format: primaryFormat },
        { title: "Understanding Closing Costs",       format: secondaryFormat },
      ]
    }

    if (journeyPhase === "post") {
      return [
        { title: "Your First Year as a Homeowner",   format: primaryFormat },
        { title: "Home Maintenance Checklist",        format: "checklist" },
        { title: "Building Equity Over Time",         format: secondaryFormat },
        { title: "When to Refinance",                 format: primaryFormat },
        { title: "Referring Friends and Family",      format: primaryFormat },
      ]
    }
  }

  if (journeyType === "seller") {
    if (journeyPhase === "pre") {
      return [
        { title: "Is Now a Good Time to Sell?",       format: primaryFormat },
        { title: "How Your Home is Priced",           format: secondaryFormat },
        { title: "Preparing Your Home for Market",    format: "checklist" },
        { title: "What to Expect from Showings",      format: primaryFormat },
        ...(persona === "divorce"
          ? [{ title: "Selling During a Divorce",     format: primaryFormat }]
          : []),
        ...(persona === "probate"
          ? [{ title: "Probate Sale Overview",        format: primaryFormat }]
          : []),
        ...(persona === "foreclosure"
          ? [{ title: "Avoiding Foreclosure",         format: primaryFormat }]
          : []),
      ]
    }

    if (journeyPhase === "active") {
      return [
        { title: "Reviewing an Offer",                format: primaryFormat },
        { title: "Negotiation Basics",                format: secondaryFormat },
        { title: "Seller Disclosures Explained",      format: primaryFormat },
        { title: "Inspection Response Strategies",    format: secondaryFormat },
        { title: "Timeline to Closing",               format: "checklist" },
        { title: "Moving-Out Checklist",              format: "checklist" },
      ]
    }

    if (journeyPhase === "post") {
      return [
        { title: "Capital Gains Tax Overview",        format: primaryFormat },
        { title: "What to Do With Proceeds",          format: secondaryFormat },
        { title: "Buying Your Next Home",             format: primaryFormat },
        { title: "Staying in Touch With Your Agent",  format: primaryFormat },
      ]
    }
  }

  return []
}
