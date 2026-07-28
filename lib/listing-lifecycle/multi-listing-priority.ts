/**
 * System 5.2: Listing Lifecycle Core - Multi-Listing Seller Prioritization
 * 
 * GOVERNANCE PATCH: Multi-listing priority resolver
 * 
 * When a contact has multiple listings:
 * Priority order: ACTIVE > COMING_SOON > ON_HOLD > EXPIRED
 * 
 * Only highest-priority listing may:
 * - drive journeys
 * - trigger marketing
 * - control seller communications
 * 
 * Others are secondary context only
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ListingStage } from "./lifecycle-definitions"
import { getCurrentLifecycleStage } from "./lifecycle-logger"
import { getStageIndex } from "./lifecycle-definitions"

export type ListingPriority = "primary" | "secondary" | "tertiary"

export interface ListingWithPriority {
  listingId: string
  stage: ListingStage | null
  priority: ListingPriority
  isPrimary: boolean
  canDriveJourneys: boolean
  canTriggerMarketing: boolean
  canControlCommunications: boolean
  priorityReason: string
}

/**
 * Stage priority tiers
 * Higher tier = higher priority
 */
const STAGE_PRIORITY_TIERS: Record<string, number> = {
  // Tier 4: Active stages (highest priority)
  MLS_ACTIVE: 4,
  SHOWINGS_ACTIVE: 4,
  OFFERS_RECEIVED: 4,
  NEGOTIATION: 4,
  UNDER_CONTRACT: 4,
  INSPECTION: 4,
  APPRAISAL: 4,
  FINANCING: 4,
  CLOSING_PREP: 4,
  
  // Tier 3: Coming soon stages
  COMING_SOON_PREP: 3,
  REPAIRS_IN_PROGRESS: 3,
  COMING_SOON_ACTIVE: 3,
  MEDIA_CAPTURE: 3,
  MEDIA_APPROVED: 3,
  MLS_READY: 3,
  OPEN_HOUSE_MARKETING: 3,
  OPEN_HOUSE_EVENT: 3,
  
  // Tier 2: Pre-listing stages
  LISTING_AGREEMENT_SIGNED: 2,
  MLS_DATE_CONFIRMED: 2,
  
  // Tier 1: Lead stages (lowest priority)
  LEAD: 1,
  LEAD_ASSIGNED: 1,
  AGENT_CONSULTATION: 1,
  APPOINTMENT_SET: 1,
  CMA_GENERATION: 1,
  LISTING_PRESENTATION_CREATED: 1,
  PRESENTATION_VIDEO_GENERATED: 1,
  PRESENTATION_DRIP_PREP: 1,
  SELLER_DECISION: 1,
  LISTING_AGREEMENT_INITIATED: 1,
  
  // Tier 0: Closed/completed stages (no priority)
  CLOSED: 0,
  LIFETIME_CUSTOMER: 0,
}

/**
 * Get priority tier for a stage
 */
function getStagePriorityTier(stage: ListingStage | null): number {
  if (!stage) return 0
  return STAGE_PRIORITY_TIERS[stage] || 0
}

/**
 * Resolve primary listing for a contact
 * Returns the highest-priority listing
 */
export async function resolvePrimaryListing(
  supabase: SupabaseClient,
  contactId: string
): Promise<{
  primaryListing: ListingWithPriority | null
  allListings: ListingWithPriority[]
  totalListings: number
}> {
  // Get all listings for contact
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address")
    .eq("contact_id", contactId)
    // Soft-delete lives on listings.deleted_at, not on status — there is no
    // "deleted" status, so this excluded nothing at all.
    .is("deleted_at", null)
  
  if (!listings || listings.length === 0) {
    return {
      primaryListing: null,
      allListings: [],
      totalListings: 0,
    }
  }
  
  // Get lifecycle stage for each listing
  const listingsWithStages: Array<{
    listingId: string
    stage: ListingStage | null
    priorityTier: number
    stageIndex: number
  }> = []
  
  for (const listing of listings) {
    const stage = await getCurrentLifecycleStage(supabase, listing.id)
    const priorityTier = getStagePriorityTier(stage)
    const stageIndex = stage ? getStageIndex(stage) : -1
    
    listingsWithStages.push({
      listingId: listing.id,
      stage,
      priorityTier,
      stageIndex,
    })
  }
  
  // Sort by priority tier (desc), then by stage index (desc)
  listingsWithStages.sort((a, b) => {
    if (a.priorityTier !== b.priorityTier) {
      return b.priorityTier - a.priorityTier
    }
    return b.stageIndex - a.stageIndex
  })
  
  // Assign priority labels
  const allListings: ListingWithPriority[] = listingsWithStages.map((listing, index) => {
    const isPrimary = index === 0
    const priority: ListingPriority = 
      index === 0 ? "primary" : 
      index === 1 ? "secondary" : 
      "tertiary"
    
    const canDriveJourneys = isPrimary
    const canTriggerMarketing = isPrimary
    const canControlCommunications = isPrimary
    
    const priorityReason = isPrimary
      ? "Highest priority listing (most advanced stage)"
      : index === 1
      ? "Secondary listing (second-highest priority)"
      : "Tertiary listing (context only)"
    
    return {
      listingId: listing.listingId,
      stage: listing.stage,
      priority,
      isPrimary,
      canDriveJourneys,
      canTriggerMarketing,
      canControlCommunications,
      priorityReason,
    }
  })
  
  return {
    primaryListing: allListings[0] || null,
    allListings,
    totalListings: listings.length,
  }
}

/**
 * Check if listing is primary for its contact
 */
export async function isListingPrimary(
  supabase: SupabaseClient,
  listingId: string
): Promise<boolean> {
  // Get listing's contact
  const { data: listing } = await supabase
    .from("listings")
    .select("contact_id")
    .eq("id", listingId)
    .single()
  
  if (!listing?.contact_id) {
    return false
  }
  
  // Resolve primary listing
  const { primaryListing } = await resolvePrimaryListing(supabase, listing.contact_id)
  
  return primaryListing?.listingId === listingId
}

/**
 * Get listing priority for a specific listing
 */
export async function getListingPriority(
  supabase: SupabaseClient,
  listingId: string
): Promise<ListingWithPriority | null> {
  // Get listing's contact
  const { data: listing } = await supabase
    .from("listings")
    .select("contact_id")
    .eq("id", listingId)
    .single()
  
  if (!listing?.contact_id) {
    return null
  }
  
  // Resolve all listings
  const { allListings } = await resolvePrimaryListing(supabase, listing.contact_id)
  
  return allListings.find((l) => l.listingId === listingId) || null
}

/**
 * Check if listing can drive journeys (must be primary)
 */
export async function canListingDriveJourneys(
  supabase: SupabaseClient,
  listingId: string
): Promise<boolean> {
  const priority = await getListingPriority(supabase, listingId)
  return priority?.canDriveJourneys || false
}

/**
 * Check if listing can trigger marketing (must be primary)
 */
export async function canListingTriggerMarketing(
  supabase: SupabaseClient,
  listingId: string
): Promise<boolean> {
  const priority = await getListingPriority(supabase, listingId)
  return priority?.canTriggerMarketing || false
}

/**
 * Check if listing can control communications (must be primary)
 */
export async function canListingControlCommunications(
  supabase: SupabaseClient,
  listingId: string
): Promise<boolean> {
  const priority = await getListingPriority(supabase, listingId)
  return priority?.canControlCommunications || false
}

/**
 * Get all contacts with multiple listings
 * Useful for reporting and governance
 */
export async function getContactsWithMultipleListings(
  supabase: SupabaseClient,
  brokerageId: string
): Promise<Array<{
  contactId: string
  listingCount: number
  primaryListingId: string | null
  primaryStage: ListingStage | null
}>> {
  // Get all listings for brokerage
  const { data: listings } = await supabase
    .from("listings")
    .select("id, contact_id")
    .eq("brokerage_id", brokerageId)
    // Soft-delete lives on listings.deleted_at, not on status — there is no
    // "deleted" status, so this excluded nothing at all.
    .is("deleted_at", null)
  
  if (!listings) {
    return []
  }
  
  // Group by contact
  const contactMap = new Map<string, string[]>()
  
  for (const listing of listings) {
    if (!listing.contact_id) continue
    
    if (!contactMap.has(listing.contact_id)) {
      contactMap.set(listing.contact_id, [])
    }
    contactMap.get(listing.contact_id)!.push(listing.id)
  }
  
  // Filter contacts with multiple listings
  const multiListingContacts: Array<{
    contactId: string
    listingCount: number
    primaryListingId: string | null
    primaryStage: ListingStage | null
  }> = []
  
  for (const [contactId, listingIds] of contactMap.entries()) {
    if (listingIds.length <= 1) continue
    
    // Resolve primary listing
    const { primaryListing } = await resolvePrimaryListing(supabase, contactId)
    
    multiListingContacts.push({
      contactId,
      listingCount: listingIds.length,
      primaryListingId: primaryListing?.listingId || null,
      primaryStage: primaryListing?.stage || null,
    })
  }
  
  return multiListingContacts
}

/**
 * Get priority override recommendations
 * Suggests when priority should be manually overridden
 */
export async function getPriorityOverrideRecommendations(
  supabase: SupabaseClient,
  contactId: string
): Promise<Array<{
  listingId: string
  currentPriority: ListingPriority
  recommendedPriority: ListingPriority
  reason: string
}>> {
  const { allListings } = await resolvePrimaryListing(supabase, contactId)
  
  const recommendations: Array<{
    listingId: string
    currentPriority: ListingPriority
    recommendedPriority: ListingPriority
    reason: string
  }> = []
  
  // Example rule: If secondary listing is UNDER_CONTRACT and primary is SHOWINGS_ACTIVE,
  // recommend switching priority
  for (let i = 0; i < allListings.length; i++) {
    const current = allListings[i]
    
    if (current.priority === "secondary" && current.stage === "UNDER_CONTRACT") {
      const primary = allListings[0]
      
      if (primary.stage && getStagePriorityTier(primary.stage) === getStagePriorityTier(current.stage)) {
        recommendations.push({
          listingId: current.listingId,
          currentPriority: current.priority,
          recommendedPriority: "primary",
          reason: "Secondary listing is under contract. Consider prioritizing this transaction.",
        })
      }
    }
  }
  
  return recommendations
}
