"use server"

import { createClient } from "@/lib/supabase/server"
import { generateBuyerPrediction } from "@/lib/behavior-learning/prediction-engine"
import { updateBuyerPreferences }  from "@/lib/behavior-learning/preference-updater"

export interface BuyerInsights {
  preferences: {
    inferred_min_price:      number | null
    inferred_max_price:      number | null
    inferred_beds_min:       number | null
    inferred_baths_min:      number | null
    inferred_property_types: string[]
    inferred_cities:         string[]
    inferred_zip_codes:      string[]
    confidence_score:        number
    signals_processed:       number
    last_calculated_at:      string | null
  } | null
  prediction: {
    predicted_next_action:    string | null
    confidence:               number | null
    predicted_ready_to_offer: boolean
    predicted_fatigue_risk:   boolean
    days_to_predicted_offer:  number | null
    engagement_velocity:      string | null
    engagement_score:         number
    prediction_factors:       Record<string, unknown>
    expires_at:               string | null
  } | null
}

export async function getBuyerInsights(
  contactId: string
): Promise<{ success: boolean; insights?: BuyerInsights; error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("brokerage_id")
    .eq("user_id", user.id)
    .single()

  const brokerageId: string = profile?.brokerage_id ?? ""

  const [prefsRes, predRes] = await Promise.all([
    supabase
      .from("property_preferences")
      .select(
        "inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, " +
        "inferred_property_types, inferred_cities, inferred_zip_codes, " +
        "confidence_score, signals_processed, last_calculated_at"
      )
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle(),
    supabase
      .from("buyer_behavior_predictions")
      .select(
        "predicted_next_action, confidence, predicted_ready_to_offer, predicted_fatigue_risk, " +
        "days_to_predicted_offer, engagement_velocity, engagement_score, prediction_factors, expires_at"
      )
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("generated_at", { ascending: false })
      .maybeSingle(),
  ])

  return {
    success: true,
    insights: {
      preferences: prefsRes.data ?? null,
      prediction:  predRes.data  ?? null,
    },
  }
}

export async function refreshBuyerInsights(
  contactId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("brokerage_id")
    .eq("user_id", user.id)
    .single()

  const brokerageId: string = profile?.brokerage_id ?? ""
  if (!brokerageId) return { success: false, error: "No brokerage found" }

  const [prefResult, predResult] = await Promise.all([
    updateBuyerPreferences(contactId, brokerageId),
    generateBuyerPrediction(contactId, brokerageId),
  ])

  if (!prefResult.success) return { success: false, error: prefResult.error }
  if (!predResult.success) return { success: false, error: predResult.error }
  return { success: true }
}
