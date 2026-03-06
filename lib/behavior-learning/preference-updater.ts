"use server"

import { createServiceClient } from "@/lib/supabase/service"

// Signal weights per spec
const SIGNAL_WEIGHTS: Record<string, number> = {
  saved:           5,
  love_it:         10,
  like_it:         5,
  maybe:           2,
  dismissed:       -3,
  viewed:          1,
  property_viewed: 0.5,
}

function weightFor(signalType: string, signalValue: number): number {
  const base = SIGNAL_WEIGHTS[signalType] ?? 1
  return base * (signalValue ?? 1)
}

export async function updateBuyerPreferences(
  contactId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  // 1. Load last 90 days of buyer_behavior_log
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const { data: logs, error: logsErr } = await supabase
    .from("buyer_behavior_log")
    .select(
      "signal_type, signal_value, list_price, bedrooms, bathrooms, sqft, property_type, city, zip"
    )
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)

  if (logsErr) return { success: false, error: logsErr.message }
  if (!logs || logs.length === 0) return { success: true } // nothing to learn from yet

  // 2. Weighted numeric averages
  let totalWeight  = 0
  let priceSum     = 0
  let bedsSum      = 0
  let bathsSum     = 0

  // 3. Categorical frequency maps
  const typeMap: Record<string, number>  = {}
  const cityMap: Record<string, number>  = {}
  const zipMap:  Record<string, number>  = {}

  let signalsProcessed = 0

  for (const log of logs) {
    const w = weightFor(log.signal_type, Number(log.signal_value ?? 1))
    if (w <= 0) continue // dismissed signals don't contribute to averages

    signalsProcessed++
    totalWeight += w

    if (log.list_price) priceSum += Number(log.list_price) * w
    if (log.bedrooms)   bedsSum  += Number(log.bedrooms)   * w
    if (log.bathrooms)  bathsSum += Number(log.bathrooms)  * w

    if (log.property_type) typeMap[log.property_type] = (typeMap[log.property_type] ?? 0) + w
    if (log.city)          cityMap[log.city]           = (cityMap[log.city] ?? 0) + w
    if (log.zip)           zipMap[log.zip]             = (zipMap[log.zip] ?? 0) + w
  }

  if (totalWeight === 0) return { success: true }

  const avgPrice = Math.round(priceSum / totalWeight)
  const avgBeds  = Math.round(bedsSum  / totalWeight)
  const avgBaths = Math.round((bathsSum / totalWeight) * 2) / 2 // nearest 0.5

  // Price band ±20%
  const inferredMinPrice = avgPrice > 0 ? Math.round(avgPrice * 0.8) : null
  const inferredMaxPrice = avgPrice > 0 ? Math.round(avgPrice * 1.2) : null

  // Top 3 for categorical
  const top3 = (map: Record<string, number>) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k)

  const inferredPropertyTypes = top3(typeMap)
  const inferredCities        = top3(cityMap)
  const inferredZipCodes      = top3(zipMap)

  // 4. Confidence = min(1.0, signals / 50)
  const confidenceScore = Math.min(1.0, signalsProcessed / 50)

  // 5. UPSERT property_preferences
  const { error: upsertErr } = await supabase
    .from("property_preferences")
    .upsert(
      {
        contact_id:              contactId,
        brokerage_id:            brokerageId,
        inferred_min_price:      inferredMinPrice,
        inferred_max_price:      inferredMaxPrice,
        inferred_beds_min:       avgBeds  > 0 ? avgBeds  : null,
        inferred_baths_min:      avgBaths > 0 ? avgBaths : null,
        inferred_property_types: inferredPropertyTypes,
        inferred_cities:         inferredCities,
        inferred_zip_codes:      inferredZipCodes,
        confidence_score:        confidenceScore,
        signals_processed:       signalsProcessed,
        last_calculated_at:      new Date().toISOString(),
        model_version:           "1.0",
      },
      { onConflict: "contact_id" }
    )

  if (upsertErr) return { success: false, error: upsertErr.message }
  return { success: true }
}
