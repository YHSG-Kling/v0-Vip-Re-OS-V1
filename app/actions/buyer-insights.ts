"use server"

import { createClient }       from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateBuyerPredictions } from "@/lib/behavior-learning/prediction-engine"
import { updateBuyerPreferences }   from "@/lib/behavior-learning/preference-updater"

export interface BuyerInsights {
  preferences: {
    inferred_min_price:      number | null
    inferred_max_price:      number | null
    inferred_beds_min:       number | null
    inferred_baths_min:      number | null
    inferred_property_types: string[]
    inferred_cities:         string[]
    inferred_zip_codes:      string[]
    preferred_price_min:     number | null
    preferred_price_max:     number | null
    confidence_score:        number
    signals_processed:       number
    last_calculated_at:      string | null
  } | null
  prediction: {
    predicted_next_action:    string | null
    predicted_price_min:      number | null
    predicted_price_max:      number | null
    predicted_property_type:  string | null
    predicted_timeline_days:  number | null
    confidence:               number | null
    confidence_score:         number | null
    predicted_ready_to_offer: boolean
    predicted_fatigue_risk:   boolean
    days_to_predicted_offer:  number | null
    engagement_velocity:      string | null
    engagement_score:         number
    prediction_factors:       Record<string, unknown>
    ai_reasoning:             string | null
    expires_at:               string | null
  } | null
}

export interface SignalCounts {
  saves:      number
  loves:      number
  dismissals: number
}

async function getBrokerageId(userId: string): Promise<string> {
  // user_profiles does not have brokerage_id — use user_role_assignments instead
  const svc = createServiceClient()
  const { data } = await svc
    .from("user_role_assignments")
    .select("brokerage_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle()
  return data?.brokerage_id ?? ""
}

export async function getBuyerInsights(
  contactId: string
): Promise<{ success: boolean; insights?: BuyerInsights; signalCounts?: SignalCounts; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const brokerageId = await getBrokerageId(user.id)

  const svc = createServiceClient()

  const [prefsRes, predRes, signalRes] = await Promise.all([
    svc
      .from("property_preferences")
      .select(
        "inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, " +
        "inferred_property_types, inferred_cities, inferred_zip_codes, " +
        "preferred_price_min, preferred_price_max, " +
        "confidence_score, signals_processed, last_calculated_at"
      )
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle(),

    svc
      .from("buyer_behavior_predictions")
      .select(
        "predicted_next_action, predicted_price_min, predicted_price_max, " +
        "predicted_property_type, predicted_timeline_days, " +
        "confidence, confidence_score, predicted_ready_to_offer, predicted_fatigue_risk, " +
        "days_to_predicted_offer, engagement_velocity, engagement_score, " +
        "prediction_factors, ai_reasoning, expires_at"
      )
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("generated_at", { ascending: false })
      .maybeSingle(),

    // Signal counts for the bottom row
    svc
      .from("buyer_behavior_log")
      .select("signal_type")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .in("signal_type", ["saved", "love_it", "dismissed"]),
  ])

  const rawSignals = signalRes.data ?? []
  const signalCounts: SignalCounts = {
    saves:      rawSignals.filter(s => s.signal_type === "saved").length,
    loves:      rawSignals.filter(s => s.signal_type === "love_it").length,
    dismissals: rawSignals.filter(s => s.signal_type === "dismissed").length,
  }

  return {
    success: true,
    insights: {
      preferences: prefsRes.data ?? null,
      prediction:  predRes.data  ?? null,
    },
    signalCounts,
  }
}

export async function refreshBuyerInsights(
  contactId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const brokerageId = await getBrokerageId(user.id)
  if (!brokerageId) return { success: false, error: "No brokerage found" }

  const [prefResult, predResult] = await Promise.all([
    updateBuyerPreferences(contactId, brokerageId),
    generateBuyerPredictions({ contactId, agentId: user.id, brokerageId }),
  ])

  if (!prefResult.success) return { success: false, error: prefResult.error }
  if (!predResult.success) return { success: false, error: predResult.error }
  return { success: true }
}
