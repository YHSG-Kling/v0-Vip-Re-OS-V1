"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runAlert } from "@/lib/property-alerts/alert-engine"
import { IDXBrokerClient } from "@/lib/idxbroker-client"

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

// ── createPropertyAlert ──────────────────────────────────────────────────────
export async function createPropertyAlert(params: {
  contactId: string
  brokerageId: string
  alertName?: string
  minPrice?: number
  maxPrice?: number
  bedroomsMin?: number
  bathroomsMin?: number
  propertyTypes?: string[]
  cities?: string[]
  zipCodes?: string[]
  minSqft?: number
  maxSqft?: number
  yearBuiltMin?: number
  mustHaveFeatures?: string[]
  keywords?: string
  maxDaysOnMarket?: number
  newListingsOnly?: boolean
  includeComingSoon?: boolean
  includePriceReductions?: boolean
  priceReductionMinPercent?: number
  frequency?: string
  deliveryChannels?: string[]
  maxResultsPerAlert?: number
}) {
  const user = await getAuthUser()
  if (!user) return { success: false, error: "unauthenticated" }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("property_alerts")
    .insert({
      brokerage_id:               params.brokerageId,
      contact_id:                 params.contactId,
      agent_user_id:              user.id,
      alert_name:                 params.alertName ?? "Property Alert",
      source:                     "agent_created",
      min_price:                  params.minPrice ?? null,
      max_price:                  params.maxPrice ?? null,
      bedrooms_min:               params.bedroomsMin ?? null,
      bathrooms_min:              params.bathroomsMin ?? null,
      property_types:             params.propertyTypes ?? [],
      cities:                     params.cities ?? [],
      zip_codes:                  params.zipCodes ?? [],
      min_sqft:                   params.minSqft ?? null,
      max_sqft:                   params.maxSqft ?? null,
      year_built_min:             params.yearBuiltMin ?? null,
      must_have_features:         params.mustHaveFeatures ?? [],
      keywords:                   params.keywords ?? null,
      max_days_on_market:         params.maxDaysOnMarket ?? null,
      new_listings_only:          params.newListingsOnly ?? true,
      include_coming_soon:        params.includeComingSoon ?? true,
      include_price_reductions:   params.includePriceReductions ?? true,
      price_reduction_min_percent: params.priceReductionMinPercent ?? 2,
      frequency:                  params.frequency ?? "daily",
      delivery_channels:          params.deliveryChannels ?? ["email", "in_app"],
      max_results_per_alert:      params.maxResultsPerAlert ?? 10,
      is_active:                  true,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }

  // Instant frequency → run immediately
  if (params.frequency === "instant") {
    await runAlert(data.id)
  }

  return { success: true, alertId: data.id }
}

// ── updatePropertyAlert ──────────────────────────────────────────────────────
export async function updatePropertyAlert(
  alertId: string,
  updates: Record<string, any>
) {
  const user = await getAuthUser()
  if (!user) return { success: false, error: "unauthenticated" }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("property_alerts")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", alertId)

  if (error) return { success: false, error: error.message }

  // Reactivating → run immediately
  if (updates.is_active === true) {
    await runAlert(alertId)
  }

  return { success: true }
}

// ── pausePropertyAlert ────────────────────────────────────────────────────────
export async function pausePropertyAlert(alertId: string, pausedBy: string) {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("property_alerts")
    .update({ is_active: false, paused_by: pausedBy, updated_at: new Date().toISOString() })
    .eq("id", alertId)
  return error ? { success: false, error: error.message } : { success: true }
}

// ── resumePropertyAlert ───────────────────────────────────────────────────────
export async function resumePropertyAlert(alertId: string) {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("property_alerts")
    .update({ is_active: true, paused_by: null, paused_reason: null, updated_at: new Date().toISOString() })
    .eq("id", alertId)
  if (error) return { success: false, error: error.message }
  await runAlert(alertId)
  return { success: true }
}

// ── deletePropertyAlert ───────────────────────────────────────────────────────
export async function deletePropertyAlert(alertId: string) {
  const supabase = createServiceClient()
  const { error } = await supabase.from("property_alerts").delete().eq("id", alertId)
  return error ? { success: false, error: error.message } : { success: true }
}

// ── getAlertResults ───────────────────────────────────────────────────────────
export async function getAlertResults(
  alertId: string,
  options?: { filter?: "all" | "new_listings" | "price_reductions" | "not_viewed"; limit?: number }
) {
  const supabase = createServiceClient()
  let query = supabase
    .from("property_alert_results")
    .select("*")
    .eq("alert_id", alertId)
    .order("match_score", { ascending: false })
    .limit(options?.limit ?? 50)

  if (options?.filter === "new_listings")     query = query.eq("is_new_listing", true)
  if (options?.filter === "price_reductions") query = query.eq("is_price_reduction", true)
  if (options?.filter === "not_viewed")       query = query.eq("buyer_viewed", false)

  const { data, error } = await query
  if (error) return { success: false, error: error.message, results: [] }

  const { count: unviewedCount } = await supabase
    .from("property_alert_results")
    .select("id", { count: "exact", head: true })
    .eq("alert_id", alertId)
    .eq("buyer_viewed", false)

  return { success: true, results: data ?? [], unviewedCount: unviewedCount ?? 0 }
}

// ── getBuyerAlertSummary ──────────────────────────────────────────────────────
export async function getBuyerAlertSummary(contactId: string) {
  const supabase = createServiceClient()
  const { data: alerts, error } = await supabase
    .from("property_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  if (error) return { success: false, error: error.message, alerts: [] }

  // Fetch unviewed count per alert
  const enriched = await Promise.all(
    (alerts ?? []).map(async alert => {
      const { count } = await supabase
        .from("property_alert_results")
        .select("id", { count: "exact", head: true })
        .eq("alert_id", alert.id)
        .eq("buyer_viewed", false)
      return { ...alert, unviewed_count: count ?? 0 }
    })
  )

  return { success: true, alerts: enriched }
}

// ── markResultViewed ──────────────────────────────────────────────────────────
export async function markResultViewed(resultId: string, contactId: string) {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("property_alert_results")
    .update({ buyer_viewed: true, buyer_viewed_at: new Date().toISOString() })
    .eq("id", resultId)
    .eq("contact_id", contactId)
  return error ? { success: false, error: error.message } : { success: true }
}

// ── buyerAdjustAlert ─────────────────────────────────────────────────────────
// Buyer can ONLY update: frequency, delivery_channels, is_active
export async function buyerAdjustAlert(
  alertId: string,
  contactId: string,
  updates: { frequency?: string; delivery_channels?: string[]; is_active?: boolean }
) {
  const allowed: Record<string, any> = {}
  if (updates.frequency         != null) allowed.frequency          = updates.frequency
  if (updates.delivery_channels != null) allowed.delivery_channels  = updates.delivery_channels
  if (updates.is_active         != null) allowed.is_active          = updates.is_active

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("property_alerts")
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("contact_id", contactId) // scope to buyer
  return error ? { success: false, error: error.message } : { success: true }
}

// ── runAlertNow ───────────────────────────────────────────────────────────────
export async function runAlertNow(alertId: string) {
  const result = await runAlert(alertId)
  return { success: result.success, matchCount: result.propertiesMatched, error: result.error }
}

// ── testIdxConnection ─────────────────────────────────────────────────────────
export async function testIdxConnection(brokerageId: string) {
  try {
    const client = await IDXBrokerClient.forBrokerage(brokerageId)
    if (!client.isConfigured()) {
      return { success: false, error: "No API key configured for this brokerage" }
    }
    const results = await client.searchProperties("active")
    return { success: true, configured: true, resultCount: Array.isArray(results) ? results.length : 0 }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Connection failed" }
  }
}

// ── previewAlertCriteria ──────────────────────────────────────────────────────
// Test search without creating — returns match count
export async function previewAlertCriteria(
  criteria: Record<string, any>,
  brokerageId: string
) {
  try {
    const { searchIDXForAlert } = await import("@/lib/property-alerts/idx-alert-search")
    const { scorePropertyForAlert } = await import("@/lib/property-alerts/alert-matcher")
    const result = await searchIDXForAlert("preview", criteria, brokerageId)
    const matched = result.results.filter(p => scorePropertyForAlert(p, criteria).qualifies).length
    return { success: true, matchCount: matched, configured: result.api_called, error: result.error }
  } catch (err: any) {
    return { success: false, matchCount: 0, error: err?.message }
  }
}

// ── prefillFromProfile ────────────────────────────────────────────────────────
export async function prefillFromProfile(contactId: string) {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("property_interests")
    .select("*")
    .eq("contact_id", contactId)
    .maybeSingle()
  return { success: true, profile: data ?? null }
}
