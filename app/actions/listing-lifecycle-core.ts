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
  getLifecycleStatistics,
  getStageTimingMetrics,
} from "@/lib/listing-lifecycle"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"

// ═══════════════════════════════════════════════════════════════════════════════
// CALLER CONTEXT — auth + tenant, resolved once
// ═══════════════════════════════════════════════════════════════════════════════

type CallerContext = {
  userId: string
  brokerageId: string
  /** The caller's raw users.user_type — the LIVE vocabulary, not the engine's. */
  userType: string
  /** users.user_type mapped onto the stage engine's RequiredRole vocabulary. */
  role: LifecycleRole | null
}

/**
 * THE ROLE VOCABULARY GAP.
 *
 * The stage engine gates on `RequiredRole = "agent" | "team_lead" | "broker" | "admin"`
 * (lib/listing-lifecycle/lifecycle-definitions.ts) and EVERY stage definition lists
 * exactly those four. The live database disagrees. `users_user_type_check` admits
 * fourteen values:
 *
 *   admin, agent, broker, broker_owner, compliance_officer, contact, isa, lender,
 *   superadmin, support, system, tc, team_lead, vendor
 *
 * Five of those are staff who can plausibly run a listing, and four of the five are
 * INVISIBLE to the engine. The callers gate on the live vocabulary — the lifecycle
 * page computes
 *
 *   canOverride = ["broker","broker_owner","admin","team_lead","superadmin"].includes(user_type)
 *
 * — so a broker_owner or superadmin is SHOWN the override control, ticks it, supplies
 * a reason, and is then refused by validateStageTransition, whose override path only
 * recognises "admin" and "broker". getNextAllowedStages returns [] for them at every
 * stage, and canSkipStages says false. The owner of the brokerage could not advance
 * their own listing, and the UI never said why.
 *
 * This is the translation step. It is deliberately CONSERVATIVE — it maps only the
 * two roles that are unambiguous supersets of an engine role, and refuses the rest
 * rather than inventing authority nobody granted:
 *
 *   broker_owner → broker   (a broker_owner IS a broker, plus ownership)
 *   superadmin   → admin    (platform admin ⊇ brokerage admin)
 *
 * compliance_officer / tc / isa / lender / vendor / contact / support / system get
 * `null`. They are real staff, but "can advance a listing's lifecycle stage" is an
 * authority the owner has not granted them, and quietly promoting a transaction
 * coordinator to agent authority would be this file inventing a rule. `null` produces
 * an honest, named refusal instead of a silent one.
 */
type LifecycleRole = "agent" | "team_lead" | "broker" | "admin"

const USER_TYPE_TO_LIFECYCLE_ROLE: Record<string, LifecycleRole> = {
  agent:        "agent",
  team_lead:    "team_lead",
  broker:       "broker",
  broker_owner: "broker",
  admin:        "admin",
  superadmin:   "admin",
}

function normalizeLifecycleRole(rawUserType: string | null | undefined): LifecycleRole | null {
  const key = (rawUserType ?? "").trim().toLowerCase()
  if (!key) return null
  return USER_TYPE_TO_LIFECYCLE_ROLE[key] ?? null
}

/** Human-readable refusal for a role the engine has no seat for. */
function unauthorizedRoleMessage(rawUserType: string): string {
  return `Role "${rawUserType}" is not authorized to change a listing's lifecycle stage. ` +
         `Stage authority is held by: agent, team_lead, broker, broker_owner, admin, superadmin.`
}

async function resolveCallerContext(): Promise<CallerContext | { error: string }> {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: `Not authenticated: ${authError.message}` }
  if (!user)     return { error: "Not authenticated" }

  // Destructure `error`. supabase-js RESOLVES a refused read, so `{ data: profile }`
  // alone turns an RLS refusal into "user profile not found" — a different and
  // misleading verdict.
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (profileError) return { error: `Could not read your profile: ${profileError.message}` }
  if (!profile)     return { error: "User profile not found" }
  if (!profile.brokerage_id) return { error: "No brokerage found for this user" }

  // users.user_type is NOT NULL on the live schema, so `user_type ?? role` never
  // reaches `role`. users.role is unconstrained free text (live values include
  // "Admin" and "Lender" — capitalised), so it is only a fallback and is normalised
  // the same way.
  const rawUserType = (profile.user_type as string | null) || (profile.role as string | null) || ""

  return {
    userId:      user.id,
    brokerageId: profile.brokerage_id as string,
    userType:    rawUserType,
    role:        normalizeLifecycleRole(rawUserType),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CURRENT STAGE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE STAGE READ THAT ALWAYS RETURNED NULL.
 *
 * lib/listing-lifecycle/lifecycle-logger.ts::getCurrentLifecycleStage resolves the
 * current stage by reading `activities` for
 *
 *   activity_type = 'listing_lifecycle_transition'
 *
 * NOTHING IN THIS CODEBASE HAS EVER WRITTEN THAT ROW. logStageTransition routes
 * through transitionLifecycle(), which writes `lifecycle_events` with
 * entity_type='listing_stage_machine' and updates `listings.lifecycle_stage`. The
 * activities probe is a dead vocabulary. Live count of rows carrying that
 * activity_type: 0. Live listings sitting at a non-default lifecycle_stage: 3.
 *
 * So getCurrentLifecycleStage returned null for every listing, and everything built
 * on it failed the same way:
 *
 *   · validateStageTransition with currentStage=null takes the "must be first stage"
 *     branch and refuses any target whose allowedFrom is non-empty — i.e. every
 *     stage but LEAD. Every advance the pipeline offered was refused.
 *   · executeListingTransition therefore logged a FAILED transition every time.
 *   · checkSystemGate / getEnabledGates answered "listing has no lifecycle stage"
 *     for a listing plainly sitting at MLS_ACTIVE — a gate reading "closed" because
 *     the query looked in the wrong place.
 *   · getListingNextStages answered ["LEAD"] for every listing in the system.
 *
 * `listings.lifecycle_stage` is the column the database actually maintains: NOT NULL,
 * DEFAULT 'LEAD', and CHECK-constrained to exactly the 34 ListingStage values. It is
 * what the lifecycle page renders from. It is the authority here.
 *
 * Returns a discriminated result so a FAILED read is never mistaken for "no stage" —
 * a gate must not read clean because the query was refused.
 */
type StageResolution =
  | { ok: true;  stage: ListingStage | null; brokerageId: string | null; agentRecordId: string | null }
  | { ok: false; error: string }

async function resolveCurrentStage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  brokerageId?: string,
): Promise<StageResolution> {
  let query = supabase
    .from("listings")
    .select("lifecycle_stage, brokerage_id, agent_id")
    .eq("id", listingId)
  // Tenant anchor whenever the caller knows it. The RLS client scopes this already;
  // the explicit filter means the query is still correct if it is ever handed a
  // service-role client, which bypasses RLS entirely.
  if (brokerageId) query = query.eq("brokerage_id", brokerageId)

  const { data, error } = await query.maybeSingle()

  if (error) return { ok: false, error: `Could not read the listing's stage: ${error.message}` }
  if (!data)  return { ok: false, error: "Listing not found in your brokerage" }

  const stored = (data.lifecycle_stage as string | null)?.trim() || null

  // Fall back to the stage-machine event log only when the column is somehow empty.
  // Same rule: a failed read is an error, not an absence.
  if (!stored) {
    const { data: lastEvent, error: eventError } = await supabase
      .from("lifecycle_events")
      .select("metadata")
      .eq("entity_type", "listing_stage_machine")
      .eq("entity_id", listingId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (eventError) {
      return { ok: false, error: `Could not read the listing's stage history: ${eventError.message}` }
    }
    const fromEvent = ((lastEvent?.metadata as Record<string, unknown> | null)?.to_state as string | null) ?? null
    return {
      ok: true,
      stage: (fromEvent as ListingStage | null) ?? null,
      brokerageId: (data.brokerage_id as string | null) ?? null,
      agentRecordId: (data.agent_id as string | null) ?? null,
    }
  }

  return {
    ok: true,
    stage: stored as ListingStage,
    brokerageId: (data.brokerage_id as string | null) ?? null,
    agentRecordId: (data.agent_id as string | null) ?? null,
  }
}

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

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  // A role the engine has no seat for is refused BY NAME, before anything else
  // runs. This used to fall through as userRole="agent"-ish free text into
  // validateRoleAuthority and come back as a generic mismatch.
  if (!ctx.role) {
    return {
      success: true,
      validation: {
        allowed: false,
        reason: unauthorizedRoleMessage(ctx.userType),
        warnings: [],
        currentStage: null,
        targetStage: params.targetStage,
        readinessChecks: { allPassed: false, passed: [], failed: [], results: [] },
        nextAllowedStages: [],
      },
    }
  }

  // Current stage — from listings.lifecycle_stage, tenant-anchored. A failed read
  // is surfaced, never silently treated as "this listing has no stage".
  const stageRead = await resolveCurrentStage(supabase, params.listingId, ctx.brokerageId)
  if (!stageRead.ok) return { success: false, error: stageRead.error }
  const currentStage = stageRead.stage

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

  const resolvedRole = ctx.role

  // Validate transition
  const validationContext: TransitionValidationContext = {
    currentStage,
    targetStage: params.targetStage,
    userRole: resolvedRole,
    userId: ctx.userId,
    listingId: params.listingId,
    completedReadinessChecks: readinessEval.passedChecks,
    isAdminOverride: !!params.overrideReason,
    overrideReason: params.overrideReason,
  }

  const validation = validateStageTransition(validationContext)

  // ── Launch gate: block if required listing data is missing ────────────────
  // Evaluated after the stage-machine check so the stage-machine always wins.
  //
  // DEAD VOCABULARY REMOVED. This set read
  //   {active, launch_ready, mls_active, published, ACTIVE, LAUNCH_READY, MLS_ACTIVE, PUBLISHED}
  // of which exactly ONE — MLS_ACTIVE — is a real ListingStage. The other seven
  // could never match `params.targetStage`, which is typed as ListingStage and
  // CHECK-constrained in the database to the canonical 34. COMING_SOON_ACTIVE is
  // added because it is a genuinely PUBLIC stage (it is what turns on the
  // marketing_execution gate), and putting a property in front of buyers with no
  // seller contact, no price and no photos is the same mistake at either door.
  const LAUNCH_STAGES = new Set<ListingStage>(["MLS_ACTIVE", "COMING_SOON_ACTIVE"])
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

// ── Launch blocker read guard ───────────────────────────────────────────────
// A count query that FAILS resolves with { count: null, error }. Treating that
// null as 0 would report "0 photos uploaded" for a refused read — a blocker
// message that names the wrong problem. Callers below check `error` first.

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

  // A REFUSED READ IS NOT A CLEAN ONE. supabase-js resolves a failed query, so
  // destructuring only `.data`/`.count` turned an RLS refusal into "no seller
  // contact, no price, 0 photos" — three invented blockers naming the wrong
  // problem — or, worse for the count queries, would have waved a launch through
  // if the defaults had gone the other way. Each failure is now named.
  if (listingResult.error) return [`Listing record could not be read — ${listingResult.error.message}`]

  const listing = listingResult.data
  if (!listing) return ["Listing record not found"]

  if (!listing.seller_contact_id) {
    blockers.push("No seller contact linked")
  }
  if (!listing.list_price) {
    blockers.push("No list price set")
  }

  // Count photos from both tables and take the max
  if (photoCountResult.error && mediaCountResult.error) {
    blockers.push(
      `Photo count could not be read — ${photoCountResult.error.message}. Resolve before launching.`,
    )
  } else {
    const photoCountA = photoCountResult.error ? 0 : (photoCountResult.count ?? 0)
    const photoCountB = mediaCountResult.error ? 0 : (mediaCountResult.count ?? 0)
    const photoCount = Math.max(photoCountA, photoCountB)
    // Minimum 5 photos per spec
    if (photoCount < 5) {
      blockers.push(`Photos: need at least 5 (${photoCount} uploaded)`)
    }
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
  
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  if (!ctx.role) {
    return { success: false, error: unauthorizedRoleMessage(ctx.userType) }
  }

  // Listing + current stage, tenant-anchored, in one error-checked read.
  const stageRead = await resolveCurrentStage(supabase, params.listingId, ctx.brokerageId)
  if (!stageRead.ok) return { success: false, error: stageRead.error }

  const currentStage = stageRead.stage
  const listing = {
    id:           params.listingId,
    // IDENTITY CLASS. listings.agent_id FKs agents(id) — verified against
    // pg_constraint (`listings_agent_id_fkey → agents(id)`). It is NOT a users.id.
    agent_id:     stageRead.agentRecordId,
    brokerage_id: stageRead.brokerageId ?? ctx.brokerageId,
  }

  const user = { id: ctx.userId }
  const profile = { user_type: ctx.role }

  // agents.id for the listing's agent, or "" when the listing has none. The
  // logger's LifecycleEventData.agentId is typed string; "" keeps the identity
  // class honest (an absent agents.id, NOT a users.id substituted in its place).
  const listingAgentRecordId: string = listing.agent_id ?? ""

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
      agentId: listingAgentRecordId,
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
    agentId: listingAgentRecordId,
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
        agentId: listingAgentRecordId,
        brokerageId: listing.brokerage_id,
        stage: params.targetStage,
        gateName,
      })
    }
  }

  // ── CLOSED: Convert seller to lifetime customer ───────────────────────────
  if (params.targetStage === "CLOSED") {
    await handleSellerToLifetimeTransition(supabase, params.listingId, listingAgentRecordId, listing.brokerage_id)
  }

  // ── Fan out the lifecycle event ───────────────────────────────────────────
  // Maps stage → kernel event so brokerages can wire campaign_sequences AND
  // the seller portal gets a transparency_update card automatically. Every
  // transition also fires a generic LISTING_STAGE_CHANGED so brokerages can
  // listen on the catch-all if they want.
  try {
    const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
    const { KernelEvent } = await import("@/lib/kernel/events")

    // DEAD VOCABULARY REMOVED — this map was keyed on stages that do not exist.
    //
    // `params.targetStage` is a ListingStage, and listings.lifecycle_stage is
    // CHECK-constrained to exactly those 34 values. Four of this map's seven keys
    // — ACTIVE, WITHDRAWN, EXPIRED, CANCELLED — are not among them and never could
    // be. The lookup missed on all four, so LISTING_PUBLISHED, LISTING_CANCELLED
    // and LISTING_EXPIRED were UNREACHABLE: going live on the MLS, cancelling a
    // listing and letting one expire each fired only the generic
    // LISTING_STAGE_CHANGED, and every campaign_sequence or portal template a
    // brokerage had wired to those three specific events sat silent forever.
    //
    // The keys below are the real stage names. Verified against
    // listings_lifecycle_stage_check on the live database.
    const STAGE_TO_EVENT: Partial<Record<ListingStage, string | undefined>> = {
      COMING_SOON_PREP:   KernelEvent.COMING_SOON_SENT,
      COMING_SOON_ACTIVE: KernelEvent.COMING_SOON_SENT,
      MLS_ACTIVE:         KernelEvent.LISTING_PUBLISHED,
      UNDER_CONTRACT:     KernelEvent.LISTING_UNDER_CONTRACT,
      LISTING_CANCELLED:  KernelEvent.LISTING_CANCELLED,
      LISTING_EXPIRED:    KernelEvent.LISTING_EXPIRED,
    }

    const stageEvent = STAGE_TO_EVENT[params.targetStage]
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
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      // (a) DEMAND side — re-engage the buyers who SAVED it (Shopping Agent's highest-intent moment).
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId: listing.brokerage_id, fromManager: "listing_concierge", toManager: "shopping_agent",
        signalType: "listing_back_on_market", entityType: "listing", entityId: params.listingId,
        message: "A deal fell through — the listing is back on market. Re-engage the buyers who saved it.",
      }, svc)
      // (b) SUPPLY side — RE-MARKET the listing itself across channels (video + social + mail), the same
      // way just_listed does. The normal just_listed promo is idempotent per (listing, just_listed) so a
      // re-list silently re-markets NOTHING; back_on_market is its own lifecycle promo event. Policy-gated
      // (auto_spawn default ON, debounced) + compliance-gated inside the reactors.
      //
      // IDENTITY CLASS — CORRECTED. The previous comment here asserted that
      // listings.agent_id is "already a users.id on the live schema" and passed it
      // straight in as `agentUserId`. It is not. pg_constraint says
      //
      //   listings_agent_id_fkey  FOREIGN KEY (agent_id) REFERENCES agents(id)
      //
      // agents.id and users.id are different id spaces. Handing an agents.id to a
      // parameter named agentUserId meant both reactors looked up a user that does
      // not exist, so the back-on-market video and mail never went out — silently,
      // because both are dispatched with `void` and never awaited. Resolved through
      // the canonical helper; when no users.id can be resolved we skip rather than
      // dispatch against the wrong id space. Best-effort — never blocks the transition.
      const agentUserId = listingAgentRecordId
        ? await resolveAgentRecordToUserId(listingAgentRecordId)
        : null
      if (!agentUserId && listingAgentRecordId) {
        console.error(
          "[executeListingTransition] back-on-market: no users.id for agents.id",
          listingAgentRecordId,
          "— re-marketing skipped rather than dispatched against the wrong id space",
        )
      }
      if (agentUserId) {
        const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
        void dispatchListingPromoVideo({ brokerageId: listing.brokerage_id, listingId: params.listingId, agentUserId, eventType: "back_on_market" })
        const { dispatchLifecycleMail } = await import("@/lib/direct-mail/listing-lifecycle-mail-reactor")
        void dispatchLifecycleMail({ brokerageId: listing.brokerage_id, listingId: params.listingId, agentUserId, eventType: "back_on_market" })
      }
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
  // agentId here is an agents.id (listings.agent_id → agents(id)), and both
  // client_portal_messages.agent_id and agents.id below are the SAME id space —
  // verified via pg_constraint (cpm_agent_id_fkey → agents(id)). "" means the
  // listing has no agent record; it must become NULL, not an empty uuid string
  // that fails the FK.
  const agentRecordId: string | null = agentId?.trim() ? agentId : null

  // Fetch listing with seller contact and address
  const { data: listingWithContact, error: listingError } = await supabase
    .from("listings")
    .select("seller_contact_id, address, city, state")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (listingError) {
    console.error("[handleSellerToLifetimeTransition] listing read failed — seller NOT converted:", listingError.message)
    return
  }
  if (!listingWithContact?.seller_contact_id) return

  const { seller_contact_id: contactId, address, city, state } = listingWithContact
  const propertyAddress = [address, city, state].filter(Boolean).join(", ")
  const now = new Date().toISOString()
  const closedDate = new Date().toLocaleDateString()

  // 1. Convert contact to lifetime customer.
  //    THIS IS THE WHOLE POINT OF CLOSING A LISTING and it was fire-and-forget.
  //    supabase-js resolves a refused update, so a contact that failed the
  //    contacts_lifetime_consistent CHECK — or was simply out of RLS scope — stayed
  //    an ordinary contact while the UI showed the celebration card claiming they
  //    had been converted. Tenant-anchored and checked.
  const { error: convertError } = await supabase
    .from("contacts")
    .update({
      contact_type: LIFETIME_CUSTOMER_TYPE,
      contact_persona: "past_seller",
      status: LIFETIME_CUSTOMER_TYPE,
      notes: `Converted to lifetime customer on ${closedDate} after closing at ${propertyAddress}`,
      updated_at: now,
    })
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)

  if (convertError) {
    console.error(
      "[handleSellerToLifetimeTransition] seller was NOT converted to a lifetime customer:",
      convertError.message,
    )
  }

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
  const { error: portalError } = await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      brokerage_id: brokerageId,
      // agents.id — same id space as the FK. NOT a users.id.
      agent_id: agentRecordId,
      body: closingCopy.body,
      direction: "agent_to_client",
    })

  if (portalError) {
    console.error(
      "[handleSellerToLifetimeTransition] closing message never reached the seller's portal:",
      portalError.message,
    )
  }

  // 4. Increment agent gamification points (agents.gamification_points).
  //    agentRecordId is an agents.id — the correct key for this table.
  if (agentRecordId) {
    const { data: agentRow, error: agentReadError } = await supabase
      .from("agents")
      .select("id, gamification_points")
      .eq("id", agentRecordId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (agentReadError) {
      console.error("[handleSellerToLifetimeTransition] agent read failed, points not awarded:", agentReadError.message)
    } else if (agentRow) {
      const { error: pointsError } = await supabase
        .from("agents")
        .update({ gamification_points: (agentRow.gamification_points ?? 0) + 50 })
        .eq("id", agentRecordId)
        .eq("brokerage_id", brokerageId)

      if (pointsError) {
        console.error("[handleSellerToLifetimeTransition] points not awarded:", pointsError.message)
      }
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
 * Get lifecycle history for a listing.
 *
 * DEFENDS AGAINST lib/listing-lifecycle/lifecycle-logger.ts:193. getLifecycleHistory
 * there reads lifecycle_events with `const { data } = await supabase...` and returns
 * `data ?? []`. supabase-js RESOLVES a refused query, so a read that fails — RLS
 * refusal, bad column, dropped connection — comes back as an EMPTY HISTORY that is
 * indistinguishable from "this listing has never transitioned". A timeline is exactly
 * the surface where those two must not look alike.
 *
 * The fix belongs in lib/ (see the report). Since lib/ is out of scope here, this
 * action runs its own error-checked, tenant-anchored read first and reports the
 * failure rather than handing back a clean-looking empty list.
 */
export async function getListingLifecycleHistory(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()

  // Tenant anchor: confirm the listing is ours before reading its history at all.
  const stageRead = await resolveCurrentStage(supabase, listingId, ctx.brokerageId)
  if (!stageRead.ok) return { success: false, error: stageRead.error }

  const { data, error } = await supabase
    .from("lifecycle_events")
    .select("id, created_at, metadata, actor_user_id, event_type")
    .eq("entity_type", "listing_stage_machine")
    .eq("entity_id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: true })

  if (error) {
    return { success: false, error: `Lifecycle history could not be read — ${error.message}` }
  }

  const history = (data ?? []).map((e) => {
    const meta = (e.metadata ?? {}) as Record<string, unknown>
    return {
      id:         e.id as string,
      timestamp:  e.created_at as string,
      fromStage:  (meta.from_state ?? meta.from_stage ?? null) as ListingStage | null,
      toStage:    (meta.to_state ?? meta.to_stage ?? null) as ListingStage | null,
      userId:     (e.actor_user_id as string | null) ?? null,
      isOverride: meta.is_override === true,
      notes:      (meta.notes as string | null) ?? null,
      failed:     typeof e.event_type === "string" && e.event_type.includes("FAILED"),
    }
  })

  return {
    success: true,
    currentStage: stageRead.stage,
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

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const stageRead = await resolveCurrentStage(supabase, listingId, ctx.brokerageId)
  if (!stageRead.ok) return { success: false, error: stageRead.error }

  return {
    success: true,
    currentStage: stageRead.stage,
  }
}

/**
 * Get next allowed stages for a listing — filtered by what THIS CALLER may actually do.
 *
 * This is the action that closes the role-vocabulary gap. The lifecycle page computes
 * its own `validNextStages` purely from the stage graph:
 *
 *   allStages.filter(s => s.allowedFrom.includes(currentStage))
 *
 * with NO role filter at all, so every user is offered every structurally-reachable
 * stage regardless of authority. This returns the same list intersected with the
 * caller's real authority, using the normalised role — so a broker_owner or superadmin
 * gets the full set instead of the empty set the raw user_type produced.
 */
export async function getListingNextStages(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const stageRead = await resolveCurrentStage(supabase, listingId, ctx.brokerageId)
  if (!stageRead.ok) return { success: false, error: stageRead.error }

  // A role with no seat in the engine gets an honest empty set AND the reason,
  // rather than an empty set that looks like "nothing is reachable from here".
  if (!ctx.role) {
    return {
      success: true,
      currentStage: stageRead.stage,
      nextStages: [] as ListingStage[],
      canSkipStages: false,
      role: null,
      unauthorizedReason: unauthorizedRoleMessage(ctx.userType),
    }
  }

  const currentStage = stageRead.stage
  if (!currentStage) {
    return {
      success: true,
      currentStage: null,
      nextStages: ["LEAD"] as ListingStage[],
      canSkipStages: canSkipStages(ctx.role),
      role: ctx.role,
    }
  }

  return {
    success: true,
    currentStage,
    nextStages: getNextAllowedStages(currentStage, ctx.role),
    canSkipStages: canSkipStages(ctx.role),
    role: ctx.role,
  }
}

// ============================================
// SYSTEM GATE QUERY ACTIONS
// ============================================

/**
 * Check whether one named system gate is open for a listing.
 *
 * A gate is a permission the lifecycle grants at a stage — "marketing_execution",
 * "offers_system", "seller_showings". Because this hung off the writer-less
 * activities probe it answered `enabled: false, "Listing has no lifecycle stage"`
 * for every listing in the system, including ones plainly sitting at MLS_ACTIVE.
 * A gate that reads closed because the query looked in the wrong place is the exact
 * failure mode this rail is supposed to prevent.
 */
export async function checkSystemGate(params: {
  listingId: string
  gateName: string
}) {
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  if (!params.gateName?.trim()) {
    return { success: false, error: "Gate name is required" }
  }

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const stageRead = await resolveCurrentStage(supabase, params.listingId, ctx.brokerageId)
  // A gate whose stage could not be READ is not an open gate and not a closed one —
  // it is unknown, and it says so instead of returning a confident `false`.
  if (!stageRead.ok) return { success: false, error: stageRead.error }

  const currentStage = stageRead.stage
  if (!currentStage) {
    return {
      success: true,
      enabled: false,
      currentStage: null,
      gateName: params.gateName,
      reason: "Listing has no lifecycle stage",
    }
  }

  return {
    success: true,
    enabled: isSystemGateEnabled(currentStage, params.gateName),
    currentStage,
    gateName: params.gateName,
  }
}

/**
 * Get every system gate the listing's current stage has opened.
 */
export async function getEnabledGates(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const stageRead = await resolveCurrentStage(supabase, listingId, ctx.brokerageId)
  if (!stageRead.ok) return { success: false, error: stageRead.error }

  const currentStage = stageRead.stage
  if (!currentStage) {
    return {
      success: true,
      currentStage: null,
      enabledGates: [] as string[],
      reason: "Listing has no lifecycle stage",
    }
  }

  return {
    success: true,
    currentStage,
    enabledGates: getEnabledSystemGates(currentStage),
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

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }
  const profile = { brokerage_id: ctx.brokerageId }
  
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

  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }
  const profile = { brokerage_id: ctx.brokerageId }
  
  const timings = await getStageTimingMetrics(supabase, profile.brokerage_id, params)
  
  return {
    success: true,
    timings,
  }
}
