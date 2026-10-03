"use server"

/**
 * lib/listings/tier-assigner.ts
 * Layer 9.10 - Listing Marketing Tier System
 *
 * Assigns marketing tiers to listings based on price ranges configured by brokerages.
 * This is INFORMATIONAL ONLY - does NOT auto-create marketing_campaigns.
 *
 * Next 16 — file is marked "use server" so it can be safely imported by
 * client components (marketing-tier-client.tsx). Every export is an async
 * function returning serializable data; Server Action contract holds.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"

// ============================================
// ACTOR RESOLUTION (w2s3)
// ============================================
//
// SECURITY: every gate in this module was `canAccessFeature(actorUserId, …)`
// where `actorUserId` arrives AS A PARAMETER FROM THE CALLER. That is an
// authorization check against an identity the caller merely asserts — the
// caller gets to name whose entitlement is checked. Since this file is
// `"use server"`, each of those is a public endpoint, so anyone could pass the
// user id of someone whose brokerage HAS the `listing_marketing_tiers`
// feature and walk straight through the gate.
//
// Row-level security on the three tier tables (`brokerage_id =
// current_user_brokerage_id()`, verified live) is what kept this from being a
// cross-tenant write — but it does NOT stop the entitlement bypass: a user of
// a brokerage without the feature could borrow an entitled id and then create
// and delete tiers freely inside their OWN brokerage, which is exactly what
// the paid-feature gate exists to prevent.
//
// The fix keeps every signature intact (so the existing callers in
// marketing-tier-client.tsx and app/actions/listings.ts are untouched) and
// simply refuses to accept an `actorUserId` that is not the session user.

interface TierActor {
  userId: string
  brokerageId: string
}

/**
 * Prove the claimed actor IS the caller, and return their real brokerage.
 * Fails CLOSED — no session, a mismatch, or a refused profile read all refuse.
 */
async function resolveTierActor(
  claimedUserId: string,
): Promise<{ ok: true; actor: TierActor } | { ok: false; error: string }> {
  if (!isValidUUID(claimedUserId)) return { ok: false, error: "Invalid actor ID" }

  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return { ok: false, error: "Unauthorized" }

  // The whole point: the asserted id must be the authenticated one.
  if (auth.user.id !== claimedUserId) return { ok: false, error: "Unauthorized" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", auth.user.id)
    .maybeSingle()

  if (profileError) return { ok: false, error: "Could not verify your account" }
  if (!profile?.brokerage_id) return { ok: false, error: "No brokerage on your account" }

  return { ok: true, actor: { userId: auth.user.id, brokerageId: profile.brokerage_id } }
}

/**
 * Session-only actor resolution for the READ endpoints, which take no
 * actorUserId. Same fail-closed contract.
 */
async function resolveTierReader(): Promise<
  { ok: true; actor: TierActor } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return { ok: false, error: "Unauthorized" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", auth.user.id)
    .maybeSingle()

  if (profileError) return { ok: false, error: "Could not verify your account" }
  if (!profile?.brokerage_id) return { ok: false, error: "No brokerage on your account" }

  return { ok: true, actor: { userId: auth.user.id, brokerageId: profile.brokerage_id } }
}

// ============================================
// TYPES
// ============================================

interface TierBudget {
  id: string
  tier_id: string
  channel_type: string
  default_budget: number
}

interface TierDistribution {
  id: string
  tier_id: string
  asset_type: string
  channel_type: string
  is_required: boolean
}

interface MarketingTier {
  id: string
  brokerage_id: string
  tier_name: string
  min_price: number | null
  max_price: number | null
  description: string | null
  is_active: boolean
  created_at: string
}

interface AssignTierResult {
  success: boolean
  tierId: string | null
  tierName: string | null
  budgets: TierBudget[]
  totalBudget: number
  reason?: string
  error?: string
}

// ============================================
// 1. ASSIGN TIER TO LISTING
// ============================================

export async function assignTierToListing(
  listingId: string,
  brokerageId: string,
  actorUserId: string
): Promise<AssignTierResult> {
  try {
    if (!isValidUUID(listingId) || !isValidUUID(brokerageId) || !isValidUUID(actorUserId)) {
      return {
        success: false,
        tierId: null,
        tierName: null,
        budgets: [],
        totalBudget: 0,
        error: "Invalid IDs provided",
      }
    }

    // ── Kernel Gate: canAccessFeature ──
    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(actorUserId)
    if (!gate.ok) {
      return { success: false, tierId: null, tierName: null, budgets: [], totalBudget: 0, error: gate.error }
    }
    // `brokerageId` is also caller-supplied and is used as the filter on both
    // the listing read and the tier lookup below. Pin it to the actor's real
    // tenant rather than letting the caller name the tenant it operates in.
    if (gate.actor.brokerageId !== brokerageId) {
      return { success: false, tierId: null, tierName: null, budgets: [], totalBudget: 0, error: "Unauthorized" }
    }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return {
        success: false,
        tierId: null,
        tierName: null,
        budgets: [],
        totalBudget: 0,
        error: access.reason ?? "Listing marketing tiers feature not available",
      }
    }

    const supabase = await createClient()

    // Step 1: Get listing price (try list_price first, then price)
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("id, list_price, marketing_budget, marketing_tier_id")
      .eq("id", listingId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (listingError || !listing) {
      return {
        success: false,
        tierId: null,
        tierName: null,
        budgets: [],
        totalBudget: 0,
        error: "Listing not found",
      }
    }

    const listPrice = listing.list_price

    if (!listPrice || listPrice <= 0) {
      console.warn(`[Tier Assigner] Listing ${listingId} has no valid price for tier assignment`)
      return {
        success: false,
        tierId: null,
        tierName: null,
        budgets: [],
        totalBudget: 0,
        reason: "no_price",
      }
    }

    // Step 2: Find matching tier based on price range
    const { data: matchingTier, error: tierError } = await supabase
      .from("listing_marketing_tiers")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .or(`min_price.is.null,min_price.lte.${listPrice}`)
      .or(`max_price.is.null,max_price.gte.${listPrice}`)
      .order("min_price", { ascending: false, nullsFirst: false })
      .limit(1)
      .single()

    // Step 3: If no tier found, log warning but don't throw
    if (tierError || !matchingTier) {
      console.warn(`[Tier Assigner] No matching tier found for listing ${listingId} with price ${listPrice}`)
      return {
        success: true,
        tierId: null,
        tierName: null,
        budgets: [],
        totalBudget: 0,
        reason: "no_matching_tier",
      }
    }

    const tier = matchingTier as MarketingTier

    // Step 4: Get tier budgets
    const { data: tierBudgets } = await supabase
      .from("tier_budgets")
      .select("*")
      .eq("tier_id", tier.id)

    const budgets = (tierBudgets ?? []) as TierBudget[]
    const totalBudget = budgets.reduce((sum, b) => sum + (b.default_budget || 0), 0)

    // Step 5: Update listing with tier and marketing budget
    const { error: updateError } = await supabase
      .from("listings")
      .update({
        marketing_tier_id: tier.id,
        marketing_budget: totalBudget,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listingId)

    if (updateError) {
      console.error("[Tier Assigner] Failed to update listing:", updateError)
      return {
        success: false,
        tierId: null,
        tierName: null,
        budgets: [],
        totalBudget: 0,
        error: "Failed to update listing with tier",
      }
    }

    // Step 6: Fire kernel event
    await processKernelEvent({
      event: KernelEvent.LISTING_TIER_ASSIGNED,
      brokerageId,
      entityType: "listing",
      entityId: listingId,
    })

    return {
      success: true,
      tierId: tier.id,
      tierName: tier.tier_name,
      budgets,
      totalBudget,
    }
  } catch (error) {
    console.error("[Tier Assigner] Error:", error)
    return {
      success: false,
      tierId: null,
      tierName: null,
      budgets: [],
      totalBudget: 0,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================
// 2. GET TIER FOR LISTING
// ============================================

export async function getTierForListing(listingId: string) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }

    const reader = await resolveTierReader()
    if (!reader.ok) return { success: false, error: reader.error }

    const supabase = await createClient()

    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select(`
        id,
        list_price,
        marketing_budget,
        marketing_tier_id,
        listing_marketing_tiers:marketing_tier_id (
          id,
          tier_name,
          min_price,
          max_price,
          description,
          is_active
        )
      `)
      .eq("id", listingId)
      // Explicit tenant filter. RLS on `listings` already constrains this, but
      // the filter must be visible in the query rather than assumed: this
      // endpoint discloses list_price and marketing_budget, and the module has
      // siblings that could later be switched to a service client.
      .eq("brokerage_id", reader.actor.brokerageId)
      .maybeSingle()

    // `.single()` raised PGRST116 for the zero-row case and the old code
    // flattened that into "Listing not found" — the same message a genuine
    // read failure produced. `.maybeSingle()` separates the two.
    if (listingError) {
      return { success: false, error: "Could not read the listing" }
    }
    if (!listing) {
      return { success: false, error: "Listing not found" }
    }

    return {
      success: true,
      listing: {
        id: listing.id,
        listPrice: listing.list_price,
        marketingBudget: listing.marketing_budget,
        tierId: listing.marketing_tier_id,
      },
      tier: listing.listing_marketing_tiers,
    }
  } catch (error) {
    return handleError(error, "getTierForListing")
  }
}

// ============================================
// 3. GET REQUIRED DISTRIBUTIONS FOR TIER — DELETED
// ============================================
// TOMBSTONE (orphan tranche 4): getRequiredDistributions deleted. The one surface
// that renders distributions (app/dashboard/listings/[id]/marketing-tier/page.tsx)
// documented WHY it does not use this reader: it needs the FULL set and badges
// each row required/optional, while this returned only `is_required = true` rows —
// swapping it in would silently hide the optional distributions. That page's
// tenant-scoped tier_distributions read is the survivor; a required-only view is
// one `.eq("is_required", true)` (or an in-memory filter) on top of it.

// ============================================
// 4. GET TIER BUDGETS
// ============================================

export async function getTierBudgets(tierId: string) {
  try {
    if (!isValidUUID(tierId)) {
      return { success: false, error: "Invalid tier ID" }
    }

    const reader = await resolveTierReader()
    if (!reader.ok) return { success: false, error: reader.error }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("tier_budgets")
      .select("*")
      .eq("tier_id", tierId)
      .eq("brokerage_id", reader.actor.brokerageId)

    if (error) throw error

    const budgets = (data ?? []) as TierBudget[]
    const totalBudget = budgets.reduce((sum, b) => sum + (b.default_budget || 0), 0)

    return {
      success: true,
      budgets,
      totalBudget,
    }
  } catch (error) {
    return handleError(error, "getTierBudgets")
  }
}

// ============================================
// 5. GET ALL TIERS FOR BROKERAGE
// ============================================

export async function getTiersForBrokerage(brokerageId: string) {
  try {
    if (!isValidUUID(brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    const reader = await resolveTierReader()
    if (!reader.ok) return { success: false, error: reader.error }
    // The caller does NOT get to name the tenant whose tier configuration
    // (price bands, budgets) is returned.
    if (reader.actor.brokerageId !== brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listing_marketing_tiers")
      .select("*")
      .eq("brokerage_id", reader.actor.brokerageId)
      .order("min_price", { ascending: true, nullsFirst: true })

    if (error) throw error

    return {
      success: true,
      tiers: (data ?? []) as MarketingTier[],
    }
  } catch (error) {
    return handleError(error, "getTiersForBrokerage")
  }
}

// ============================================
// 6. CREATE TIER (Admin/Broker Only)
// ============================================

export async function createTier(params: {
  brokerageId: string
  actorUserId: string
  tierName: string
  minPrice?: number | null
  maxPrice?: number | null
  description?: string
}) {
  try {
    if (!isValidUUID(params.brokerageId) || !isValidUUID(params.actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── Kernel Gate: canAccessFeature ──
    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(params.actorUserId)
    if (!gate.ok) return { success: false, error: gate.error }
    // Caller-supplied tenant, pinned to the actor's real one.
    if (gate.actor.brokerageId !== params.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listing_marketing_tiers")
      .insert({
        brokerage_id: gate.actor.brokerageId,
        tier_name: params.tierName,
        min_price: params.minPrice ?? null,
        max_price: params.maxPrice ?? null,
        description: params.description ?? null,
        is_active: true,
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, tier: data }
  } catch (error) {
    return handleError(error, "createTier")
  }
}

// ============================================
// 7. UPDATE TIER (Admin/Broker Only)
// ============================================

export async function updateTier(params: {
  tierId: string
  actorUserId: string
  tierName?: string
  minPrice?: number | null
  maxPrice?: number | null
  description?: string
  isActive?: boolean
}) {
  try {
    if (!isValidUUID(params.tierId) || !isValidUUID(params.actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── Kernel Gate: canAccessFeature ──
    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(params.actorUserId)
    if (!gate.ok) return { success: false, error: gate.error }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    const updates: Record<string, unknown> = {}
    if (params.tierName !== undefined) updates.tier_name = params.tierName
    if (params.minPrice !== undefined) updates.min_price = params.minPrice
    if (params.maxPrice !== undefined) updates.max_price = params.maxPrice
    if (params.description !== undefined) updates.description = params.description
    if (params.isActive !== undefined) updates.is_active = params.isActive

    const { data, error } = await supabase
      .from("listing_marketing_tiers")
      .update(updates)
      .eq("id", params.tierId)
      .select()
      .single()

    if (error) throw error

    return { success: true, tier: data }
  } catch (error) {
    return handleError(error, "updateTier")
  }
}

// ============================================
// 8. CREATE TIER BUDGET (Admin/Broker Only)
// ============================================

export async function createTierBudget(params: {
  tierId: string
  brokerageId: string
  actorUserId: string
  channelType: string
  defaultBudget: number
}) {
  try {
    if (!isValidUUID(params.tierId) || !isValidUUID(params.actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── Kernel Gate: canAccessFeature ──
    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(params.actorUserId)
    if (!gate.ok) return { success: false, error: gate.error }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("tier_budgets")
      .insert({
        tier_id: params.tierId,
        brokerage_id: params.brokerageId,
        channel_type: params.channelType,
        default_budget: params.defaultBudget,
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, budget: data }
  } catch (error) {
    return handleError(error, "createTierBudget")
  }
}

// ============================================
// 9. CREATE TIER DISTRIBUTION (Admin/Broker Only)
// ============================================

export async function createTierDistribution(params: {
  tierId: string
  brokerageId: string
  actorUserId: string
  assetType: string
  channelType: string
  isRequired: boolean
}) {
  try {
    if (!isValidUUID(params.tierId) || !isValidUUID(params.actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── Kernel Gate: canAccessFeature ──
    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(params.actorUserId)
    if (!gate.ok) return { success: false, error: gate.error }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("tier_distributions")
      .insert({
        tier_id: params.tierId,
        brokerage_id: params.brokerageId,
        asset_type: params.assetType,
        channel_type: params.channelType,
        is_required: params.isRequired,
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, distribution: data }
  } catch (error) {
    return handleError(error, "createTierDistribution")
  }
}

// ============================================
// 10. DELETE TIER BUDGET
// ============================================

export async function deleteTierBudget(budgetId: string, actorUserId: string) {
  try {
    if (!isValidUUID(budgetId) || !isValidUUID(actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(actorUserId)
    if (!gate.ok) return { success: false, error: gate.error }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    // EXPLICIT tenant filter. This delete previously relied on RLS alone, and
    // an RLS-filtered delete removes ZERO rows without raising — so a delete
    // aimed at another brokerage's row was reported to the caller as
    // `success: true`. `.select("id")` makes the no-op visible.
    const { data: removed, error } = await supabase
      .from("tier_budgets")
      .delete()
      .eq("id", budgetId)
      .eq("brokerage_id", gate.actor.brokerageId)
      .select("id")

    if (error) throw error
    if (!removed || removed.length === 0) {
      return { success: false, error: "Not found in your brokerage" }
    }

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteTierBudget")
  }
}

// ============================================
// 11. DELETE TIER DISTRIBUTION
// ============================================

export async function deleteTierDistribution(distributionId: string, actorUserId: string) {
  try {
    if (!isValidUUID(distributionId) || !isValidUUID(actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // Prove the asserted actor IS the caller before trusting the entitlement.
    const gate = await resolveTierActor(actorUserId)
    if (!gate.ok) return { success: false, error: gate.error }

    const access = await canAccessFeature(gate.actor.userId, "listing_marketing_tiers")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    // EXPLICIT tenant filter. This delete previously relied on RLS alone, and
    // an RLS-filtered delete removes ZERO rows without raising — so a delete
    // aimed at another brokerage's row was reported to the caller as
    // `success: true`. `.select("id")` makes the no-op visible.
    const { data: removed, error } = await supabase
      .from("tier_distributions")
      .delete()
      .eq("id", distributionId)
      .eq("brokerage_id", gate.actor.brokerageId)
      .select("id")

    if (error) throw error
    if (!removed || removed.length === 0) {
      return { success: false, error: "Not found in your brokerage" }
    }

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteTierDistribution")
  }
}
