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
import { searchIDXForAlert } from "./idx-alert-search"
import { scorePropertyForAlert } from "./alert-matcher"
import { deliverAlertResults } from "./alert-notifier"
import type { AlertProperty } from "./alert-matcher"
import { isSnoozed } from "./alert-cadence"

export interface RunAlertResult {
  success: boolean
  alertId: string
  propertiesChecked: number
  propertiesMatched: number
  propertiesSent: number
  error?: string
}

export async function runAlert(alertId: string): Promise<RunAlertResult> {
  const supabase = createServiceClient()

  // ── 1. Load alert + contact + brokerage ───────────────────────────────────
  const { data: alert, error: alertErr } = await supabase
    .from("property_alerts")
    .select("*, contacts(id, first_name, last_name, email, phone, agent_id, brokerage_id)")
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

  // ── 2. IDX search ─────────────────────────────────────────────────────────
  const searchResult = await searchIDXForAlert(alertId, alert, brokerageId)

  if (searchResult.error === "not_configured") {
    await logDelivery({ supabase, alertId, brokerageId, contactId: alert.contact_id, batchId,
      propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0,
      apiCalled: false, responseTimeMs: null, error: "idx_not_configured" })
    return { success: false, alertId, propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0, error: "idx_not_configured" }
  }

  if (searchResult.error) {
    await logDelivery({ supabase, alertId, brokerageId, contactId: alert.contact_id, batchId,
      propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0,
      apiCalled: searchResult.api_called, responseTimeMs: searchResult.response_time_ms, error: searchResult.error })
    return { success: false, alertId, propertiesChecked: 0, propertiesMatched: 0, propertiesSent: 0, error: searchResult.error }
  }

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
    await supabase.from("property_alerts").update({ last_run_at: new Date().toISOString(), last_match_count: 0 }).eq("id", alertId)
    await logDelivery({ supabase, alertId, brokerageId, contactId: alert.contact_id, batchId,
      propertiesChecked, propertiesMatched: 0, propertiesSent: 0,
      apiCalled: searchResult.api_called, responseTimeMs: searchResult.response_time_ms })
    return { success: true, alertId, propertiesChecked, propertiesMatched: 0, propertiesSent: 0 }
  }

  // Respect max_results_per_alert
  const capped = newResults.slice(0, alert.max_results_per_alert ?? 10)

  // ── 5. Insert property_alert_results ──────────────────────────────────────
  await supabase.from("property_alert_results").insert(
    capped.map(p => ({
      brokerage_id:           brokerageId,
      alert_id:               alertId,
      contact_id:             alert.contact_id,
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
  })

  // ── 9. Lifecycle sub-event ────────────────────────────────────────────────
  // emitKernelEvent does INSERT + reactor fan-out (staff notifications + sequence enrollment +
  // client portal card). A bare lifecycle_events INSERT silently skipped all three downstream
  // channels — buyers never saw the matched-property card on their portal.
  if (propertiesMatched > 0) {
    await emitKernelEvent({
      event:       "property.alert.matched",
      brokerageId,
      entityType:  "buyer_lifecycle",
      entityId:    alert.contact_id,
      contactId:   alert.contact_id,
      agentUserId: alert.agent_user_id,
      metadata:    { alert_id: alertId, properties_matched: propertiesMatched, batch_id: batchId },
    })
  }

  return { success: true, alertId, propertiesChecked, propertiesMatched, propertiesSent }
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
  errors: string[]
}> {
  const supabase = createServiceClient()

  const query = supabase
    .from("property_alerts")
    .select("id, snoozed_until")
    .eq("frequency", frequency)
    .eq("is_active", true)

  if (brokerageId) query.eq("brokerage_id", brokerageId)

  const { data: alerts } = await query

  if (!alerts?.length) return { total: 0, succeeded: 0, failed: 0, skippedSnoozed: 0, deferred: 0, errors: [] }

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

  // Sequential per spec — not parallel to avoid IDX rate limits
  for (const { id } of batch) {
    const result = await runAlert(id)
    if (result.success) succeeded++
    else { failed++; if (result.error) errors.push(`${id}: ${result.error}`) }
  }

  return { total: batch.length, succeeded, failed, skippedSnoozed, deferred, errors }
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
