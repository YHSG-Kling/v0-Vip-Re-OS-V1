"use server"

import { createClient }       from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { BUYER_CRITERIA_SELECT } from "@/lib/buyer-search/buyer-criteria"
import { generateBuyerPredictions } from "@/lib/behavior-learning/prediction-engine"
import { updateBuyerPreferences }   from "@/lib/behavior-learning/preference-updater"
import { readRoleGrants, selectTenantBrokerageId } from "@/lib/auth/role-grants"

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

async function getBrokerageId(authUserId: string): Promise<string> {
  // user_role_assignments.user_id stores the app users.id, not the Supabase auth UID.
  // Look up via the users table first to get the app-level brokerage_id.
  const svc = createServiceClient()

  // Try users table directly by auth UID first (works when auth.uid = users.id)
  const { data: userRow } = await svc
    .from("users")
    .select("brokerage_id")
    .eq("id", authUserId)
    .maybeSingle()
  if (userRow?.brokerage_id) return userRow.brokerage_id

  // Fallback: try user_role_assignments.
  //
  // WAS `.limit(1).maybeSingle()` with no ORDER BY — the fail-ARBITRARY shape. It
  // never errors, which is what made it dangerous: PostgREST returns rows in
  // whatever order the plan produced, so the TENANT this whole insights surface is
  // scoped to could differ between two runs of the same code, and the row that won
  // might be an untenanted `contact` grant whose brokerage_id is NULL. Row order
  // must never decide a tenant. Read every grant and choose by explicit precedence.
  const grantsResult = await readRoleGrants(svc, authUserId)
  if (!grantsResult.ok) {
    console.error("[buyer-insights] role grant read failed:", grantsResult.error)
    return ""
  }
  return selectTenantBrokerageId(grantsResult.grants) ?? ""
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
      // Criteria columns come from the ONE canonical list (no per-consumer drift); the two
      // metadata columns are this display surface's own.
      .select(`${BUYER_CRITERIA_SELECT}, signals_processed, last_calculated_at`)
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
      preferences: (prefsRes.data ?? null) as unknown as BuyerInsights["preferences"],
      prediction:  (predRes.data  ?? null) as unknown as BuyerInsights["prediction"],
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
