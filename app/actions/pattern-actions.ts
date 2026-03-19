"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { recordPredictionOutcome } from "@/lib/intelligence/pattern-detector"

// ─── Types ───────────────────────────────────────────────────────────────────
export interface PatternDetectionWithDetails {
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
  // Joined fields
  pattern_name: string
  pattern_slug: string
  description: string
  recommended_action: string
  // Prediction fields
  prediction_id?: string
  prediction_label?: string
  predicted_event?: string
  predicted_within_days?: number
  probability?: number
  outcome?: "correct" | "incorrect" | null
  // Entity name
  entity_name?: string
}

export interface PatternAccuracyStats {
  correct: number
  incorrect: number
  pending: number
  accuracy_rate: number
}

// ─── Get Active Patterns ─────────────────────────────────────────────────────
export async function getActivePatterns(
  filter?: "all" | "buyer" | "seller" | "negotiation" | "high_priority"
): Promise<PatternDetectionWithDetails[]> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  let query = supabase
    .from("pattern_detections")
    .select(
      `
      *,
      behavioral_patterns!inner (
        pattern_name,
        pattern_slug,
        description,
        recommended_action,
        entity_type
      ),
      pattern_predictions (
        id,
        prediction_label,
        predicted_event,
        predicted_within_days,
        probability,
        outcome
      )
    `
    )
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .order("confidence", { ascending: false })
    .order("created_at", { ascending: false })

  const { data: detections, error } = await query

  if (error) {
    console.error("Error fetching patterns:", error)
    return []
  }

  // Transform and filter
  let results: PatternDetectionWithDetails[] = (detections || []).map((d) => {
    const pattern = d.behavioral_patterns as {
      pattern_name: string
      pattern_slug: string
      description: string
      recommended_action: string
      entity_type: string
    }
    const prediction = Array.isArray(d.pattern_predictions)
      ? d.pattern_predictions[0]
      : d.pattern_predictions

    return {
      id: d.id,
      pattern_id: d.pattern_id,
      entity_type: d.entity_type,
      entity_id: d.entity_id,
      agent_id: d.agent_id,
      brokerage_id: d.brokerage_id,
      confidence: d.confidence,
      trigger_signals: d.trigger_signals,
      ai_reasoning: d.ai_reasoning,
      pattern_type: d.pattern_type,
      status: d.status,
      expires_at: d.expires_at,
      created_at: d.created_at,
      pattern_name: pattern.pattern_name,
      pattern_slug: pattern.pattern_slug,
      description: pattern.description,
      recommended_action: pattern.recommended_action,
      prediction_id: prediction?.id,
      prediction_label: prediction?.prediction_label,
      predicted_event: prediction?.predicted_event,
      predicted_within_days: prediction?.predicted_within_days,
      probability: prediction?.probability,
      outcome: prediction?.outcome,
    }
  })

  // Apply filter
  if (filter && filter !== "all") {
    if (filter === "high_priority") {
      results = results.filter((r) => r.confidence >= 0.75)
    } else if (filter === "buyer") {
      results = results.filter((r) => r.entity_type === "contact")
    } else if (filter === "seller") {
      results = results.filter((r) => r.entity_type === "listing")
    } else if (filter === "negotiation") {
      results = results.filter((r) => r.pattern_type.includes("negotiation"))
    }
  }

  // Fetch entity names
  const contactIds = results
    .filter((r) => r.entity_type === "contact")
    .map((r) => r.entity_id)
  const listingIds = results
    .filter((r) => r.entity_type === "listing")
    .map((r) => r.entity_id)

  const [contactsResult, listingsResult] = await Promise.all([
    contactIds.length > 0
      ? supabase
          .from("contacts")
          .select("id, first_name, last_name")
          .in("id", contactIds)
      : Promise.resolve({ data: [] }),
    listingIds.length > 0
      ? supabase.from("listings").select("id, address").in("id", listingIds)
      : Promise.resolve({ data: [] }),
  ])

  const contactMap = new Map(
    (contactsResult.data || []).map((c) => [
      c.id,
      `${c.first_name} ${c.last_name}`,
    ])
  )
  const listingMap = new Map(
    (listingsResult.data || []).map((l) => [l.id, l.address])
  )

  return results.map((r) => ({
    ...r,
    entity_name:
      r.entity_type === "contact"
        ? contactMap.get(r.entity_id) || "Unknown Contact"
        : listingMap.get(r.entity_id) || "Unknown Listing",
  }))
}

// ─── Update Pattern Status ───────────────────────────────────────────────────
export async function updatePatternStatus(
  detectionId: string,
  status: "acknowledged" | "dismissed"
): Promise<{ success: boolean; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("pattern_detections")
    .update({ status })
    .eq("id", detectionId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── Record Outcome ──────────────────────────────────────────────────────────
export async function recordOutcome(
  predictionId: string,
  outcome: "correct" | "incorrect"
): Promise<{ success: boolean; error?: string }> {
  const { agentId, brokerageId } = await getAgentContext()

  try {
    await recordPredictionOutcome(predictionId, outcome, agentId, brokerageId)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to record outcome",
    }
  }
}

// ─── Get Accuracy Stats ──────────────────────────────────────────────────────
export async function getPatternAccuracyStats(): Promise<PatternAccuracyStats> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("pattern_predictions")
    .select("outcome")
    .eq("brokerage_id", brokerageId)

  if (error || !data) {
    return { correct: 0, incorrect: 0, pending: 0, accuracy_rate: 0 }
  }

  const correct = data.filter((d) => d.outcome === "correct").length
  const incorrect = data.filter((d) => d.outcome === "incorrect").length
  const pending = data.filter((d) => d.outcome === null).length

  const total = correct + incorrect
  const accuracy_rate = total > 0 ? (correct / total) * 100 : 0

  return { correct, incorrect, pending, accuracy_rate }
}

// ─── Get Pattern Details ─────────────────────────────────────────────────────
export async function getPatternDetails(
  detectionId: string
): Promise<PatternDetectionWithDetails | null> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("pattern_detections")
    .select(
      `
      *,
      behavioral_patterns!inner (
        pattern_name,
        pattern_slug,
        description,
        recommended_action
      ),
      pattern_predictions (
        id,
        prediction_label,
        predicted_event,
        predicted_within_days,
        probability,
        outcome,
        recommended_action
      )
    `
    )
    .eq("id", detectionId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (error || !data) {
    return null
  }

  const pattern = data.behavioral_patterns as {
    pattern_name: string
    pattern_slug: string
    description: string
    recommended_action: string
  }
  const prediction = Array.isArray(data.pattern_predictions)
    ? data.pattern_predictions[0]
    : data.pattern_predictions

  // Fetch entity name
  let entityName = "Unknown"
  if (data.entity_type === "contact") {
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name")
      .eq("id", data.entity_id)
      .single()
    if (contact) {
      entityName = `${contact.first_name} ${contact.last_name}`
    }
  } else {
    const { data: listing } = await supabase
      .from("listings")
      .select("address")
      .eq("id", data.entity_id)
      .single()
    if (listing) {
      entityName = listing.address
    }
  }

  return {
    id: data.id,
    pattern_id: data.pattern_id,
    entity_type: data.entity_type,
    entity_id: data.entity_id,
    agent_id: data.agent_id,
    brokerage_id: data.brokerage_id,
    confidence: data.confidence,
    trigger_signals: data.trigger_signals,
    ai_reasoning: data.ai_reasoning,
    pattern_type: data.pattern_type,
    status: data.status,
    expires_at: data.expires_at,
    created_at: data.created_at,
    pattern_name: pattern.pattern_name,
    pattern_slug: pattern.pattern_slug,
    description: pattern.description,
    recommended_action: pattern.recommended_action,
    prediction_id: prediction?.id,
    prediction_label: prediction?.prediction_label,
    predicted_event: prediction?.predicted_event,
    predicted_within_days: prediction?.predicted_within_days,
    probability: prediction?.probability,
    outcome: prediction?.outcome,
    entity_name: entityName,
  }
}
