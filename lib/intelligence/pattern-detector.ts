"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { computeDaysOnMarketOrZero } from "@/lib/listings/compute-dom"

// ─── Types ───────────────────────────────────────────────────────────────────
export interface BehavioralPattern {
  id: string
  pattern_slug: string
  pattern_name: string
  entity_type: "buyer" | "seller" | "negotiation"
  pattern_type: string
  description: string
  recommended_action: string
  detection_rules: {
    signals?: string[]
    min_showings?: number
    min_views?: number
    velocity?: "accelerating" | "decelerating" | "stable"
    min_dom?: number
    offer_count?: number
    days_no_showing?: number
    portal_visits_declining?: boolean
    min_counters?: number
    price_gap_pct?: number
    response_time_hours?: number
    mentions_timeline?: boolean
    silent_hours?: number
    stage?: string[]
    multi_contact_interest?: boolean
    no_preapproval?: boolean
    timeline_days?: number
    budget_adjusted_down?: boolean
  }
  minimum_signals: number
  confidence_threshold: number
}

export interface PatternDetection {
  id: string
  pattern_id: string
  entity_type: string
  entity_id: string
  agent_id: string
  brokerage_id: string
  confidence: number
  trigger_signals: Record<string, unknown>
  ai_reasoning: string | null
  pattern_type: string
  status: "active" | "acknowledged" | "dismissed"
  expires_at: string
  created_at: string
}

interface EntitySignals {
  // Contact (buyer) signals
  signalCounts?: Record<string, number>
  totalSignals?: number
  engagementVelocity?: "accelerating" | "decelerating" | "stable"
  showingCount?: number
  lastShowingDate?: string | null
  daysSinceLastShowing?: number | null
  buyerStage?: string | null
  timeline?: string | null
  financingStatus?: string | null
  hasPreapproval?: boolean
  budgetAdjustedDown?: boolean
  predictedReadyToOffer?: boolean
  predictedFatigueRisk?: boolean
  predictionConfidence?: number
  
  // Listing (seller) signals
  daysOnMarket?: number
  listingStatus?: string
  listingPrice?: number
  lifecycleStage?: string
  offerCount?: number
  avgResponseTimeHours?: number
  mentionsTimeline?: boolean
  
  // Negotiation signals
  counterOfferCount?: number
  priceGapPercent?: number
  silentHours?: number
  currentStage?: string
  multiContactInterest?: boolean
  
  // Meta
  lastSignalDate?: string | null
}

// ─── Complex patterns that need AI evaluation ────────────────────────────────
const COMPLEX_PATTERNS = [
  "contentious_negotiation",
  "high_motivation_seller",
  "deal_collapse_risk",
]

// ─── Main Scanner Function ───────────────────────────────────────────────────
export async function scanEntityForPatterns(
  entityType: "contact" | "listing",
  entityId: string,
  brokerageId: string,
  agentId?: string
): Promise<PatternDetection[]> {
  const supabase = createServiceClient()
  const now = new Date()
  const newDetections: PatternDetection[] = []

  // 1. Load active patterns for this entity type
  const patternEntityTypes =
    entityType === "contact"
      ? ["buyer", "negotiation"]
      : ["seller", "negotiation"]

  const { data: patterns, error: patternsError } = await supabase
    .from("behavioral_patterns")
    .select("*")
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .in("entity_type", patternEntityTypes)
    .eq("is_active", true)

  if (patternsError || !patterns || patterns.length === 0) {
    return []
  }

  // 2. Fetch entity signals
  const signals = await fetchEntitySignals(entityType, entityId, brokerageId)

  // Skip if no new signals since last scan (cost control)
  if (signals.lastSignalDate) {
    const { data: lastScan } = await supabase
      .from("pattern_detections")
      .select("created_at")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (
      lastScan &&
      new Date(lastScan.created_at) > new Date(signals.lastSignalDate)
    ) {
      // No new signals since last scan - skip AI calls but still do rule checks
    }
  }

  // Resolve agent_id if not provided
  let resolvedAgentId = agentId
  if (!resolvedAgentId) {
    if (entityType === "contact") {
      const { data: contact } = await supabase
        .from("contacts")
        .select("agent_id")
        .eq("id", entityId)
        .single()
      resolvedAgentId = contact?.agent_id
    } else {
      const { data: listing } = await supabase
        .from("listings")
        .select("agent_id")
        .eq("id", entityId)
        .single()
      resolvedAgentId = listing?.agent_id
    }
  }

  if (!resolvedAgentId) {
    return []
  }

  // 3. Evaluate each pattern
  for (const pattern of patterns as BehavioralPattern[]) {
    // Check if active detection already exists
    const { data: existingDetection } = await supabase
      .from("pattern_detections")
      .select("id")
      .eq("pattern_id", pattern.id)
      .eq("entity_id", entityId)
      .eq("status", "active")
      .single()

    if (existingDetection) {
      continue // Don't double-fire
    }

    // Evaluate pattern
    const evaluation = await evaluatePattern(pattern, signals, entityType)

    if (
      evaluation.matches &&
      evaluation.confidence >= pattern.confidence_threshold
    ) {
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

      // Insert pattern_detections
      const { data: detection, error: detectionError } = await supabase
        .from("pattern_detections")
        .insert({
          pattern_id: pattern.id,
          entity_type: entityType,
          entity_id: entityId,
          agent_id: resolvedAgentId,
          brokerage_id: brokerageId,
          confidence: evaluation.confidence,
          trigger_signals: evaluation.triggerSignals,
          ai_reasoning: evaluation.reasoning,
          pattern_type: pattern.pattern_type,
          status: "active",
          expires_at: expiresAt.toISOString(),
          compliance_approved: false,
        })
        .select()
        .single()

      if (detectionError || !detection) {
        console.error("Failed to insert pattern detection:", detectionError)
        continue
      }

      // Insert pattern_predictions
      const { data: prediction } = await supabase
        .from("pattern_predictions")
        .insert({
          detection_id: detection.id,
          entity_type: entityType,
          entity_id: entityId,
          brokerage_id: brokerageId,
          prediction_label: pattern.pattern_name,
          predicted_event: pattern.pattern_type,
          predicted_within_days: 7,
          probability: evaluation.confidence,
          recommended_action: pattern.recommended_action,
          compliance_approved: false,
        })
        .select()
        .single()

      // Insert smart_assistant_suggestions
      await supabase.from("smart_assistant_suggestions").insert({
        agent_id: resolvedAgentId,
        brokerage_id: brokerageId,
        title: pattern.recommended_action,
        description:
          evaluation.reasoning || `Pattern detected: ${pattern.pattern_name}`,
        priority: evaluation.confidence >= 0.8 ? "high" : "medium",
        context_type: "behavioral_pattern",
        context_id: detection.id,
        suggested_action: pattern.recommended_action,
      })

      // emitKernelEvent does INSERT + reactor fan-out (notifications + sequences + portal) in one
      // call. Bare lifecycle_events inserts dropped agent notifications for new pattern detections.
      await emitKernelEvent({
        event:       KernelEvent.BEHAVIORAL_PATTERN_DETECTED,
        brokerageId,
        entityType,
        entityId,
        agentUserId: resolvedAgentId,
        metadata: {
          pattern_id:   pattern.id,
          pattern_slug: pattern.pattern_slug,
          pattern_name: pattern.pattern_name,
          confidence:   evaluation.confidence,
          detection_id: detection.id,
        },
      })

      // Emit PREDICTION_CREATED
      if (prediction) {
        await emitKernelEvent({
          event:       KernelEvent.PREDICTION_CREATED,
          brokerageId,
          entityType,
          entityId,
          agentUserId: resolvedAgentId,
          metadata: {
            prediction_id:    prediction.id,
            detection_id:     detection.id,
            prediction_label: pattern.pattern_name,
            probability:      evaluation.confidence,
          },
        })
      }

      newDetections.push(detection as PatternDetection)
    }
  }

  return newDetections
}

// ─── Fetch Entity Signals ────────────────────────────────────────────────────
async function fetchEntitySignals(
  entityType: "contact" | "listing",
  entityId: string,
  brokerageId: string
): Promise<EntitySignals> {
  const supabase = createServiceClient()
  const now = new Date()
  const d30ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const d14ago = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const d7ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  if (entityType === "contact") {
    // Buyer signals
    const [logsResult, predictionsResult, showingsResult, contactResult] =
      await Promise.all([
        // Behavior logs last 30 days
        supabase
          .from("buyer_behavior_log")
          .select("signal_type, created_at")
          .eq("contact_id", entityId)
          .eq("brokerage_id", brokerageId)
          .gte("created_at", d30ago)
          .order("created_at", { ascending: false }),

        // Buyer predictions
        supabase
          .from("buyer_behavior_predictions")
          .select("*")
          .eq("contact_id", entityId)
          .single(),

        // Showings for this contact
        supabase
          .from("showings")
          .select("id, scheduled_at")
          .eq("contact_id", entityId)
          .eq("status", "completed")
          .order("scheduled_at", { ascending: false }),

        // Contact details
        supabase
          .from("contacts")
          .select("buyer_stage, timeline, lender_status")
          .eq("id", entityId)
          .single(),
      ])

    const logs = logsResult.data || []
    const predictions = predictionsResult.data
    const showings = showingsResult.data || []
    const contact = contactResult.data

    // Count signals by type
    const signalCounts: Record<string, number> = {}
    logs.forEach((log) => {
      signalCounts[log.signal_type] = (signalCounts[log.signal_type] || 0) + 1
    })

    // Calculate engagement velocity
    const recentLogs = logs.filter(
      (l) => new Date(l.created_at) >= new Date(d7ago)
    )
    const olderLogs = logs.filter(
      (l) =>
        new Date(l.created_at) < new Date(d7ago) &&
        new Date(l.created_at) >= new Date(d14ago)
    )

    let engagementVelocity: "accelerating" | "decelerating" | "stable" = "stable"
    if (recentLogs.length > olderLogs.length * 1.5) {
      engagementVelocity = "accelerating"
    } else if (recentLogs.length < olderLogs.length * 0.5) {
      engagementVelocity = "decelerating"
    }

    const lastShowing = showings[0]
    const daysSinceLastShowing = lastShowing
      ? Math.floor(
          (now.getTime() - new Date(lastShowing.scheduled_at).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null

    return {
      signalCounts,
      totalSignals: logs.length,
      engagementVelocity,
      showingCount: showings.length,
      lastShowingDate: lastShowing?.scheduled_at || null,
      daysSinceLastShowing,
      buyerStage: contact?.buyer_stage,
      timeline: contact?.timeline,
      financingStatus: contact?.lender_status,
      hasPreapproval: contact?.lender_status === "pre_approved",
      predictedReadyToOffer: predictions?.predicted_ready_to_offer,
      predictedFatigueRisk: predictions?.predicted_fatigue_risk,
      predictionConfidence: predictions?.confidence,
      lastSignalDate: logs[0]?.created_at || null,
    }
  } else {
    // Listing (seller) signals. DOM is computed from go_live_date; the
    // `days_on_market` column does not exist on listings.
    const [listingResult, showingsResult, offersResult] = await Promise.all([
      supabase
        .from("listings")
        .select("go_live_date, status, list_price, lifecycle_stage, created_at")
        .eq("id", entityId)
        .single(),

      supabase
        .from("showings")
        .select("id, scheduled_at")
        .eq("listing_id", entityId)
        .eq("status", "completed"),

      supabase
        .from("offers")
        .select("id, status, created_at")
        .eq("listing_id", entityId),
    ])

    const listing = listingResult.data
    const showings = showingsResult.data || []
    const offers = offersResult.data || []

    // DOM strictly from go_live_date (the public-active date). Pre-MLS
    // window between listing.created_at and go_live_date doesn't count.
    const dom = computeDaysOnMarketOrZero(listing?.go_live_date)

    return {
      daysOnMarket: dom,
      listingStatus: listing?.status,
      listingPrice: listing?.list_price,
      lifecycleStage: listing?.lifecycle_stage,
      showingCount: showings.length,
      offerCount: offers.length,
      lastSignalDate: showings[0]?.scheduled_at || null,
    }
  }
}

// ─── Pattern Evaluation ──────────────────────────────────────────────────────
async function evaluatePattern(
  pattern: BehavioralPattern,
  signals: EntitySignals,
  entityType: "contact" | "listing"
): Promise<{
  matches: boolean
  confidence: number
  reasoning: string | null
  triggerSignals: Record<string, unknown>
}> {
  const rules = pattern.detection_rules
  const triggerSignals: Record<string, unknown> = {}
  let matchCount = 0
  let totalChecks = 0

  // Rule-based evaluation for simple patterns
  switch (pattern.pattern_slug) {
    case "offer_imminent_buyer": {
      totalChecks = 3
      const views = signals.signalCounts?.property_viewed || 0
      const showings = signals.showingCount || 0
      const velocity = signals.engagementVelocity

      if (views >= (rules.min_views || 5)) {
        matchCount++
        triggerSignals.property_views = views
      }
      if (showings >= (rules.min_showings || 2)) {
        matchCount++
        triggerSignals.showings = showings
      }
      if (velocity === "accelerating") {
        matchCount++
        triggerSignals.velocity = velocity
      }

      const confidence = matchCount / totalChecks
      return {
        matches: matchCount >= pattern.minimum_signals,
        confidence,
        reasoning: `Buyer has ${views} property views, ${showings} showings, velocity: ${velocity}`,
        triggerSignals,
      }
    }

    case "price_reduction_likely": {
      totalChecks = 3
      const dom = signals.daysOnMarket || 0
      const showings = signals.showingCount || 0
      const offers = signals.offerCount || 0

      if (dom >= (rules.min_dom || 15)) {
        matchCount++
        triggerSignals.days_on_market = dom
      }
      if (showings >= (rules.min_showings || 5)) {
        matchCount++
        triggerSignals.showings = showings
      }
      if (offers === (rules.offer_count ?? 0)) {
        matchCount++
        triggerSignals.offers = offers
      }

      const confidence = matchCount / totalChecks
      return {
        matches: matchCount >= pattern.minimum_signals,
        confidence,
        reasoning: `Listing has ${dom} DOM, ${showings} showings, ${offers} offers`,
        triggerSignals,
      }
    }

    case "buyer_disengaging": {
      totalChecks = 2
      const velocity = signals.engagementVelocity
      const daysSinceShowing = signals.daysSinceLastShowing

      if (velocity === "decelerating") {
        matchCount++
        triggerSignals.velocity = velocity
      }
      if (
        daysSinceShowing !== null &&
        (daysSinceShowing ?? 0) >= (rules.days_no_showing || 14)
      ) {
        matchCount++
        triggerSignals.days_since_showing = daysSinceShowing
      }

      const confidence = matchCount / totalChecks
      return {
        matches: matchCount >= pattern.minimum_signals,
        confidence,
        reasoning: `Buyer velocity: ${velocity}, ${daysSinceShowing} days since last showing`,
        triggerSignals,
      }
    }

    case "financing_risk": {
      totalChecks = 3
      const hasPreapproval = signals.hasPreapproval
      const timeline = signals.timeline

      if (!hasPreapproval) {
        matchCount++
        triggerSignals.no_preapproval = true
      }
      if (timeline && parseInt(timeline) <= 30) {
        matchCount++
        triggerSignals.timeline_days = timeline
      }
      if (signals.budgetAdjustedDown) {
        matchCount++
        triggerSignals.budget_adjusted_down = true
      }

      const confidence = matchCount / totalChecks
      return {
        matches: matchCount >= pattern.minimum_signals,
        confidence,
        reasoning: `Pre-approval: ${hasPreapproval}, timeline: ${timeline}, budget adjusted: ${signals.budgetAdjustedDown}`,
        triggerSignals,
      }
    }

    case "competitor_threat": {
      // This would need multi-contact analysis - simplified check
      if (signals.multiContactInterest) {
        return {
          matches: true,
          confidence: 0.7,
          reasoning: "Multiple contacts interested in same property",
          triggerSignals: { multi_contact_interest: true },
        }
      }
      return { matches: false, confidence: 0, reasoning: null, triggerSignals }
    }

    default:
      // For complex patterns, use AI evaluation
      if (COMPLEX_PATTERNS.includes(pattern.pattern_slug)) {
        return evaluateWithAI(pattern, signals, entityType)
      }

      // Default rule-based fallback
      return { matches: false, confidence: 0, reasoning: null, triggerSignals }
  }
}

// ─── AI Evaluation for Complex Patterns ──────────────────────────────────────
async function evaluateWithAI(
  pattern: BehavioralPattern,
  signals: EntitySignals,
  entityType: "contact" | "listing"
): Promise<{
  matches: boolean
  confidence: number
  reasoning: string | null
  triggerSignals: Record<string, unknown>
}> {
  try {
    const { text } = await generateText({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      system: `You are a real estate behavioral pattern analyzer. Evaluate if the given pattern matches the entity signals.
Return ONLY valid JSON: {"matches": boolean, "confidence": number (0-1), "reasoning": string}`,
      prompt: `Pattern to detect: ${pattern.pattern_name}
Pattern description: ${pattern.description}
Detection rules: ${JSON.stringify(pattern.detection_rules)}

Entity type: ${entityType}
Entity signals: ${JSON.stringify(signals, null, 2)}

Does this pattern match? Evaluate and return JSON.`,
      maxOutputTokens: 200,
    })

    // Parse AI response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      return {
        matches: result.matches === true,
        confidence: typeof result.confidence === "number" ? result.confidence : 0,
        reasoning: result.reasoning || null,
        triggerSignals: signals as Record<string, unknown>,
      }
    }
  } catch (error) {
    console.error("AI pattern evaluation error:", error)
  }

  return { matches: false, confidence: 0, reasoning: null, triggerSignals: {} }
}

// ─── Record Prediction Outcome ───────────────────────────────────────────────
export async function recordPredictionOutcome(
  predictionId: string,
  outcome: "correct" | "incorrect",
  agentId: string,
  brokerageId: string
): Promise<void> {
  const supabase = createServiceClient()

  await supabase
    .from("pattern_predictions")
    .update({
      outcome,
      outcome_recorded_at: new Date().toISOString(),
    })
    .eq("id", predictionId)

  // Log to ai_feedback_log
  await supabase.from("ai_feedback_log").insert({
    agent_id: agentId,
    brokerage_id: brokerageId,
    source_system: "behavioral_pattern",
    feedback_type: "outcome",
    rating: outcome === "correct" ? 1 : -1,
    context: { prediction_id: predictionId },
  })

  // Emit outcome event through the canonical emitter — INSERT + reactor fan-out.
  await emitKernelEvent({
    event:       KernelEvent.PREDICTION_OUTCOME_RECORDED,
    brokerageId,
    entityType:  "prediction",
    entityId:    predictionId,
    agentUserId: agentId,
    metadata:    { outcome },
  })
}
