"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runAlert } from "@/lib/property-alerts/alert-engine"
import { ensureSmsFirstChannels } from "@/app/actions/instant-property-alerts"
import { IDXBrokerClient } from "@/lib/idxbroker-client"

// ── Auth helpers ─────────────────────────────────────────────────────────────
//
// Property alerts have two distinct caller types:
//   1. Agents — work inside the CRM dashboard, scoped by brokerage_id
//   2. Buyers (contacts) — log in via /api/auth/contact-login, scoped by
//      contacts.contact_user_id = auth.uid()
//
// Previous version of this file: most functions had no auth, and the
// callers that did have auth still trusted caller-supplied brokerageId /
// contactId, which is an IDOR vulnerability.

async function requireAgent(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "unauthenticated" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "unauthenticated" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// Verify the caller can access the named alert: either the agent (same
// brokerage) or the buyer the alert is for (contact.contact_user_id matches
// auth.uid() OR contact.email matches user.email).
async function requireAlertAccess(alertId: string): Promise<
  | { ok: true; alert: { id: string; contact_id: string; brokerage_id: string; agent_user_id: string | null } }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "unauthenticated" }

  const svc = createServiceClient()
  const { data: alert } = await svc
    .from("property_alerts")
    .select("id, contact_id, brokerage_id, agent_user_id")
    .eq("id", alertId)
    .maybeSingle()
  if (!alert) return { ok: false, error: "alert not found" }

  // Agent / staff path: same brokerage
  const { data: u } = await svc
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (u?.brokerage_id && u.brokerage_id === alert.brokerage_id) {
    return { ok: true, alert }
  }

  // Buyer path: the contact this alert is for is the logged-in user
  const { data: contact } = await svc
    .from("contacts")
    .select("id, contact_user_id, email")
    .eq("id", alert.contact_id)
    .maybeSingle()
  if (
    contact &&
    (contact.contact_user_id === user.id ||
      (contact.email && user.email && contact.email.toLowerCase() === user.email.toLowerCase()))
  ) {
    return { ok: true, alert }
  }

  return { ok: false, error: "forbidden" }
}

// Buyer-only access: enforce that the logged-in user is the contact.
async function requireBuyerAccess(contactId: string): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "unauthenticated" }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, contact_user_id, email, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "contact not found" }

  // Either: the buyer logged in as themselves
  if (
    contact.contact_user_id === user.id ||
    (contact.email && user.email && contact.email.toLowerCase() === user.email.toLowerCase())
  ) {
    return { ok: true, userId: user.id }
  }

  // OR: the caller is an agent in the same brokerage acting on the buyer's behalf
  const { data: u } = await svc
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (u?.brokerage_id && u.brokerage_id === contact.brokerage_id) {
    return { ok: true, userId: user.id }
  }

  return { ok: false, error: "forbidden" }
}

// ── createPropertyAlert ──────────────────────────────────────────────────────
export async function createPropertyAlert(params: {
  contactId: string
  brokerageId?: string  // ignored — stamped from session
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
  const auth = await requireAgent()
  if (!auth.ok) return { success: false, error: auth.error }

  const svc = createServiceClient()

  // Verify contact belongs to caller's brokerage before creating an alert for them
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) return { success: false, error: "contact not found" }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: "forbidden" }

  const { data, error } = await svc
    .from("property_alerts")
    .insert({
      brokerage_id:                auth.brokerageId,  // from session, not params
      contact_id:                  params.contactId,
      agent_user_id:               auth.userId,
      alert_name:                  params.alertName ?? "Property Alert",
      source:                      "agent_created",
      min_price:                   params.minPrice ?? null,
      max_price:                   params.maxPrice ?? null,
      bedrooms_min:                params.bedroomsMin ?? null,
      bathrooms_min:               params.bathroomsMin ?? null,
      property_types:              params.propertyTypes ?? [],
      cities:                      params.cities ?? [],
      zip_codes:                   params.zipCodes ?? [],
      min_sqft:                    params.minSqft ?? null,
      max_sqft:                    params.maxSqft ?? null,
      year_built_min:              params.yearBuiltMin ?? null,
      must_have_features:          params.mustHaveFeatures ?? [],
      keywords:                    params.keywords ?? null,
      max_days_on_market:          params.maxDaysOnMarket ?? null,
      new_listings_only:           params.newListingsOnly ?? true,
      include_coming_soon:         params.includeComingSoon ?? true,
      include_price_reductions:    params.includePriceReductions ?? true,
      price_reduction_min_percent: params.priceReductionMinPercent ?? 2,
      frequency:                   params.frequency ?? "daily",
      delivery_channels:           params.deliveryChannels ?? ["email", "in_app"],
      max_results_per_alert:       params.maxResultsPerAlert ?? 10,
      is_active:                   true,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }

  if (params.frequency === "instant") {
    // Instant alerts go SMS-first (98% open vs 25% email) before the first fire.
    await ensureSmsFirstChannels(data.id)
    await runAlert(data.id)
  }

  return { success: true, alertId: data.id }
}

// ── updatePropertyAlert ──────────────────────────────────────────────────────
export async function updatePropertyAlert(
  alertId: string,
  updates: Record<string, any>
) {
  const gate = await requireAlertAccess(alertId)
  if (!gate.ok) return { success: false, error: gate.error }

  // Block re-parenting attacks: callers can't move alerts between brokerages
  // or rewrite ownership via the updates blob.
  const { brokerage_id: _b, contact_id: _c, agent_user_id: _a, id: _i, ...safeUpdates } = updates

  const svc = createServiceClient()
  const { error } = await svc
    .from("property_alerts")
    .update({ ...safeUpdates, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("brokerage_id", gate.alert.brokerage_id)

  if (error) return { success: false, error: error.message }

  if (updates.is_active === true) {
    await runAlert(alertId)
  }

  return { success: true }
}

// ── pausePropertyAlert ────────────────────────────────────────────────────────
export async function pausePropertyAlert(alertId: string, _pausedBy?: string) {
  const gate = await requireAlertAccess(alertId)
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()
  const { error } = await svc
    .from("property_alerts")
    .update({
      is_active: false,
      paused_by: gate.alert.agent_user_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", alertId)
    .eq("brokerage_id", gate.alert.brokerage_id)
  return error ? { success: false, error: error.message } : { success: true }
}

// ── resumePropertyAlert ───────────────────────────────────────────────────────
export async function resumePropertyAlert(alertId: string) {
  const gate = await requireAlertAccess(alertId)
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()
  const { error } = await svc
    .from("property_alerts")
    .update({ is_active: true, paused_by: null, paused_reason: null, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("brokerage_id", gate.alert.brokerage_id)
  if (error) return { success: false, error: error.message }
  await runAlert(alertId)
  return { success: true }
}

// ── deletePropertyAlert ───────────────────────────────────────────────────────
export async function deletePropertyAlert(alertId: string) {
  const gate = await requireAlertAccess(alertId)
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()
  const { error } = await svc
    .from("property_alerts")
    .delete()
    .eq("id", alertId)
    .eq("brokerage_id", gate.alert.brokerage_id)
  return error ? { success: false, error: error.message } : { success: true }
}

// ── getAlertResults ───────────────────────────────────────────────────────────
export async function getAlertResults(
  alertId: string,
  options?: { filter?: "all" | "new_listings" | "price_reductions" | "not_viewed"; limit?: number }
) {
  const gate = await requireAlertAccess(alertId)
  if (!gate.ok) return { success: false, error: gate.error, results: [] }

  const svc = createServiceClient()
  let query = svc
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

  const { count: unviewedCount } = await svc
    .from("property_alert_results")
    .select("id", { count: "exact", head: true })
    .eq("alert_id", alertId)
    .eq("buyer_viewed", false)

  return { success: true, results: data ?? [], unviewedCount: unviewedCount ?? 0 }
}

// ── getBuyerAlertSummary ──────────────────────────────────────────────────────
export async function getBuyerAlertSummary(contactId: string) {
  const gate = await requireBuyerAccess(contactId)
  if (!gate.ok) return { success: false, error: gate.error, alerts: [] }

  const svc = createServiceClient()
  const { data: alerts, error } = await svc
    .from("property_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  if (error) return { success: false, error: error.message, alerts: [] }

  const enriched = await Promise.all(
    (alerts ?? []).map(async alert => {
      const { count } = await svc
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
  const gate = await requireBuyerAccess(contactId)
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()
  const { error } = await svc
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
  updates: { frequency?: string; delivery_channels?: string[]; is_active?: boolean; snooze_days?: number | null }
) {
  const gate = await requireBuyerAccess(contactId)
  if (!gate.ok) return { success: false, error: gate.error }

  const allowed: Record<string, any> = {}
  if (updates.frequency         != null) allowed.frequency          = updates.frequency
  if (updates.delivery_channels != null) allowed.delivery_channels  = updates.delivery_channels
  if (updates.is_active         != null) allowed.is_active          = updates.is_active
  // SNOOZE — a temporary, auto-resuming mute (the search is never deactivated). >0 days snoozes;
  // 0 or null clears it (resume now). The alert engine skips searches while snoozed_until is future.
  if (updates.snooze_days !== undefined) {
    allowed.snoozed_until = updates.snooze_days && updates.snooze_days > 0
      ? new Date(Date.now() + Math.min(updates.snooze_days, 90) * 86_400_000).toISOString()
      : null
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from("property_alerts")
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("contact_id", contactId)
  return error ? { success: false, error: error.message } : { success: true }
}

// ── runAlertNow ───────────────────────────────────────────────────────────────
export async function runAlertNow(alertId: string) {
  const gate = await requireAlertAccess(alertId)
  if (!gate.ok) return { success: false, error: gate.error }

  const result = await runAlert(alertId)
  return { success: result.success, matchCount: result.propertiesMatched, error: result.error }
}

// ── testIdxConnection ─────────────────────────────────────────────────────────
export async function testIdxConnection(brokerageId?: string) {
  const auth = await requireAgent()
  if (!auth.ok) return { success: false, error: auth.error }

  // Ignore caller-supplied brokerageId — always use session's
  try {
    const client = await IDXBrokerClient.forBrokerage(auth.brokerageId)
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
export async function previewAlertCriteria(
  criteria: Record<string, any>,
  brokerageId?: string
) {
  const auth = await requireAgent()
  if (!auth.ok) return { success: false, matchCount: 0, error: auth.error }

  try {
    const { searchIDXForAlert } = await import("@/lib/property-alerts/idx-alert-search")
    const { scorePropertyForAlert } = await import("@/lib/property-alerts/alert-matcher")
    // Always use session brokerage
    const result = await searchIDXForAlert("preview", criteria, auth.brokerageId)
    const matched = result.results.filter(p => scorePropertyForAlert(p, criteria).qualifies).length
    return { success: true, matchCount: matched, configured: result.api_called, error: result.error }
  } catch (err: any) {
    return { success: false, matchCount: 0, error: err?.message }
  }
}

// ── prefillFromProfile ────────────────────────────────────────────────────────
export async function prefillFromProfile(contactId: string) {
  const gate = await requireBuyerAccess(contactId)
  if (!gate.ok) return { success: false, error: gate.error, profile: null }

  const svc = createServiceClient()
  const { data } = await svc
    .from("property_interests")
    .select("*")
    .eq("contact_id", contactId)
    .maybeSingle()
  return { success: true, profile: data ?? null }
}
