/**
 * System 5.2: Listing Lifecycle Core - Server Actions
 * 
 * Public API for listing lifecycle governance.
 * This system does NOT execute work - it validates, enforces, gates, and logs.
 */

"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  type ListingStage,
  type TransitionValidationContext,
  getStageDefinition,
  getAllStages,
  getEnabledSystemGates,
  isSystemGateEnabled,
  validateStageTransition,
  getNextAllowedStages,
  canSkipStages,
  evaluateReadinessChecks,
  logStageTransition,
  logFailedTransition,
  logSystemGateEnabled,
  getLifecycleHistory,
  getCurrentLifecycleStage,
  getLifecycleStatistics,
  getStageTimingMetrics,
} from "@/lib/listing-lifecycle"

// ============================================
// LIFECYCLE VALIDATION ACTIONS
// ============================================

/**
 * Validate if a stage transition is allowed
 * DOES NOT execute the transition - only validates
 */
export async function validateListingTransition(params: {
  listingId: string
  targetStage: ListingStage
  overrideReason?: string
}) {
  const supabase = await createClient()
  
  // Validate inputs
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user profile with role
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile) {
    return { success: false, error: "User profile not found" }
  }
  
  // Get listing with current stage
  const { data: listing } = await supabase
    .from("listings")
    .select("id, agent_id, brokerage_id")
    .eq("id", params.listingId)
    .single()
  
  if (!listing) {
    return { success: false, error: "Listing not found" }
  }
  
  // Get current stage from lifecycle history
  const currentStage = await getCurrentLifecycleStage(supabase, params.listingId)
  
  // Evaluate readiness checks
  const targetDef = getStageDefinition(params.targetStage)
  if (!targetDef) {
    return { success: false, error: "Invalid target stage" }
  }
  
  const readinessEval = await evaluateReadinessChecks(
    supabase,
    params.listingId,
    targetDef.readinessChecks
  )

  const resolvedRole = (profile.user_type ?? profile.role) || "agent"
  
  // Validate transition
  const validationContext: TransitionValidationContext = {
    currentStage,
    targetStage: params.targetStage,
    userRole: resolvedRole,
    userId: user.id,
    listingId: params.listingId,
    completedReadinessChecks: readinessEval.passedChecks,
    isAdminOverride: !!params.overrideReason,
    overrideReason: params.overrideReason,
  }
  
  const validation = validateStageTransition(validationContext)

  // ── Launch gate: block if required listing data is missing ────────────────
  // Evaluated after the stage-machine check so the stage-machine always wins.
  const LAUNCH_STAGES = new Set(["active", "launch_ready", "mls_active", "published", "ACTIVE", "LAUNCH_READY", "MLS_ACTIVE", "PUBLISHED"])
  if (validation.allowed && LAUNCH_STAGES.has(params.targetStage)) {
    const launchBlockers = await evaluateLaunchBlockers(params.listingId, supabase)
    if (launchBlockers.length > 0) {
      return {
        success: true,
        validation: {
          allowed: false,
          blocked: true,
          blockers: launchBlockers,
          reason: `Cannot launch: ${launchBlockers.join(". ")}`,
          warnings: validation.warnings,
          currentStage,
          targetStage: params.targetStage,
          readinessChecks: {
            allPassed: readinessEval.allPassed,
            passed: readinessEval.passedChecks,
            failed: readinessEval.failedChecks,
            results: readinessEval.results,
          },
          nextAllowedStages: [],
        },
      }
    }
  }

  return {
    success: true,
    validation: {
      allowed: validation.allowed,
      reason: validation.reason,
      warnings: validation.warnings,
      currentStage,
      targetStage: params.targetStage,
      readinessChecks: {
        allPassed: readinessEval.allPassed,
        passed: readinessEval.passedChecks,
        failed: readinessEval.failedChecks,
        results: readinessEval.results,
      },
      nextAllowedStages: validation.allowed
        ? []
        : getNextAllowedStages(currentStage || "LEAD", resolvedRole),
    },
  }
}

// ── Launch blocker evaluator ───────────────────────────────────────────────
// Checks the listing record and photo count to ensure the listing meets the
// minimum requirements before it can be moved to any live/published stage.
// Returns an array of human-readable blocker strings (empty = no blockers).
async function evaluateLaunchBlockers(
  listingId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<string[]> {
  const blockers: string[] = []

  const [listingResult, photoCountResult, mediaCountResult] = await Promise.all([
    supabase
      .from("listings")
      .select("address, list_price, seller_contact_id")
      .eq("id", listingId)
      .maybeSingle(),
    supabase
      .from("listing_photos")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId),
    // Also check listing_media table (photos stored there in some flows)
    supabase
      .from("listing_media")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId)
      .eq("media_type", "photo"),
  ])

  const listing = listingResult.data
  if (!listing) return ["Listing record not found"]

  if (!listing.seller_contact_id) {
    blockers.push("No seller contact linked")
  }
  if (!listing.list_price) {
    blockers.push("No list price set")
  }

  // Count photos from both tables and take the max
  const photoCountA = photoCountResult.count ?? 0
  const photoCountB = mediaCountResult.count ?? 0
  const photoCount = Math.max(photoCountA, photoCountB)
  // Minimum 5 photos per spec
  if (photoCount < 5) {
    blockers.push(`Photos: need at least 5 (${photoCount} uploaded)`)
  }

  // Check public_remarks from listings table
  const { data: remarkRow } = await supabase
    .from("listings")
    .select("public_remarks" as any)
    .eq("id", listingId)
    .maybeSingle()
    .then(r => r as { data: { public_remarks?: string } | null })

  const publicRemarks = (remarkRow as any)?.public_remarks
  if (!publicRemarks || publicRemarks.length < 50) {
    blockers.push("Listing description missing or too short (minimum 50 characters)")
  }

  return blockers
}

/**
 * Execute a stage transition (after validation)
 * This is the ONLY action that modifies listing lifecycle state
 */
export async function executeListingTransition(params: {
  listingId: string
  targetStage: ListingStage
  notes?: string
  overrideReason?: string
}) {
  const supabase = await createClient()
  
  // Validate inputs
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user profile with role
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile) {
    return { success: false, error: "User profile not found" }
  }
  
  // Get listing
  const { data: listing } = await supabase
    .from("listings")
    .select("id, agent_id, brokerage_id")
    .eq("id", params.listingId)
    .single()
  
  if (!listing) {
    return { success: false, error: "Listing not found" }
  }
  
  // Get current stage
  const currentStage = await getCurrentLifecycleStage(supabase, params.listingId)
  
  // Validate first
  const validation = await validateListingTransition({
    listingId: params.listingId,
    targetStage: params.targetStage,
    overrideReason: params.overrideReason,
  })
  
  if (!validation.success || !validation.validation?.allowed) {
    // Log failed attempt
    await logFailedTransition(supabase, {
      listingId: params.listingId,
      agentId: listing.agent_id,
      brokerageId: listing.brokerage_id,
      fromStage: currentStage,
      toStage: params.targetStage,
      userId: user.id,
      userRole: profile.user_type || "agent",
      failureReason: validation.validation?.reason || validation.error || "Validation failed",
      readinessChecksPassed: validation.validation?.readinessChecks?.passed || [],
      readinessChecksFailed: validation.validation?.readinessChecks?.failed || [],
    })
    
    return {
      success: false,
      error: validation.validation?.reason || validation.error || "Transition not allowed",
      validation: validation.validation,
    }
  }
  
  // Log successful transition
  await logStageTransition(supabase, {
    listingId: params.listingId,
    agentId: listing.agent_id,
    brokerageId: listing.brokerage_id,
    fromStage: currentStage,
    toStage: params.targetStage,
    userId: user.id,
    userRole: profile.user_type || "agent",
    isOverride: !!params.overrideReason,
    overrideReason: params.overrideReason,
    readinessChecksPassed: validation.validation?.readinessChecks?.passed || [],
    notes: params.notes,
  })
  
  // Log system gates if enabled
  const targetDef = getStageDefinition(params.targetStage)
  if (targetDef?.enablesSystemGates) {
    for (const gateName of targetDef.enablesSystemGates) {
      await logSystemGateEnabled(supabase, {
        listingId: params.listingId,
        agentId: listing.agent_id,
        brokerageId: listing.brokerage_id,
        stage: params.targetStage,
        gateName,
      })
    }
  }

  // ── CLOSED: Convert seller to lifetime customer ───────────────────────────
  if (params.targetStage === "CLOSED") {
    await handleSellerToLifetimeTransition(supabase, params.listingId, listing.agent_id, listing.brokerage_id)
  }

  return {
    success: true,
    transition: {
      fromStage: currentStage,
      toStage: params.targetStage,
      timestamp: new Date().toISOString(),
      enabledSystemGates: targetDef?.enablesSystemGates || [],
    },
  }
}

// ============================================
// INTERNAL: SELLER → LIFETIME CUSTOMER
// ============================================

async function handleSellerToLifetimeTransition(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  agentId: string,
  brokerageId: string,
) {
  // Fetch listing with seller contact and address
  const { data: listingWithContact } = await supabase
    .from("listings")
    .select("seller_contact_id, address, city, state")
    .eq("id", listingId)
    .maybeSingle()

  if (!listingWithContact?.seller_contact_id) return

  const { seller_contact_id: contactId, address, city, state } = listingWithContact
  const propertyAddress = [address, city, state].filter(Boolean).join(", ")
  const now = new Date().toISOString()
  const closedDate = new Date().toLocaleDateString()

  // 1. Convert contact to lifetime customer
  await supabase
    .from("contacts")
    .update({
      contact_type: "lifetime",
      contact_persona: "past_seller",
      status: "past_client",
      notes: `Converted to lifetime customer on ${closedDate} after closing at ${propertyAddress}`,
      updated_at: now,
    })
    .eq("id", contactId)

  // 2. Trigger post-close touchpoint sequence (3-day, 30-day, 6-month)
  const closingDate = new Date()
  const touchpoints = [
    { type: "post_close_3_day",   daysAfter: 3,   channel: "video" },
    { type: "post_close_30_day",  daysAfter: 30,  channel: "sms"   },
    { type: "post_close_6_month", daysAfter: 180, channel: "email" },
  ].map(({ type, daysAfter, channel }) => {
    const d = new Date(closingDate)
    d.setDate(d.getDate() + daysAfter)
    return {
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      touchpoint_type: type,
      channel,
      scheduled_date: d.toISOString().split("T")[0],
      related_transaction_id: null,
      status: "scheduled",
    }
  })

  await supabase.from("past_client_touchpoints").insert(touchpoints).then(() => {})

  // 3. Send portal message (body column per schema)
  await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      brokerage_id: brokerageId,
      agent_id: agentId,
      body: `Congratulations on your successful closing! Your portal is now updated to reflect your homeowner status. We look forward to being your lifetime real estate resource.`,
      direction: "outbound",
    })
    .then(() => {})

  // 4. Increment agent gamification points (agents table has gamification_points column)
  if (agentId) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id, gamification_points")
      .eq("id", agentId)
      .maybeSingle()

    if (agentRow) {
      await supabase
        .from("agents")
        .update({ gamification_points: (agentRow.gamification_points ?? 0) + 50 })
        .eq("id", agentId)
        .then(() => {})
    }
  }
}

// ============================================
// LIFECYCLE QUERY ACTIONS
// ============================================

/**
 * Get all available lifecycle stages
 */
export async function getLifecycleStages() {
  return {
    success: true,
    stages: getAllStages(),
  }
}

/**
 * Get lifecycle history for a listing
 */
export async function getListingLifecycleHistory(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const history = await getLifecycleHistory(supabase, listingId)
  
  return {
    success: true,
    history,
  }
}

/**
 * Get current lifecycle stage for a listing
 */
export async function getListingCurrentStage(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  return {
    success: true,
    currentStage,
  }
}

/**
 * Get next allowed stages for a listing
 */
export async function getListingNextStages(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user role
  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .single()
  
  // Get current stage
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  if (!currentStage) {
    return {
      success: true,
      nextStages: ["LEAD"] as ListingStage[],
    }
  }
  
  const nextStages = getNextAllowedStages(
    currentStage,
    profile?.user_type || "agent"
  )
  
  return {
    success: true,
    currentStage,
    nextStages,
    canSkipStages: canSkipStages(profile?.user_type || "agent"),
  }
}

// ============================================
// SYSTEM GATE QUERY ACTIONS
// ============================================

/**
 * Check if a system gate is enabled for a listing
 */
export async function checkSystemGate(params: {
  listingId: string
  gateName: string
}) {
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const currentStage = await getCurrentLifecycleStage(supabase, params.listingId)
  
  if (!currentStage) {
    return {
      success: true,
      enabled: false,
      reason: "Listing has no lifecycle stage",
    }
  }
  
  const enabled = isSystemGateEnabled(currentStage, params.gateName)
  
  return {
    success: true,
    enabled,
    currentStage,
    gateName: params.gateName,
  }
}

/**
 * Get all enabled system gates for a listing
 */
export async function getEnabledGates(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  if (!currentStage) {
    return {
      success: true,
      enabledGates: [],
      reason: "Listing has no lifecycle stage",
    }
  }
  
  const enabledGates = getEnabledSystemGates(currentStage)
  
  return {
    success: true,
    currentStage,
    enabledGates,
  }
}

// ============================================
// STATISTICS & REPORTING ACTIONS
// ============================================

/**
 * Get lifecycle statistics for a brokerage
 */
export async function getBrokerageLifecycleStats(params?: {
  dateFrom?: string
  dateTo?: string
}) {
  const supabase = await createClient()
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage found" }
  }
  
  const stats = await getLifecycleStatistics(supabase, profile.brokerage_id, params)
  
  return {
    success: true,
    statistics: stats,
  }
}

/**
 * Get stage timing metrics for a brokerage
 */
export async function getBrokerageStageTimings(params?: {
  dateFrom?: string
  dateTo?: string
}) {
  const supabase = await createClient()
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage found" }
  }
  
  const timings = await getStageTimingMetrics(supabase, profile.brokerage_id, params)
  
  return {
    success: true,
    timings,
  }
}
