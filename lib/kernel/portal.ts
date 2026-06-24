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
import { CLIENT_VISIBLE_MILESTONES, MILESTONE_NAMES } from "@/lib/transactions/transaction-stages"
import {
  PortalViewOutput,
  PortalModulesOutput,
  PortalVisibilityOutput,
  NavigationBuildOutput,
  PORTAL_VALIDATION_RULES,
  PORTAL_ERRORS,
  createPortalSuccess,
  createPortalErrorResponse,
  type PortalViewInput,
  type PortalModulesInput,
  type PortalVisibilityInput,
  type NavigationBuildInput,
} from "./portal-contracts"

// ─── PORTAL VIEW TYPES ────────────────────────────────────────────────────────

export type PortalView = 'buyer' | 'seller' | 'lifetime'

export interface NavItem {
  label: string
  href: string
  icon?: string
}

import type { SaleBeforeBuyDependency } from "./dual-intent-linker"
import { journeyUserKey } from "./dual-intent-linker"

/**
 * The dual-journey resolution that sits ON TOP of determinePortalView — it does
 * NOT replace it. determinePortalView still returns the single canonical view
 * (buyer | seller | lifetime) for everyone, unchanged. resolveDualPortalView
 * adds the orthogonal question the single resolver never answered: does this ONE
 * contact carry BOTH journeys (the "must sell to buy" case)? When it does, the
 * page renders a TABBED Buy | Sell portal instead of collapsing to one side.
 */
export interface DualPortalResolution {
  /** True when the contact is genuinely dual (contact_type='both' OR both journey_states sides exist). */
  isDual: boolean
  /** The single-journey view determinePortalView resolves — preserved verbatim for non-dual contacts AND as the dual portal's default tab. */
  baseView: PortalView
  /** Why dual was (or was not) concluded — for logging/debugging. */
  reason: string
  /** The cross-journey sale→buy dependency stamped on the journey_states rows (when dual). */
  dependency: SaleBeforeBuyDependency | null
}

/**
 * dualBannerPredicate — pure: should the page show the "your purchase is
 * contingent on selling your current home" dependency BANNER? Only when the
 * dependency exists, is gating, and is NOT yet satisfied (the sale hasn't closed).
 * A non-gated dependency (cash buyer / independent funding) or a satisfied one
 * (sale already closed) → no banner. Honest when there is no dependency at all.
 */
export function dualBannerPredicate(dependency: SaleBeforeBuyDependency | null): boolean {
  if (!dependency) return false
  return dependency.gated && !dependency.satisfied
}

/**
 * KERNEL CONTRACT: resolveDualPortalView — the additive dual-journey resolver.
 *
 * Runs determinePortalView FIRST (so the single-journey resolution is byte-for-byte
 * unchanged for everyone — buyer/seller/lifetime + every reason code), THEN asks the
 * orthogonal dual question:
 *   · contact_type = 'both'  → dual, OR
 *   · BOTH journey_states sides exist for this contact (`${id}:buyer` AND `${id}:seller`,
 *     the rows the dual-intent linker writes) → dual.
 * Non-dual contacts get { isDual:false, baseView } and the page behaves exactly as before.
 *
 * When dual, it reads the sale→buy dependency the linker stamped into the journey_states
 * metadata_json so the page can surface the gate banner without recomputing anything.
 */
export async function resolveDualPortalView(
  supabase: SupabaseClient,
  input: PortalViewInput
): Promise<DualPortalResolution> {
  // The single-journey resolution is the source of truth for the base view — never altered.
  const base = await determinePortalView(supabase, input)

  // An explicit admin override is a deliberate single-view escape hatch — honor it, never dual.
  if (input.overrideView) {
    return { isDual: false, baseView: base.view, reason: 'ADMIN_OVERRIDE_SINGLE', dependency: null }
  }

  try {
    const { contactId } = input

    // Signal 1 — the canonical dual vocabulary on the contact itself.
    const { data: contact } = await supabase
      .from("contacts")
      .select("contact_type")
      .eq("id", contactId)
      .maybeSingle()
    const contactTypeIsBoth = (contact as any)?.contact_type === 'both'

    // Signal 2 — BOTH journey_states sides exist (the linker's two cross-linked rows).
    const buyerKey = journeyUserKey(contactId, "buyer")
    const sellerKey = journeyUserKey(contactId, "seller")
    const { data: journeys } = await supabase
      .from("journey_states")
      .select("user_id, metadata_json")
      .eq("contact_id", contactId)
      .in("user_id", [buyerKey, sellerKey])

    const jList = (journeys ?? []) as Array<{ user_id: string; metadata_json: string | null }>
    const hasBuyerSide = jList.some(j => j.user_id === buyerKey)
    const hasSellerSide = jList.some(j => j.user_id === sellerKey)
    const hasBothSides = hasBuyerSide && hasSellerSide

    const isDual = contactTypeIsBoth || hasBothSides
    if (!isDual) {
      return { isDual: false, baseView: base.view, reason: 'SINGLE_JOURNEY', dependency: null }
    }

    // Recover the dependency the linker stamped on either side (buyer side preferred —
    // it carries the gate it's gated ON). Read-only; we never recompute or fabricate.
    let dependency: SaleBeforeBuyDependency | null = null
    const preferred = jList.find(j => j.user_id === buyerKey) ?? jList[0]
    if (preferred?.metadata_json) {
      try {
        const meta = JSON.parse(preferred.metadata_json) as { dependency?: SaleBeforeBuyDependency }
        dependency = meta?.dependency ?? null
      } catch {
        dependency = null
      }
    }

    return {
      isDual: true,
      baseView: base.view,
      reason: contactTypeIsBoth ? 'CONTACT_TYPE_BOTH' : 'BOTH_JOURNEY_STATES',
      dependency,
    }
  } catch (error) {
    // Any failure falls back to the single-journey behavior — dual is purely additive.
    console.warn("[Portal] resolveDualPortalView fell back to single view:", error)
    return { isDual: false, baseView: base.view, reason: 'DUAL_RESOLVE_ERROR', dependency: null }
  }
}

// ─── PORTAL SHELL KERNEL FUNCTIONS ────────────────────────────────────────────

/**
 * KERNEL CONTRACT: Determines the portal view type for a contact.
 * 
 * Input: PortalViewInput { contactId }
 * Output: PortalViewOutput { view, reason, buyerStage, isPropertyOwner }
 * 
 * Decision logic:
 * 1. If buyer_stage = 'BUYER_LIFETIME' → 'lifetime'
 * 2. Else if contact has closed transaction AND no active transaction → 'lifetime'
 * 3. Else if contact_type = 'seller' OR contact has active listing → 'seller'
 * 4. Else → 'buyer'
 */
export async function determinePortalView(
  supabase: SupabaseClient,
  input: PortalViewInput
): Promise<PortalViewOutput> {
  try {
    const { contactId, overrideView } = input

    // Override for testing/admin
    if (overrideView) {
      return {
        view: overrideView,
        reason: 'ADMIN_OVERRIDE',
        buyerStage: 'UNKNOWN',
        isPropertyOwner: false,
      }
    }

    // Fetch contact with related data
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("contact_type, buyer_stage, agent_id")
      .eq("id", contactId)
      .maybeSingle()

    if (contactError || !contact) {
      console.error("[Portal] Contact not found:", contactId)
      return {
        view: 'buyer',
        reason: 'DEFAULT_FALLBACK',
        buyerStage: 'UNKNOWN',
        isPropertyOwner: false,
      }
    }

    // Check for lifetime status via buyer_stage
    if (contact.buyer_stage === 'BUYER_LIFETIME') {
      return {
        view: 'lifetime',
        reason: 'BUYER_LIFETIME_STATUS',
        buyerStage: contact.buyer_stage,
        isPropertyOwner: true,
      }
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
      return {
        view: 'lifetime',
        reason: 'CLOSED_TRANSACTION_NO_ACTIVE',
        buyerStage: contact.buyer_stage,
        isPropertyOwner: true,
      }
    }

    // Check for seller status
    if (contact.contact_type === 'seller') {
      return {
        view: 'seller',
        reason: 'SELLER_CONTACT_TYPE',
        buyerStage: contact.buyer_stage,
        isPropertyOwner: false,
      }
    }

    // Check for an active listing where THIS contact is the seller (not merely
    // any listing owned by their agent — that misrouted buyers to the seller view).
    const { data: listings } = await supabase
      .from("listings")
      .select("id, status")
      .eq("seller_contact_id", contactId)
      .in("status", ["active", "pending", "coming_soon"])

    if (listings && listings.length > 0) {
      return {
        view: 'seller',
        reason: 'ACTIVE_LISTING',
        buyerStage: contact.buyer_stage,
        isPropertyOwner: false,
      }
    }

    return {
      view: 'buyer',
      reason: 'DEFAULT_BUYER',
      buyerStage: contact.buyer_stage,
      isPropertyOwner: false,
    }
  } catch (error) {
    console.error("[Portal] Error determining portal view:", error)
    return {
      view: 'buyer',
      reason: 'ERROR_FALLBACK',
      buyerStage: 'UNKNOWN',
      isPropertyOwner: false,
    }
  }
}

/**
 * KERNEL CONTRACT: Determines which portal modules are enabled for a contact.
 * 
 * Input: PortalModulesInput { contactId, view, isPropertyOwner? }
 * Output: PortalModulesOutput { modules, journey, messages, ... }
 * 
 * Reads from contact_portal_modules table if available.
 * Returns all modules enabled as graceful fallback if table not accessible.
 */
export async function determinePortalModules(
  supabase: SupabaseClient,
  input: PortalModulesInput
): Promise<PortalModulesOutput> {
  try {
    const { contactId, view, isPropertyOwner } = input

    // Fetch module overrides from database
    const { data: modules, error } = await supabase
      .from("contact_portal_modules")
      .select("module_key, is_enabled")
      .eq("contact_id", contactId)

    // Build default module map based on view type
    const defaultModules: Record<string, boolean> = {
      journey: true,
      messages: true,
      documents: true,
      buyer_smart_search: view === 'buyer',
      seller_listing_actions: view === 'seller',
      offers: view === 'buyer' || view === 'lifetime',
      showings: view === 'buyer' || view === 'lifetime',
      properties: view === 'buyer',
      calendar: view === 'buyer' || view === 'lifetime',
      education: view === 'buyer',
    }

    // Merge database overrides if available
    if (!error && modules && modules.length > 0) {
      for (const m of modules) {
        defaultModules[m.module_key] = m.is_enabled
      }
    }

    return {
      modules: defaultModules,
      journey: defaultModules.journey,
      messages: defaultModules.messages,
      documents: defaultModules.documents,
      buyer_smart_search: defaultModules.buyer_smart_search,
      seller_listing_actions: defaultModules.seller_listing_actions,
      offers: defaultModules.offers,
      showings: defaultModules.showings,
      properties: defaultModules.properties,
      calendar: defaultModules.calendar,
      education: defaultModules.education,
      reason: error ? 'DEFAULT_FALLBACK' : 'DATABASE_OVERRIDE',
    }
  } catch (error) {
    console.warn("[Portal] Error fetching portal modules:", error)
    return {
      modules: {
        journey: true,
        messages: true,
        documents: true,
        buyer_smart_search: input.view === 'buyer',
        seller_listing_actions: input.view === 'seller',
        offers: true,
        showings: true,
        properties: input.view === 'buyer',
        calendar: true,
        education: input.view === 'buyer',
      },
      journey: true,
      messages: true,
      documents: true,
      buyer_smart_search: input.view === 'buyer',
      seller_listing_actions: input.view === 'seller',
      offers: true,
      showings: true,
      properties: input.view === 'buyer',
      calendar: true,
      education: input.view === 'buyer',
      reason: 'ERROR_FALLBACK',
    }
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
      event: KernelEvent.PORTAL_ACCESSED,
      entityType: "contact",
      entityId: contactId,
      brokerageId: '',
    })
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
}

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

// ─── FUNCTION 1b: PORTAL JOURNEY MILESTONES (transaction_milestones) ───────────
//
// THE KERNEL IS THE DECISION-MAKER for which transaction milestones a CLIENT sees
// on their journey portal. Per the agreed architecture, visibility is decided by
// the STABLE canonical `milestone_type` (∈ CLIENT_VISIBLE_MILESTONES), NOT the
// free-text `milestone_name`. Free-text names diverge across thousands of
// subscription tiers ("Closing Day" vs "Closing Date" vs "Settlement"); reporting
// and supporting the portal on those names would be a maintenance nightmare. The
// canonical milestone_type vocabulary (MILESTONE_NAMES) is small and stable, so the
// portal view, completions, and reporting all key off the SAME identity.
//
// TRANSITION: live rows are not yet backfilled with a canonical milestone_type
// (it currently holds null or a coarse category like "financial"). Those rows fall
// back to the per-row `is_client_visible` flag so nothing regresses while the seed
// is migrated. Once milestone_type carries a canonical MILESTONE_NAMES value, the
// kernel decision takes over automatically — no surface change required.

export interface PortalJourneyMilestone {
  id: string
  transaction_id: string
  milestone_name: string
  milestone_type: string | null
  target_date: string | null
  completed_date: string | null
  status: string
  notes: string | null
  is_client_visible: boolean | null
}

const ALL_CANONICAL_MILESTONE_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(MILESTONE_NAMES),
)
const CLIENT_VISIBLE_MILESTONE_TYPES: ReadonlySet<string> = new Set<string>(
  CLIENT_VISIBLE_MILESTONES,
)

// The minimal row shape the kernel visibility rule reads. Loose (optional
// milestone_type / is_client_visible) so any milestone-row type a caller already
// holds — the portal home pages' fetched rows, the journey reader's rows — satisfies
// it without a projection.
export interface MilestoneVisibilityInput {
  milestone_name: string
  milestone_type?: string | null
  is_client_visible?: boolean | null
}

/**
 * isClientVisibleMilestone — the PURE kernel rule for one milestone row.
 *
 *  1. An explicit agent override (contact_portal_preferences.milestone_overrides)
 *     always wins. Overrides are keyed by canonical milestone_type when present,
 *     else by milestone_name (transition fallback). override === false hides.
 *  2. If milestone_type is a canonical identity, the canonical CLIENT_VISIBLE set
 *     decides — the seed-level is_client_visible flag becomes advisory (the whole
 *     point of moving the decision into the kernel).
 *  3. Otherwise (un-backfilled row), defer to the per-row is_client_visible flag.
 */
export function isClientVisibleMilestone(
  m: MilestoneVisibilityInput,
  overrides: Record<string, boolean> = {},
): boolean {
  const type = m.milestone_type
  const isCanonicalType = type != null && ALL_CANONICAL_MILESTONE_TYPES.has(type)

  // (1) explicit agent override — canonical key first, then name fallback
  const overrideKey =
    type != null && overrides[type] !== undefined ? type : m.milestone_name
  if (overrides[overrideKey] === false) return false

  // (2) kernel decision by canonical milestone_type
  if (isCanonicalType) return CLIENT_VISIBLE_MILESTONE_TYPES.has(type as string)

  // (3) transition fallback for rows without a canonical milestone_type
  return m.is_client_visible !== false
}

/**
 * selectClientMilestones — PURE. Filters a milestone list to the client-visible
 * set using the kernel rule above. Generic so it returns the caller's own row type
 * (it is a filter, not a projection) — portal home pages keep their fetched shape.
 * Unit-tested by the portal simulator.
 */
export function selectClientMilestones<T extends MilestoneVisibilityInput>(
  rows: T[],
  overrides: Record<string, boolean> = {},
): T[] {
  return rows.filter((m) => isClientVisibleMilestone(m, overrides))
}

/**
 * getPortalJourneyMilestones — the single entry point the journey portal calls.
 * Resolves the contact's active transaction (when not supplied), reads ALL of its
 * milestones (the kernel — not the query — decides visibility), applies the agent's
 * per-contact overrides, and returns the client-visible timeline ordered by date.
 */
export async function getPortalJourneyMilestones(
  supabase: SupabaseClient,
  params: { contactId: string; transactionId?: string },
): Promise<PortalJourneyMilestone[]> {
  let transactionId = params.transactionId

  if (!transactionId) {
    const { data: txs } = await supabase
      .from("transactions")
      .select("id")
      .or(`buyer_contact_id.eq.${params.contactId},seller_contact_id.eq.${params.contactId}`)
      .not("status", "in", "(cancelled)")
      .order("created_at", { ascending: false })
      .limit(1)
    transactionId = txs?.[0]?.id
  }

  if (!transactionId) return []

  const [milestonesResult, prefsResult] = await Promise.all([
    supabase
      .from("transaction_milestones")
      .select(
        "id, transaction_id, milestone_name, milestone_type, target_date, completed_date:completed_at, status, notes, is_client_visible",
      )
      .eq("transaction_id", transactionId)
      .order("target_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("contact_portal_preferences")
      .select("milestone_overrides")
      .eq("contact_id", params.contactId)
      .maybeSingle(),
  ])

  if (!milestonesResult.data) return []

  const overrides =
    (prefsResult.data?.milestone_overrides as Record<string, boolean>) ?? {}

  return selectClientMilestones(milestonesResult.data as PortalJourneyMilestone[], overrides)
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
