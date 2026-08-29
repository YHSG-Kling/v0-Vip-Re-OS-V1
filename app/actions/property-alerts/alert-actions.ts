"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runAlert } from "@/lib/property-alerts/alert-engine"
import { ensureSmsFirstChannels } from "@/app/actions/instant-property-alerts"
import { IDXBrokerClient } from "@/lib/idxbroker-client"
import { RENTCAST_ALERT_KEY_PREFIX } from "@/lib/property-alerts/idx-alert-search"

// ── Auth helpers ─────────────────────────────────────────────────────────────
//
// Property alerts have two distinct caller types:
//   1. Agents — work inside the CRM dashboard, scoped by brokerage_id
//   2. Buyers (contacts) — log in at /portal/login (Supabase magic link),
//      scoped by contacts.contact_user_id = auth.uid()
//      (This used to name /api/auth/contact-login. That route was deleted: it
//      had no callers and hand-set a `supabase-auth-token` cookie the app
//      never reads, so it could not have established a usable session.)
//
// Previous version of this file: most functions had no auth, and the
// callers that did have auth still trusted caller-supplied brokerageId /
// contactId, which is an IDOR vulnerability.

async function requireAgent(): Promise<
  | { ok: true; userId: string; brokerageId: string; teamId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "unauthenticated" }
  // `team_id` is new on this select. It is the middle tier of the IDX ownership
  // cascade (agent → team → brokerage → platform): a gate asked only at
  // brokerage scope cannot see a credential filed at team scope, and would then
  // spend the platform's RentCast on a tenant who owns a feed.
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "unauthenticated" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, teamId: (u.team_id as string | null) ?? null }
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
//
// KEPT, AND NARROWED TO ITS ONE HONEST CALLER. This is the "Test connection"
// button on app/dashboard/settings/integrations/idx-broker/page.tsx: an admin who
// just entered an IDX Broker key is asking whether THAT key works, so a live IDX
// call is the whole point and RentCast is irrelevant to the question.
//
// It is no longer what the ALERTS screen asks. That screen needs "which source
// answers these saved searches", which is a different question with a different
// answer — see resolveAlertListingSourceStatus below.
export async function testIdxConnection(brokerageId?: string) {
  const auth = await requireAgent()
  if (!auth.ok) return { success: false, error: auth.error }

  // Ignore caller-supplied brokerageId — always use session's
  try {
    // Asked at the FULLEST scope this caller holds, so the test exercises the
    // same credential the search will actually resolve (agent → team →
    // brokerage → platform). Testing at brokerage scope while the search runs on
    // an agent-scope key is a green test over an untested credential.
    const client = await IDXBrokerClient.forBrokerage(auth.brokerageId, {
      agentUserId: auth.userId,
      teamId: auth.teamId,
    })
    if (!client.isConfigured()) {
      return { success: false, error: "No API key configured for this brokerage" }
    }
    const results = await client.searchProperties("active")
    return { success: true, configured: true, resultCount: Array.isArray(results) ? results.length : 0 }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Connection failed" }
  }
}

// ── resolveAlertListingSourceStatus ──────────────────────────────────────────
//
// THE ALERTS SCREEN'S STATUS, WHICH USED TO BE `testIdxConnection`'s. That probe
// asked exactly one question — "is IDX Broker configured for this brokerage?" —
// and drove a banner reading "IDX Not Configured". That was the whole truth
// while this lane was IDX-only. It is a LIE now: property alerts are served by
// the platform's RentCast for every tenant that has not connected an IDX Broker
// account, so the screen would tell an agent their alerts are broken while they
// run perfectly.
//
// It asks the SAME gate and the SAME selector the search itself asks
// (lib/property/rentcast-eligibility.ts, lib/property/listing-source.ts), so the
// banner and the sweep can never disagree about which source answers.
//
// NO PROVIDER CALL IS MADE. The IDX probe issues a live search; the eligibility
// gate is a credential read and an env read, so this status costs no vendor
// spend and cannot be metered against the tenant.
export async function resolveAlertListingSourceStatus(brokerageId?: string) {
  const auth = await requireAgent()
  if (!auth.ok) return { success: false, error: auth.error }

  // Ignore caller-supplied brokerageId — always use the session's (§4).
  try {
    const { resolveRentcastEligibility } = await import("@/lib/property/rentcast-eligibility")
    const { resolveListingSource } = await import("@/lib/property/listing-source")
    const eligibility = await resolveRentcastEligibility({
      brokerageId: auth.brokerageId,
      agentUserId: auth.userId,
      teamId: auth.teamId,
    })

    // FAIL CLOSED, AND SAY SO. "We could not read the connection" is not
    // "nothing is connected"; the sweep refuses in this state, so the banner
    // must not show a working lane.
    if (eligibility.idx.status === "unreadable") {
      return { success: true, source: "unreadable" as const, detail: eligibility.detail }
    }

    let source = resolveListingSource({
      hasIdx: eligibility.idx.status === "connected",
      hasRentcast: eligibility.eligible,
    })
    let idxCredentialTier: "tenant" | "platform_floor" | null =
      source === "idx" ? "tenant" : null

    // The platform IDX floor, consulted exactly where the search module consults
    // it: only when the answer would otherwise be "no source".
    if (source === "none") {
      const client = await IDXBrokerClient.forBrokerage(auth.brokerageId, {
        agentUserId: auth.userId,
        teamId: auth.teamId,
      })
      if (client.isConfigured()) {
        source = "idx"
        idxCredentialTier = "platform_floor"
      }
    }

    const detail =
      source === "idx" && idxCredentialTier === "tenant"
        ? "Property alerts search this brokerage's own IDX Broker feed."
        : source === "idx"
        ? "Property alerts search the platform's IDX Broker account. Connecting your own IDX Broker credentials switches them to your board."
        : source === "rentcast"
        ? "Property alerts are served by the platform's property data provider. Connecting your own IDX Broker credentials switches them to your board."
        : `No property source can answer alerts for this brokerage right now. ${eligibility.detail}`

    return { success: true, source, idxCredentialTier, detail }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Could not resolve the listing source" }
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

    // The saved search has no state column and RentCast cannot search a city
    // without one, so the tenant's own state is resolved here — the same source
    // the engine uses. The error is read: an unreadable brokerage row must not
    // silently become "this tenant has no state".
    const svc = createServiceClient()
    const { data: brokerage, error: brokerageErr } = await svc
      .from("brokerages").select("state").eq("id", auth.brokerageId).maybeSingle()
    if (brokerageErr) {
      console.error(`[alerts] preview: brokerage state read refused (${brokerageErr.message})`)
    }

    // Always use the session's brokerage, and ask the gate at the FULLEST scope
    // this caller holds so an agent's own IDX connection is seen.
    const result = await searchIDXForAlert("preview", criteria, {
      brokerageId: auth.brokerageId,
      agentUserId: auth.userId,
      teamId: auth.teamId,
      state: (brokerage?.state as string | null | undefined) ?? null,
    })

    // A REFUSAL IS NOT A PREVIEW OF ZERO. An agent tuning a saved search must
    // not read "0 matches" when nothing was searched — that is the same lie the
    // cron sweep used to tell the buyer, on the screen where the search is
    // written.
    if (result.refusal) {
      return { success: false, matchCount: 0, source: result.source, error: result.error ?? result.refusal }
    }

    const matched = result.results.filter(p => scorePropertyForAlert(p, criteria).qualifies).length
    return { success: true, matchCount: matched, source: result.source, configured: result.api_called, error: result.error }
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

// ─────────────────────────────────────────────────────────────────────────────
// PER-RESULT ACTIONS — the three buttons on an alert match.
//
// "Save for Buyer", "Add to Tour" and "Send Now" were rendered on every alert
// match and NONE of them had an onClick. The capability behind each one was
// complete and had been for a long time; the wire between them was never built.
// An agent clicked, nothing happened, and nothing said so.
//
// IN-HOUSE AND OUTSIDE PROPERTIES ARE BOTH HANDLED, and the branch lives HERE
// rather than in the client. property_alert_results carries `listing_id` (a real
// listings.id, set when the match is one of ours) OR `mls_number` (an outside
// property from the IDX feed). recordBuyerPropertyAction already speaks both —
// it takes a synthetic "ext_<source>_<id>" for an outside property and stores
// only source/external_property_id/listing_url, never the MLS facts, per the
// data-display rules.
//
// Deciding the identity class on the SERVER, from the row, is deliberate: a
// client that guessed wrong would write an external id into a uuid column, or
// worse, silently attach a buyer to the wrong property.
// ─────────────────────────────────────────────────────────────────────────────

/** PURE-ish: the property identity for a result row, in the form the kernel wants.
 *
 *  THE SOURCE IS PART OF THE IDENTITY. `recordBuyerPropertyAction` parses
 *  `ext_<source>_<id>` and files `<source>` in `saved_properties.source`, so a
 *  handle is not just a key — it is the attribution of the buyer's save. Since
 *  the alert rail gained the platform's RentCast tier beside IDX
 *  (lib/property-alerts/idx-alert-search.ts), a bare `ext_idx_` on every outside
 *  match would record every RentCast save as an IDX save, and split it from the
 *  `rentcast`-sourced row the market-watch lane writes for the same home
 *  (lib/buyer-search/external-match.ts). property_alert_results carries no
 *  source column, so the source travels in the key's namespace instead — see
 *  RENTCAST_ALERT_KEY_PREFIX for why that namespace exists. */
function resultPropertyId(row: { listing_id: string | null; mls_number: string | null }): string | null {
  if (row.listing_id) return row.listing_id          // ours — a real listings.id
  if (row.mls_number?.startsWith(RENTCAST_ALERT_KEY_PREFIX)) {
    return `ext_rentcast_${row.mls_number.slice(RENTCAST_ALERT_KEY_PREFIX.length)}`
  }
  if (row.mls_number) return `ext_idx_${row.mls_number}` // outside — the IDX feed's id
  return null
}

/**
 * "Save for Buyer" / "Add to Tour" — one action, two interest levels.
 * `tour_requested` is what sets saved_properties.added_to_tour, which is what the
 * Tour Planner reads; "saved" is the plain save.
 */
export async function saveAlertResultForBuyer(
  resultId: string,
  interestLevel: "saved" | "tour_requested",
) {
  const svc = createServiceClient()
  const { data: row, error: rowErr } = await svc
    .from("property_alert_results")
    .select("id, alert_id, contact_id, brokerage_id, listing_id, mls_number, listing_url, property_address")
    .eq("id", resultId)
    .maybeSingle()
  if (rowErr) return { success: false, error: rowErr.message }
  if (!row) return { success: false, error: "Alert result not found" }

  // Authorise through the ALERT, which is the object the caller has access to.
  const gate = await requireAlertAccess(row.alert_id as string)
  if (!gate.ok) return { success: false, error: gate.error }

  const propertyId = resultPropertyId(row as any)
  if (!propertyId) {
    return { success: false, error: "This match has neither a listing nor an MLS number to save" }
  }

  const { data: contact } = await svc
    .from("contacts").select("agent_id").eq("id", row.contact_id as string).maybeSingle()

  const { recordBuyerPropertyAction } = await import("@/lib/kernel/forms")
  const result = await recordBuyerPropertyAction({
    contact_id:     row.contact_id as string,
    listing_id:     propertyId,
    interest_level: interestLevel,
    brokerage_id:   row.brokerage_id as string,
    agent_id:       ((contact as any)?.agent_id as string) ?? "",
  })
  if (!result.success) return { success: false, error: result.error }

  // Mirror it onto the result row so the alert list reflects what was done.
  // Checked, not fire-and-forget: a lost mirror makes the agent click twice.
  const { error: mirrorErr } = await svc
    .from("property_alert_results")
    .update({ buyer_saved: true, buyer_reaction: interestLevel })
    .eq("id", resultId)
  if (mirrorErr) {
    console.error("[alerts] saved, but the result row was not updated:", mirrorErr.message)
  }

  return { success: true }
}

/**
 * "Send Now" — push THIS match to the buyer immediately, through the same
 * notifier the scheduled run uses, so the channel choice, the templates and the
 * delivery record are identical to an automatic send.
 */
export async function sendAlertResultNow(resultId: string) {
  const svc = createServiceClient()
  const { data: row, error: rowErr } = await svc
    .from("property_alert_results")
    .select("*")
    .eq("id", resultId)
    .maybeSingle()
  if (rowErr) return { success: false, error: rowErr.message }
  if (!row) return { success: false, error: "Alert result not found" }

  const gate = await requireAlertAccess(row.alert_id as string)
  if (!gate.ok) return { success: false, error: gate.error }

  const { data: alert } = await svc
    .from("property_alerts").select("*").eq("id", row.alert_id as string).maybeSingle()
  if (!alert) return { success: false, error: "Alert not found" }

  const { deliverAlertResults } = await import("@/lib/property-alerts/alert-notifier")
  const batchId = crypto.randomUUID()
  const delivery = await deliverAlertResults(
    alert,
    [{
      mls_number:       (row.mls_number as string) ?? "",
      property_address: row.property_address as string,
      city:             (row.city as string) ?? undefined,
      state:            (row.state as string) ?? undefined,
      zip:              (row.zip as string) ?? undefined,
      list_price:       (row.list_price as number) ?? undefined,
      bedrooms:         (row.bedrooms as number) ?? undefined,
      bathrooms:        (row.bathrooms as number) ?? undefined,
      sqft:             (row.sqft as number) ?? undefined,
      property_type:    (row.property_type as string) ?? undefined,
      days_on_market:   (row.days_on_market as number) ?? undefined,
      listing_url:      (row.listing_url as string) ?? undefined,
      primary_photo_url:(row.primary_photo_url as string) ?? undefined,
      is_price_reduction: (row.is_price_reduction as boolean) ?? false,
      previous_price:   (row.previous_price as number) ?? undefined,
      listed_at:        (row.listed_at as string) ?? undefined,
      matchScore:       (row.match_score as number) ?? 0,
      matchReasons:     (row.match_reasons as string[]) ?? [],
    }],
    row.brokerage_id as string,
    batchId,
  )

  // The notifier REPORTS its failures instead of throwing. Read them — a send
  // that reached zero channels must never render as a send.
  if (delivery.sent === 0) {
    return {
      success: false,
      error: delivery.errors.length
        ? `Not sent: ${delivery.errors.join(", ")}`
        : "Not sent — the buyer has no reachable channel on this alert",
    }
  }

  const { error: stampErr } = await svc
    .from("property_alert_results")
    .update({
      delivered_at: new Date().toISOString(),
      delivery_channel: delivery.channelsUsed.join(","),
      delivery_batch_id: batchId,
    })
    .eq("id", resultId)
  if (stampErr) console.error("[alerts] delivered, but the result row was not stamped:", stampErr.message)

  return { success: true, channels: delivery.channelsUsed }
}
