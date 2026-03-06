"use server"

import Anthropic from "@anthropic-ai/sdk"
import { createServiceClient } from "@/lib/supabase/service"

const anthropic = new Anthropic()

type EngagementVelocity = "accelerating" | "steady" | "decelerating" | "stalled"

function calcVelocity(last7: number, prev7: number): EngagementVelocity {
  if (last7 < 5) return "stalled"
  if (prev7 === 0) return last7 > 0 ? "accelerating" : "stalled"
  const change = (last7 - prev7) / prev7
  if (change > 0.5)  return "accelerating"
  if (change < -0.2) return "decelerating"
  return "steady"
}

export async function generateBuyerPrediction(
  contactId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const now       = new Date()
  const d7ago     = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString()
  const d14ago    = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const d30ago    = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // 1. Load engagement data in parallel
  const [logsRes, savedRes, showingsRes, contactRes] = await Promise.all([
    supabase
      .from("buyer_behavior_log")
      .select("signal_type, created_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .gte("created_at", d30ago),
    supabase
      .from("saved_properties")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("dismissed", false),
    supabase
      .from("showings")
      .select("id, created_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId),
    supabase
      .from("contacts")
      .select("buyer_stage, created_at")
      .eq("id", contactId)
      .single(),
  ])

  const logs     = logsRes.data     ?? []
  const saved    = savedRes.data    ?? []
  const showings = showingsRes.data ?? []
  const contact  = contactRes.data

  // Signal counts
  const signalsLast30d = logs.length
  const last7Logs      = logs.filter(l => l.created_at >= d7ago)
  const prev7Logs      = logs.filter(l => l.created_at >= d14ago && l.created_at < d7ago)
  const signalsLast7d  = last7Logs.length
  const signalsPrev7d  = prev7Logs.length

  // 2. Engagement velocity
  const engagementVelocity = calcVelocity(signalsLast7d, signalsPrev7d)

  // Days searching = days since contact created_at
  const createdAt    = contact?.created_at ? new Date(contact.created_at) : now
  const daysSearching = Math.round((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))

  // 3. Call Anthropic
  const prompt = `Given this buyer's engagement data, predict their next action.
buyer_stage: ${contact?.buyer_stage ?? "prospect"}
signals_last_30d: ${signalsLast30d}
signals_last_7d: ${signalsLast7d}
showings: ${showings.length}
saved_properties: ${saved.length}
engagement_velocity: ${engagementVelocity}
days_searching: ${daysSearching}

Return ONLY valid JSON (no markdown, no explanation):
{
  "predicted_next_action": string,
  "confidence": number,
  "predicted_ready_to_offer": boolean,
  "predicted_fatigue_risk": boolean,
  "days_to_predicted_offer": number | null,
  "prediction_factors": string[]
}`

  let parsed: {
    predicted_next_action: string
    confidence: number
    predicted_ready_to_offer: boolean
    predicted_fatigue_risk: boolean
    days_to_predicted_offer: number | null
    prediction_factors: string[]
  }

  try {
    const response = await anthropic.messages.create({
      model:      "claude-opus-4-5",
      max_tokens: 512,
      messages:   [{ role: "user", content: prompt }],
    })
    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}"
    parsed = JSON.parse(text)
  } catch {
    // Deterministic fallback
    parsed = {
      predicted_next_action:   engagementVelocity === "stalled" ? "Re-engagement needed" : "Continue searching",
      confidence:               0.4,
      predicted_ready_to_offer: showings.length >= 3 && signalsLast7d >= 5,
      predicted_fatigue_risk:   engagementVelocity === "decelerating" || engagementVelocity === "stalled",
      days_to_predicted_offer:  null,
      prediction_factors:       [`engagement_velocity: ${engagementVelocity}`, `showings: ${showings.length}`],
    }
  }

  // 4. UPSERT buyer_behavior_predictions
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()

  const { error } = await supabase
    .from("buyer_behavior_predictions")
    .upsert(
      {
        contact_id:               contactId,
        brokerage_id:             brokerageId,
        predicted_next_action:    parsed.predicted_next_action,
        confidence:               parsed.confidence,
        predicted_ready_to_offer: parsed.predicted_ready_to_offer,
        predicted_fatigue_risk:   parsed.predicted_fatigue_risk,
        days_to_predicted_offer:  parsed.days_to_predicted_offer,
        prediction_factors:       { factors: parsed.prediction_factors },
        engagement_velocity:      engagementVelocity,
        engagement_score:         Math.min(100, signalsLast30d),
        generated_at:             now.toISOString(),
        expires_at:               expiresAt,
      },
      { onConflict: "contact_id" }
    )

  if (error) return { success: false, error: error.message }
  return { success: true }
}
