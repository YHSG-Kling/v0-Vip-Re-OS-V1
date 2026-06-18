"use server"

import { createServiceClient } from "@/lib/supabase/service"

// Signal weights — exact per spec
const SIGNAL_WEIGHTS: Record<string, number> = {
  saved:      5,
  love_it:    10,
  dismissed:  -3,
  viewed:     0.5,
  like_it:    3,
  maybe:      1,
  not_for_us: -5,
}

interface SignalProperty {
  price:         number
  bedrooms:      number
  bathrooms:     number
  sqft:          number
  city:          string
  features:      string[]
  property_type: string
}

interface UpdatePreferencesFromSignalParams {
  contactId:   string
  agentId:     string    // users.id
  brokerageId: string
  signal:      "saved" | "love_it" | "dismissed" | "viewed" | "like_it" | "maybe" | "not_for_us"
  property:    SignalProperty
}

/**
 * updatePreferencesFromSignal
 * 1. INSERTs the signal into buyer_behavior_log
 * 2. Loads all existing signals for the contact
 * 3. Computes weighted averages / frequency maps
 * 4. UPSERTs property_preferences ON CONFLICT (contact_id)
 */
export async function updatePreferencesFromSignal(
  params: UpdatePreferencesFromSignalParams
): Promise<{ success: boolean; error?: string }> {
  const { contactId, agentId, brokerageId, signal, property } = params
  const supabase = createServiceClient()

  // Step 1 — INSERT into buyer_behavior_log
  const { error: logErr } = await supabase
    .from("buyer_behavior_log")
    .insert({
      contact_id:        contactId,
      agent_id:          agentId,
      brokerage_id:      brokerageId,
      signal_type:       signal,
      metadata:          property,  // jsonb column (was property_snapshot)
      list_price:        property.price,
      bedrooms:          property.bedrooms,
      bathrooms:         property.bathrooms,
      sqft:              property.sqft,
      city:              property.city,
      property_type:     property.property_type,
      signal_value:      1,
      source:            "agent_dashboard",
    })

  if (logErr) return { success: false, error: logErr.message }

  // Step 2 — Fetch current property_preferences for contactId
  const { data: current } = await supabase
    .from("property_preferences")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // Step 3 — Load all signals for this contact to compute running averages
  const { data: allLogs, error: logsErr } = await supabase
    .from("buyer_behavior_log")
    .select("signal_type, list_price, bedrooms, bathrooms, city, property_type, property_snapshot:metadata")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(200)

  if (logsErr) return { success: false, error: logsErr.message }

  const logs = allLogs ?? []

  // Weighted accumulators
  let totalWeight  = 0
  let priceWeightedSum = 0
  let bedsWeightedSum  = 0
  let bathsWeightedSum = 0

  // Frequency maps for categoricals
  const cityMap:    Record<string, number>    = {}
  const typeMap:    Record<string, number>    = {}
  const featureMap: Record<string, number>    = {}

  for (const log of logs) {
    const w = SIGNAL_WEIGHTS[log.signal_type] ?? 0
    if (w <= 0) continue // dismissed / not_for_us don't contribute to averages

    totalWeight += w

    if (log.list_price)      priceWeightedSum += Number(log.list_price) * w
    if (log.bedrooms)        bedsWeightedSum  += Number(log.bedrooms)   * w
    if (log.bathrooms)       bathsWeightedSum += Number(log.bathrooms)  * w

    if (log.city)            cityMap[log.city]          = (cityMap[log.city]          ?? 0) + w
    if (log.property_type)   typeMap[log.property_type] = (typeMap[log.property_type] ?? 0) + w

    // Features from property_snapshot
    const snap = log.property_snapshot as SignalProperty | null
    if (snap?.features) {
      for (const f of snap.features) {
        featureMap[f] = (featureMap[f] ?? 0) + w
      }
    }
  }

  if (totalWeight === 0) return { success: true } // all negative signals, no averages

  const avgPrice = Math.round(priceWeightedSum / totalWeight)
  const avgBeds  = Math.round(bedsWeightedSum  / totalWeight)
  const avgBaths = Math.round((bathsWeightedSum / totalWeight) * 2) / 2 // nearest 0.5

  // preferred_price_min/max: ±15% band around weighted average
  const preferred_price_min = avgPrice > 0 ? Math.round(avgPrice * 0.85) : (current?.preferred_price_min ?? null)
  const preferred_price_max = avgPrice > 0 ? Math.round(avgPrice * 1.15) : (current?.preferred_price_max ?? null)

  // Top-ranked categoricals by weight
  const topN = (map: Record<string, number>, n: number): string[] =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k)

  const preferred_cities   = topN(cityMap, 5)
  const preferred_features = topN(featureMap, 10)

  // Confidence = min(1.0, total_positive_signals / 50)
  const signalsProcessed = logs.filter(l => (SIGNAL_WEIGHTS[l.signal_type] ?? 0) > 0).length
  const confidenceScore  = Math.min(1.0, signalsProcessed / 50)

  // Step 4 — UPSERT property_preferences ON CONFLICT (contact_id)
  const { error: upsertErr } = await supabase
    .from("property_preferences")
    .upsert(
      {
        contact_id:              contactId,
        brokerage_id:            brokerageId,
        // Explicit price band (these columns exist). The behavior-INFERRED criteria go into
        // the inferred_* columns — the live table has NO preferred_bedrooms/bathrooms/cities/
        // features columns, so writing them errored the ENTIRE upsert and the learned
        // preferences were never persisted (the root cause of the matcher having no data).
        preferred_price_min:     preferred_price_min,
        preferred_price_max:     preferred_price_max,
        inferred_min_price:      preferred_price_min,
        inferred_max_price:      preferred_price_max,
        inferred_beds_min:       avgBeds  > 0 ? avgBeds  : null,
        inferred_baths_min:      avgBaths > 0 ? avgBaths : null,
        inferred_cities:         preferred_cities,
        inferred_property_types: topN(typeMap, 3),
        inferred_must_have_features: preferred_features,
        confidence_score:        confidenceScore,
        signals_processed:       signalsProcessed,
        last_calculated_at:      new Date().toISOString(),
        updated_at:              new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )

  if (upsertErr) return { success: false, error: upsertErr.message }
  return { success: true }
}

/**
 * updateBuyerPreferences (batch recalculation — used by cron / background refresh)
 * Kept for backward compatibility with existing callers.
 */
export async function updateBuyerPreferences(
  contactId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const { data: lastLog } = await supabase
    .from("buyer_behavior_log")
    .select("signal_type, list_price, bedrooms, bathrooms, city, property_type, property_snapshot:metadata")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lastLog) return { success: true }

  // Re-use the signal path with the most recent signal
  return updatePreferencesFromSignal({
    contactId,
    agentId:    "system",
    brokerageId,
    signal:     (lastLog.signal_type as any) ?? "viewed",
    property:   (lastLog.property_snapshot as SignalProperty) ?? {
      price: Number(lastLog.list_price ?? 0),
      bedrooms: Number(lastLog.bedrooms ?? 0),
      bathrooms: Number(lastLog.bathrooms ?? 0),
      sqft: 0,
      city: lastLog.city ?? "",
      features: [],
      property_type: lastLog.property_type ?? "",
    },
  })
}
