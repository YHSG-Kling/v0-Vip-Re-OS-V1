"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"

interface GenerateBuyerPredictionsParams {
  contactId:   string
  agentId:     string
  brokerageId: string
}

type PredictionResult =
  | { predicted: null; reason: "insufficient_data" }
  | {
      predicted:               true
      predicted_price_range:   { min: number; max: number }
      predicted_property_type: string
      predicted_timeline_days: number
      confidence:              number
      reasoning:               string
    }

/**
 * generateBuyerPredictions
 * 1. Fetch last 30 buyer_behavior_log entries
 * 2. Fetch current property_preferences
 * 3. Compute engagement_velocity (signals per day, last 7 days)
 * 4. Guard: < 5 total signals → return insufficient_data
 * 5. Call Anthropic claude-sonnet-4-20250514
 * 6. UPSERT buyer_behavior_predictions ON CONFLICT (contact_id)
 */
export async function generateBuyerPredictions(
  params: GenerateBuyerPredictionsParams
): Promise<{ success: boolean; error?: string }> {
  const { contactId, agentId, brokerageId } = params
  const supabase = createServiceClient()
  const now      = new Date()
  const d30ago   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const d7ago    = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString()

  // Step 1 — Fetch last 30 behavior log entries
  const { data: logs, error: logsErr } = await supabase
    .from("buyer_behavior_log")
    .select("signal_type, created_at, list_price, bedrooms, city, property_type")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .gte("created_at", d30ago)
    .order("created_at", { ascending: false })
    .limit(30)

  if (logsErr) return { success: false, error: logsErr.message }

  const allLogs = logs ?? []

  // Step 4 — Guard: insufficient data
  if (allLogs.length < 5) {
    return { success: true } // not an error — just not enough data yet
  }

  // Step 2 — Fetch current property_preferences
  const { data: prefs } = await supabase
    .from("property_preferences")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // Step 3 — engagement_velocity = signals_last_7_days / 7 (signals per day)
  const signalsLast7d      = allLogs.filter(l => l.created_at >= d7ago).length
  const engagementVelocity = signalsLast7d / 7  // numeric signals-per-day per spec

  // Step 5 — Call Anthropic claude-sonnet-4-20250514
  const behaviorSummary = {
    total_signals:        allLogs.length,
    signals_last_7_days:  signalsLast7d,
    engagement_velocity:  engagementVelocity,
    signal_types:         allLogs.map(l => l.signal_type),
    current_preferences:  prefs ?? {},
  }

  type AIOutput = {
    predicted_price_range:    { min: number; max: number }
    predicted_property_type:  string
    predicted_timeline_days:  number
    confidence:                number
    reasoning:                 string
  }

  let ai: AIOutput

  try {
    const { text } = await generateText({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      system:
        "You are a real estate buyer behavior analyst. Based on buyer signals, predict what property " +
        "they're most likely to make an offer on. Return JSON only with these exact keys: " +
        "{ predicted_price_range: {min, max}, predicted_property_type: string, " +
        "predicted_timeline_days: number, confidence: number (0-1), reasoning: string }",
      prompt: `Buyer behavior data: ${JSON.stringify(behaviorSummary)}`,
    })

    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    ai = JSON.parse(clean) as AIOutput
  } catch {
    // Deterministic fallback
    ai = {
      predicted_price_range:   {
        min: prefs?.inferred_min_price ?? prefs?.preferred_price_min ?? 0,
        max: prefs?.inferred_max_price ?? prefs?.preferred_price_max ?? 0,
      },
      predicted_property_type:  prefs?.inferred_property_types?.[0] ?? "Single Family",
      predicted_timeline_days:  engagementVelocity > 1 ? 30 : 60,
      confidence:                Math.min(0.6, allLogs.length / 30),
      reasoning:                 "Prediction based on observed engagement patterns.",
    }
  }

  // Step 6 — UPSERT buyer_behavior_predictions ON CONFLICT (contact_id)
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()

  const { error: upsertErr } = await supabase
    .from("buyer_behavior_predictions")
    .upsert(
      {
        contact_id:               contactId,
        brokerage_id:             brokerageId,
        predicted_price_min:      ai.predicted_price_range.min,
        predicted_price_max:      ai.predicted_price_range.max,
        predicted_property_type:  ai.predicted_property_type,
        predicted_timeline_days:  ai.predicted_timeline_days,
        confidence_score:         ai.confidence,
        ai_reasoning:             ai.reasoning,
        engagement_velocity:      engagementVelocity,
        engagement_score:         Math.min(100, allLogs.length),
        // also store legacy fields used by insights panel
        predicted_next_action:    `Offer on ${ai.predicted_property_type}`,
        confidence:               ai.confidence,
        predicted_ready_to_offer: ai.confidence > 0.6 && ai.predicted_timeline_days <= 30,
        predicted_fatigue_risk:   engagementVelocity < 0.3 && allLogs.length > 10,
        days_to_predicted_offer:  ai.predicted_timeline_days,
        prediction_factors:       { reasoning: ai.reasoning },
        generated_at:             now.toISOString(),
        expires_at:               expiresAt,
      },
      { onConflict: "contact_id" }
    )

  if (upsertErr) return { success: false, error: upsertErr.message }
  return { success: true }
}

/**
 * generateBuyerPrediction — backward-compatible wrapper used by existing callers
 */
export async function generateBuyerPrediction(
  contactId:   string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  return generateBuyerPredictions({ contactId, agentId: "system", brokerageId })
}
