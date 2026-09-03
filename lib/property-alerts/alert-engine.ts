// Alert engine — orchestrates search → score → dedup → deliver → log
//
// THE ONE property-alert engine. lib/alerts/ carried a second, independently
// scheduled one (runAlertEngine, /api/alerts/cron at :06/:21/:36/:51) over these
// same three tables, with its own IDX query builder, its own matcher and its own
// cadence clock. Every active alert was being processed twice an hour by two
// different code paths; only the shared property_alert_results dedup kept buyers
// from being mailed the same listing twice.
//
// This one won on merit — it honours max_results_per_alert, re-sends on a NEW
// price reduction, logs api_called / response_time_ms / batch_id, and runs the
// first-look consent gate. The one thing the other had that this lacked was the
// buyer SNOOZE, ported below: without it, a buyer who muted their search kept
// receiving alerts from this path regardless.
import { createServiceClient } from "@/lib/supabase/service"
import { emitKernelEvent }     from "@/lib/kernel/emit"
import { KernelEvent }         from "@/lib/kernel/events"
import { searchIDXForAlert, type AlertSearchRefusal } from "./idx-alert-search"
import { scorePropertyForAlert } from "./alert-matcher"
import { deliverAlertResults } from "./alert-notifier"
import type { AlertProperty } from "./alert-matcher"
import type { ListingSource } from "@/lib/property/listing-source"
import { isSnoozed } from "./alert-cadence"

export interface RunAlertResult {
  success: boolean
  alertId: string
  propertiesChecked: number
  propertiesMatched: number
  propertiesSent: number
  /**
   * WHICH SOURCE ANSWERED — the tenant's own IDX board, the platform's RentCast,
   * or neither. Reported per alert and totalled by the sweep, because "nobody
   * matched" and "nobody looked" are opposite facts and the cron log used to
   * carry neither.
   */
  source?: ListingSource
  /**
   * SET = THIS ALERT COULD NOT BE EVALUATED. Distinct from `error`, which is
   * also used for a genuine per-alert failure (a missing alert, a snooze). A
   * refusal never records a zero match count against the search.
   */
  refusal?: AlertSearchRefusal
  error?: string
}

export async function runAlert(alertId: string): Promise<RunAlertResult> {
  const supabase = createServiceClient()

  // ── 1. Load alert + contact + brokerage ───────────────────────────────────
  // `contacts.state` and `contacts.team_id` are new on this select and are read
  // by the source resolution below: the team is a tier of the IDX ownership
  // cascade, and the state is what turns a saved search's CITY into something
  // RentCast can actually search. Both are additive — the notifier is handed the
  // same object and reads only the fields it already read.
  const { data: alert, error: alertErr } = await supabase
    .from("property_alerts")
    .select("*, contacts(id, first_name, last_name, email, phone, agent_id, brokerage_id, state, team_id)")
    .eq("id", alertId)
    .eq("is_active", true)
    .maybeSingle()

  if (alertErr || !alert) {
    return { success: false, alertId, propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0, error: "alert_not_found" }
  }

  // A buyer's snooze is a mute, not a pause: it auto-expires. Ported from the
  // retired lib/alerts engine, which was the only path that honoured it.
  if (isSnoozed((alert as any).snoozed_until)) {
    return { success: false, alertId, propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0, error: "snoozed" }
  }

  const brokerageId: string = alert.brokerage_id
  const batchId = crypto.randomUUID()

  // ── 2. Listing search — the tenant's IDX board, else the platform's RentCast ─
  //
  // The source decision lives in lib/property-alerts/idx-alert-search.ts, which
  // asks the ONE gate and the ONE selector the rest of the property lane uses.
  // This branch used to compare `searchResult.error === "not_configured"` by
  // string equality and treat it as terminal; a tenant with no IDX credential
  // therefore received NOTHING on every sweep, forever, and the buyer read that
  // as an empty market.
  const searchResult = await searchIDXForAlert(alertId, alert, {
    brokerageId,
    // property_alerts.agent_user_id is a USERS.id (FK → users), which is the id
    // class the agent tier of the IDX ownership cascade is keyed on. agents.id
    // and contacts.id are disjoint spaces and neither is substituted for it.
    agentUserId: (alert as any).agent_user_id ?? null,
    teamId: (alert as any).contacts?.team_id ?? null,
    // Vendor-ledger attribution only. property_alerts.contact_id is FK → contacts,
    // so a pre-conversion record cannot reach a property provider through here.
    contactId: alert.contact_id,
    state: await resolveAlertSearchState(supabase, alert, brokerageId),
  })

  // A REFUSAL IS NOT A ZERO. `refusal` set means nothing was searched: the
  // source check was unreadable, no provider can serve this tenant, the saved
  // search names no area the provider can search, or the provider failed. None
  // of those may update last_match_count or tell the buyer the market is empty.
  if (searchResult.refusal) {
    await logDelivery({ supabase, alertId, brokerageId, contactId: alert.contact_id, batchId,
      propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0,
      apiCalled: searchResult.api_called, responseTimeMs: searchResult.response_time_ms,
      error: `${searchResult.refusal}: ${searchResult.error ?? "no detail"}` })
    return {
      success: false, alertId, propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0,
      source: searchResult.source, refusal: searchResult.refusal, error: searchResult.refusal,
    }
  }

  // The search RAN. `searchResult.error` here is a degradation note (a partial
  // area failure, or our own board being unreadable) and rides along on the
  // delivery log beside a real result count — never as a refusal.
  const degradedNote = searchResult.error
  const propertiesChecked = searchResult.results.length

  // ── 3. Score each property ────────────────────────────────────────────────
  const scored = searchResult.results
    .map(p => ({ property: p, match: scorePropertyForAlert(p, alert) }))
    .filter(({ match }) => match.qualifies)

  // ── 4. Dedup against already-sent results ─────────────────────────────────
  const { data: existingResults } = await supabase
    .from("property_alert_results")
    .select("mls_number, is_price_reduction, list_price")
    .eq("alert_id", alertId)

  const sentMlsNums = new Map<string, { is_price_reduction: boolean; list_price: number | null }>(
    (existingResults ?? []).map(r => [r.mls_number, { is_price_reduction: r.is_price_reduction, list_price: r.list_price }])
  )

  const newResults: Array<AlertProperty & { matchScore: number; matchReasons: string[] }> = []

  for (const { property, match } of scored) {
    const prev = sentMlsNums.get(property.mls_number)
    if (!prev) {
      newResults.push({ ...property, matchScore: match.score, matchReasons: match.reasons })
      continue
    }
    // Already sent — only re-send if it's a NEW price reduction we haven't seen
    if (property.is_price_reduction && !prev.is_price_reduction) {
      newResults.push({ ...property, matchScore: match.score, matchReasons: match.reasons })
    }
  }

  const propertiesMatched = newResults.length

  if (propertiesMatched === 0) {
    // An HONEST zero: a source answered and nothing new qualified. The degraded
    // note, when present, says which part of the search was thinner than it
    // should have been, so this zero is never mistaken for a complete sweep.
    await supabase.from("property_alerts").update({ last_run_at: new Date().toISOString(), last_match_count: 0 }).eq("id", alertId)
    await logDelivery({ supabase, alertId, brokerageId, contactId: alert.contact_id, batchId,
      propertiesChecked, propertiesMatched: 0, propertiesSent: 0,
      apiCalled: searchResult.api_called, responseTimeMs: searchResult.response_time_ms,
      error: degradedNote })
    return { success: true, alertId, propertiesChecked, propertiesMatched: 0, propertiesSent: 0, source: searchResult.source }
  }

  // Respect max_results_per_alert
  const capped = newResults.slice(0, alert.max_results_per_alert ?? 10)

  // ── 5. Insert property_alert_results ──────────────────────────────────────
  // THE ERROR IS READ (§3). supabase-js RESOLVES a refusal, so a rejected insert
  // was byte-identical to a stored batch — and this table is what the dedup in
  // step 4 reads on the NEXT run. A silent refusal here means the same homes are
  // mailed to the buyer again tomorrow.
  const { error: resultsInsertError } = await supabase.from("property_alert_results").insert(
    capped.map(p => ({
      brokerage_id:           brokerageId,
      alert_id:               alertId,
      contact_id:             alert.contact_id,
      // Set only when the match is one of OUR listings (internal-board tier).
      // The reader's "ours" branch (alert-actions.ts resultPropertyId) keys on
      // it; before this stamp it was structurally unreachable and in-house
      // saves were filed as external properties.
      listing_id:             p.listing_id ?? null,
      mls_number:             p.mls_number,
      property_address:       p.property_address,
      city:                   p.city,
      state:                  p.state,
      zip:                    p.zip,
      list_price:             p.list_price,
      bedrooms:               p.bedrooms,
      bathrooms:              p.bathrooms,
      sqft:                   p.sqft,
      property_type:          p.property_type,
      days_on_market:         p.days_on_market,
      listing_url:            p.listing_url,
      primary_photo_url:      p.primary_photo_url,
      is_price_reduction:     p.is_price_reduction ?? false,
      previous_price:         p.previous_price,
      price_reduction_percent: p.previous_price && p.list_price
        ? (((p.previous_price - p.list_price) / p.previous_price) * 100).toFixed(2)
        : null,
      listed_at:              p.listed_at,
      match_score:            p.matchScore,
      match_reasons:          p.matchReasons,
      is_new_listing:         !p.is_price_reduction,
      delivery_batch_id:      batchId,
    }))
  )
  if (resultsInsertError) {
    console.error(
      `[property-alerts] alert ${alertId} (brokerage ${brokerageId}): the matched results were REFUSED by the database (${resultsInsertError.message}) — the buyer may be re-sent these homes on the next run`,
    )
  }

  // ── 6. Deliver ────────────────────────────────────────────────────────────
  const deliverResult = await deliverAlertResults(alert, capped, brokerageId, batchId)
  const propertiesSent = deliverResult.sent

  // ── 7. Update alert stats ─────────────────────────────────────────────────
  await supabase.from("property_alerts").update({
    last_run_at:        new Date().toISOString(),
    last_match_count:   propertiesMatched,
    total_alerts_sent:  (alert.total_alerts_sent ?? 0) + propertiesSent,
  }).eq("id", alertId)

  // ── 8. Delivery log ───────────────────────────────────────────────────────
  await logDelivery({
    supabase, alertId, brokerageId, contactId: alert.contact_id, batchId,
    propertiesChecked, propertiesMatched, propertiesSent,
    channelsUsed: deliverResult.channelsUsed,
    apiCalled: searchResult.api_called,
    responseTimeMs: searchResult.response_time_ms,
    error: [degradedNote, resultsInsertError ? `results not stored: ${resultsInsertError.message}` : null]
      .filter(Boolean)
      .join("; ") || undefined,
  })

  // ── 9. Lifecycle sub-event ────────────────────────────────────────────────
  // emitKernelEvent does INSERT + reactor fan-out (staff notifications + sequence enrollment +
  // client portal card). A bare lifecycle_events INSERT silently skipped all three downstream
  // channels — buyers never saw the matched-property card on their portal.
  //
  // ONE VOCABULARY (§6, 2026-09-03): this emitted the DOTTED string
  // "property.alert.matched", which is not a KernelEvent value — so the reactor's
  // enum gate skipped it and the PROPERTY_ALERT_MATCHED portal template ("A home
  // matched your alert") never once rendered. The canonical spelling is the enum.
  if (propertiesMatched > 0) {
    await emitKernelEvent({
      event:       KernelEvent.PROPERTY_ALERT_MATCHED,
      brokerageId,
      entityType:  "buyer_lifecycle",
      entityId:    alert.contact_id,
      contactId:   alert.contact_id,
      agentUserId: alert.agent_user_id,
      metadata:    { alert_id: alertId, properties_matched: propertiesMatched, batch_id: batchId },
    })
  }

  return { success: true, alertId, propertiesChecked, propertiesMatched, propertiesSent, source: searchResult.source }
}

/**
 * The STATE a saved search's cities should be looked up in.
 *
 * `property_alerts` carries `cities` and `zip_codes` and no state column, and
 * RentCast cannot search a city without one (a ZIP needs none, which is why the
 * search module prefers ZIPs and only asks for this when it must). Two sources,
 * in order, neither of them a guess:
 *
 *   1. the BROKERAGE's own state — the tenant's market, and the state its saved
 *      searches are written in;
 *   2. the CONTACT's state, for a tenant row that carries none.
 *
 * Returns null when neither resolves; the search module then REFUSES with
 * `no_search_area` rather than issuing a national sweep. The brokerage read's
 * error is read and reported: an unreadable tenant row must not silently become
 * "this tenant has no state".
 */
async function resolveAlertSearchState(
  supabase: any,
  alert: any,
  brokerageId: string,
): Promise<string | null> {
  // Only pay for the read when it can change the outcome.
  const zips: unknown[] = alert?.zip_codes ?? []
  const cities: unknown[] = alert?.cities ?? []
  if (zips.length > 0 || cities.length === 0) return null

  const { data: brokerage, error } = await supabase
    .from("brokerages")
    .select("state")
    .eq("id", brokerageId)
    .maybeSingle()
  if (error) {
    console.error(
      `[property-alerts] brokerage state read refused for ${brokerageId} (${error.message}) — falling back to the contact's state`,
    )
  }
  const brokerageState = (brokerage?.state as string | null | undefined) ?? null
  if (brokerageState) return brokerageState
  return (alert?.contacts?.state as string | null | undefined) ?? null
}

/** Alerts processed per run, per frequency. See the cap note below. */
const RUN_BATCH_LIMIT = 50

export async function runAllActiveAlerts(
  frequency: string,
  brokerageId?: string
): Promise<{
  total: number
  succeeded: number
  failed: number
  /** Alerts skipped because the buyer has them snoozed. */
  skippedSnoozed: number
  /** Alerts that were due but over the per-run cap — the next run takes them. */
  deferred: number
  /**
   * WHICH SOURCE ANSWERED, counted. `idx` = a listing board (the tenant's own
   * connection, or the platform IDX floor); `rentcast` = the platform's default
   * provider; `none` = the sweep could not reach a provider for that alert.
   */
  bySource: Record<ListingSource, number>
  /**
   * HOW MANY ALERTS COULD NOT BE EVALUATED — the count this sweep never had. An
   * alert that refuses is not an alert with no matches, and until now the two
   * were the same line in the cron response.
   */
  unevaluated: number
  /** The refusal vocabulary, counted, so an operator sees WHICH wall was hit. */
  unevaluatedReasons: Partial<Record<AlertSearchRefusal, number>>
  errors: string[]
}> {
  const supabase = createServiceClient()

  const query = supabase
    .from("property_alerts")
    .select("id, snoozed_until")
    .eq("frequency", frequency)
    .eq("is_active", true)

  if (brokerageId) query.eq("brokerage_id", brokerageId)

  // THE ERROR IS READ (§3). A refused sweep read resolves with `data: null`,
  // which was byte-identical to "no alerts are due" — so a cron that could not
  // see a single alert reported a clean, successful run over zero of them.
  const { data: alerts, error: alertsError } = await query
  if (alertsError) {
    console.error(`[property-alerts] ${frequency}: the due-alert sweep was REFUSED (${alertsError.message}) — no alert was evaluated`)
    return {
      total: 0, succeeded: 0, failed: 0, skippedSnoozed: 0, deferred: 0,
      bySource: { idx: 0, rentcast: 0, none: 0 },
      unevaluated: 0, unevaluatedReasons: {},
      errors: [`sweep_refused: ${alertsError.message}`],
    }
  }

  if (!alerts?.length) {
    return {
      total: 0, succeeded: 0, failed: 0, skippedSnoozed: 0, deferred: 0,
      bySource: { idx: 0, rentcast: 0, none: 0 },
      unevaluated: 0, unevaluatedReasons: {},
      errors: [],
    }
  }

  const now = new Date()
  const due = (alerts as Array<{ id: string; snoozed_until: string | null }>)
    .filter((a) => !isSnoozed(a.snoozed_until, now))
  const skippedSnoozed = alerts.length - due.length

  // BATCH CAP, ported from the retired engine (which capped at 50 per brokerage
  // per run). One run must not be able to exhaust the IDX rate limit for
  // everyone else. Anything over the cap is NOT silently dropped — it is counted
  // and logged, and the next run of this frequency picks it up.
  const batch = due.slice(0, RUN_BATCH_LIMIT)
  const deferred = due.length - batch.length
  if (deferred > 0) {
    console.warn(
      `[property-alerts] ${frequency}: ${due.length} due, running ${batch.length} (cap ${RUN_BATCH_LIMIT}), ${deferred} deferred to the next run`,
    )
  }

  let succeeded = 0
  let failed = 0
  const errors: string[] = []
  const bySource: Record<ListingSource, number> = { idx: 0, rentcast: 0, none: 0 }
  const unevaluatedReasons: Partial<Record<AlertSearchRefusal, number>> = {}
  let unevaluated = 0

  // Sequential per spec — not parallel to avoid provider rate limits
  for (const { id } of batch) {
    const result = await runAlert(id)
    if (result.source) bySource[result.source]++
    if (result.refusal) {
      unevaluated++
      unevaluatedReasons[result.refusal] = (unevaluatedReasons[result.refusal] ?? 0) + 1
    }
    if (result.success) succeeded++
    else { failed++; if (result.error) errors.push(`${id}: ${result.error}`) }
  }

  // WHAT THE SWEEP ACTUALLY DID, ON ONE LINE. A cron whose only signal was
  // succeeded/failed could not distinguish "every buyer's market is quiet" from
  // "no provider answered for anyone", which is the failure this lane exists to
  // make impossible.
  console.log(
    `[property-alerts] ${frequency}: ${batch.length} run — sources idx=${bySource.idx} rentcast=${bySource.rentcast} none=${bySource.none}; ${unevaluated} could not be evaluated${
      unevaluated ? ` (${Object.entries(unevaluatedReasons).map(([r, n]) => `${r}=${n}`).join(", ")})` : ""
    }; ${skippedSnoozed} snoozed, ${deferred} deferred`,
  )

  return { total: batch.length, succeeded, failed, skippedSnoozed, deferred, bySource, unevaluated, unevaluatedReasons, errors }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function logDelivery(params: {
  supabase: any
  alertId: string
  brokerageId: string
  contactId: string
  batchId: string
  propertiesChecked: number
  propertiesMatched: number
  propertiesSent: number
  channelsUsed?: string[]
  apiCalled: boolean
  responseTimeMs: number | null
  error?: string
}) {
  await params.supabase.from("property_alert_delivery_log").insert({
    brokerage_id:       params.brokerageId,
    alert_id:           params.alertId,
    contact_id:         params.contactId,
    batch_id:           params.batchId,
    run_triggered_by:   "cron",
    properties_checked: params.propertiesChecked,
    properties_matched: params.propertiesMatched,
    properties_sent:    params.propertiesSent,
    channels_used:      params.channelsUsed ?? [],
    idx_api_called:     params.apiCalled,
    idx_response_time_ms: params.responseTimeMs,
    error_message:      params.error ?? null,
  })
}
