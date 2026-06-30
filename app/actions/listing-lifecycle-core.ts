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
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"

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

  // public_remarks exists (m194); intentionally not set here.
  // Description readiness is handled via showing_instructions or AI generation.
  // The 3 real blockers above (seller contact, list price, photos) are enforced.

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
  await logStageTransition({
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

  // ── Fan out the lifecycle event ───────────────────────────────────────────
  // Maps stage → kernel event so brokerages can wire campaign_sequences AND
  // the seller portal gets a transparency_update card automatically. Every
  // transition also fires a generic LISTING_STAGE_CHANGED so brokerages can
  // listen on the catch-all if they want.
  try {
    const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
    const { KernelEvent } = await import("@/lib/kernel/events")

    const STAGE_TO_EVENT: Record<string, string | undefined> = {
      COMING_SOON_PREP:   KernelEvent.COMING_SOON_SENT,
      COMING_SOON_ACTIVE: KernelEvent.COMING_SOON_SENT,
      ACTIVE:             KernelEvent.LISTING_PUBLISHED,
      UNDER_CONTRACT:     KernelEvent.LISTING_UNDER_CONTRACT,
      WITHDRAWN:          KernelEvent.LISTING_CANCELLED,
      EXPIRED:            KernelEvent.LISTING_EXPIRED,
      CANCELLED:          KernelEvent.LISTING_CANCELLED,
    }

    const stageEvent = STAGE_TO_EVENT[params.targetStage as string]
    const sharedCtx = {
      brokerageId:  listing.brokerage_id,
      entityType:   "listing" as const,
      entityId:     params.listingId,
      listingId:    params.listingId,
      agentUserId:  user.id,
      metadata: {
        from_stage: currentStage,
        to_stage:   params.targetStage,
        notes:      params.notes ?? null,
      },
    }

    // Fire the specific stage event (auto-enrolls + portal update with the
    // event-specific template).
    if (stageEvent) {
      await fanOutKernelEvent({ event: stageEvent as any, ...sharedCtx })
    }

    // Always fire the generic LISTING_STAGE_CHANGED for catch-all sequences
    // and audit. Skipped when the specific event already fired AND duplicates
    // the audit — but it's fine to fire both; idempotency in the fanout
    // dedupes sequence enrollment.
    await fanOutKernelEvent({
      event: KernelEvent.LISTING_STAGE_CHANGED,
      ...sharedCtx,
      metadata: { ...sharedCtx.metadata, mapped_event: stageEvent ?? null },
    })
  } catch (err) {
    console.error("[executeListingTransition] fanOutKernelEvent failed", err)
  }

  // MANAGER HANDOFF (bus) — when a listing reaches coming-soon or goes live, the Listing Concierge →
  // Campaign Orchestrator marketing handoff is announced (visible team play in the managers-talking
  // feed). This now fires from the KERNEL EVENT REACTOR (block F2) on COMING_SOON_SENT / LISTING_PUBLISHED
  // so EVERY transition path gets it — the fanOutKernelEvent above routes through processKernelEvent →
  // the reactor, and the voice/UI path (transitionLifecycle) lands there too. The previous direct call
  // here was redundant (and skipped the voice/UI path), so it was consolidated into the reactor.

  // BACK ON MARKET — a deal fell through (a contract stage → active transition). The normal go-live
  // marketing is idempotent per (listing, just_listed), so a re-list silently re-markets NOTHING and
  // the buyers who SAVED the home are never told it's available again. Hand off to the Shopping Agent
  // to re-engage them (its highest-intent moment). Best-effort; never affects the transition result.
  try {
    const { isBackOnMarket } = await import("@/lib/listings/back-on-market")
    if (isBackOnMarket(currentStage, params.targetStage as string)) {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const { createServiceClient } = await import("@/lib/supabase/service")
      await publishManagerSignal({
        brokerageId: listing.brokerage_id, fromManager: "listing_concierge", toManager: "shopping_agent",
        signalType: "listing_back_on_market", entityType: "listing", entityId: params.listingId,
        message: "A deal fell through — the listing is back on market. Re-engage the buyers who saved it.",
      }, createServiceClient())
    }
  } catch (err) {
    console.error("[executeListingTransition] back-on-market handoff failed", err)
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
      contact_type: LIFETIME_CUSTOMER_TYPE,
      contact_persona: "past_seller",
      status: LIFETIME_CUSTOMER_TYPE,
      notes: `Converted to lifetime customer on ${closedDate} after closing at ${propertyAddress}`,
      updated_at: now,
    })
    .eq("id", contactId)

  // 2. (CONSOLIDATED) The old fixed-calendar post-close sequence (3-day/30-day/6-month 'scheduled' rows)
  //    is retired. Nothing delivered those rows — they sat orphaned (the 6-month never fired). Lifetime
  //    nurture is now the canonical SITUATIONAL model: the newsletter (auto_lifetime) baseline + the
  //    situational reel rail (stale-contact re-engagement → Asset Manager reel → Campaign Orchestrator →
  //    portal CTA, on a LONG-HORIZON cadence) + the equity/anniversary/life-event triggers. The
  //    lifetime-touchpoint reaper remains a safety net for any legacy 'scheduled' rows.

  // 3. Send portal message — brand-voiced via the AI gateway (them-first, Fair-Housing redrafted),
  //    with the canned line as the deterministic FALLBACK floor (the app's rule: client-facing copy is
  //    AI-generated in the agent's voice, never a hardcoded script; the floor only ships if the gateway
  //    is down). generateSellerHandlerCopy resolves the seller's first name from contactId.
  const { generateSellerHandlerCopy } = await import("@/lib/agents/seller-handler-copy")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const closingCopy = await generateSellerHandlerCopy({
    brokerageId,
    contactId,
    purpose:
      "Warmly congratulate the seller on their successful closing, let them know their portal now reflects their new status, and that you remain their lifetime real estate resource. Short, genuine, no pressure.",
    facts: propertyAddress ? [{ label: "Property just sold", value: propertyAddress }] : undefined,
    fallback: {
      subject: "Congratulations on your closing!",
      body: `Congratulations on your successful closing! Your portal is now updated to reflect your homeowner status. We look forward to being your lifetime real estate resource.`,
    },
  }, createServiceClient())
  await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      brokerage_id: brokerageId,
      agent_id: agentId,
      body: closingCopy.body,
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
