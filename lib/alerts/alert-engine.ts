/**
 * lib/alerts/alert-engine.ts
 * Spec: runAlertEngine(brokerageId) → AlertEngineResult
 * Batch limit: 50 alerts per brokerage per run.
 * Frequency gating per spec.
 */

import { createServiceClient }        from "@/lib/supabase/service"
import { IDXBrokerClient }            from "@/lib/idxbroker-client"
import { scorePropertyAgainstAlert }  from "./alert-matcher"
import { sendAlertNotification }      from "./alert-notifier"
import type { IDXProperty, PropertyAlert } from "./alert-matcher"

export interface AlertEngineResult {
  alertsProcessed:    number
  newMatchesFound:    number
  notificationsSent:  number
  errors:             string[]
}

const BATCH_LIMIT = 50

/** Returns true if this alert should run based on its frequency and current time. */
function shouldRunNow(frequency: string): boolean {
  const now  = new Date()
  const hour = now.getUTCHours()
  const day  = now.getUTCDay() // 0 = Sunday, 1 = Monday

  switch (frequency) {
    case "instant":     return true
    case "twice_daily": return hour === 8 || hour === 17
    case "daily":       return hour === 8
    case "weekly":      return day === 1 && hour === 8
    default:            return false
  }
}

export async function runAlertEngine(brokerageId: string): Promise<AlertEngineResult> {
  const supabase = createServiceClient()
  const errors:  string[] = []
  let alertsProcessed   = 0
  let newMatchesFound   = 0
  let notificationsSent = 0

  // 1. Fetch active alerts for brokerage (not paused, batch 50)
  const { data: alerts, error: alertsErr } = await supabase
    .from("property_alerts")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .neq("frequency", "paused")
    .limit(BATCH_LIMIT)

  if (alertsErr || !alerts?.length) return { alertsProcessed: 0, newMatchesFound: 0, notificationsSent: 0, errors: [] }

  // 2. Frequency gate
  const eligible = alerts.filter(a => shouldRunNow(a.frequency))
  if (!eligible.length) return { alertsProcessed: 0, newMatchesFound: 0, notificationsSent: 0, errors: [] }

  // 3. IDX client for brokerage (single instance for all alerts)
  const idxClient = await IDXBrokerClient.forBrokerage(brokerageId)

  for (const alert of eligible) {
    alertsProcessed++
    try {
      // 3. Search IDX with alert criteria
      const idxResults: IDXProperty[] = await idxClient.searchProperties(buildIDXQuery(alert))
      if (!Array.isArray(idxResults) || idxResults.length === 0) continue

      // 4. Score each result — skip below 40
      const scored = idxResults
        .map(p => ({ property: p, score: scorePropertyAgainstAlert(p, alert, p.isPriceReduction ?? false) }))
        .filter(({ score }) => score >= 40)

      if (scored.length === 0) continue

      // 5. Dedup against property_alert_results
      const { data: existing } = await supabase
        .from("property_alert_results")
        .select("mls_number")
        .eq("alert_id", alert.id)

      const sentSet = new Set((existing ?? []).map((r: any) => r.mls_number))

      const newMatches = scored.filter(({ property }) => !sentSet.has(property.mlsId))
      if (newMatches.length === 0) continue

      newMatchesFound += newMatches.length

      // 6. INSERT into property_alert_results
      await supabase.from("property_alert_results").insert(
        newMatches.map(({ property, score }) => ({
          brokerage_id:      brokerageId,
          alert_id:          alert.id,
          contact_id:        alert.contact_id,
          mls_number:        property.mlsId,
          property_address:  property.address,
          city:              property.city,
          zip:               property.zipCode,
          list_price:        property.listPrice,
          bedrooms:          property.bedrooms,
          bathrooms:         property.bathrooms,
          sqft:              property.sqft,
          property_type:     property.type,
          days_on_market:    property.daysOnMarket,
          listing_url:       property.listingUrl,
          primary_photo_url: property.photoUrl,
          is_price_reduction: property.isPriceReduction ?? false,
          is_new_listing:    !property.isPriceReduction,
          match_score:       score,
        }))
      )

      // 7. Deliver via notifier
      const notify = await sendAlertNotification(
        alert.id,
        alert.contact_id,
        alert.agent_user_id,
        newMatches.map(({ property, score }) => ({
          alertId:     alert.id,
          contactId:   alert.contact_id,
          agentUserId: alert.agent_user_id,
          brokerageId,
          mlsId:       property.mlsId,
          address:     property.address,
          city:        property.city,
          listPrice:   property.listPrice,
          bedrooms:    property.bedrooms,
          bathrooms:   property.bathrooms,
          matchScore:  score,
          listingUrl:  property.listingUrl,
          photoUrl:    property.photoUrl,
          isPriceReduction: property.isPriceReduction ?? false,
        })),
        alert.delivery_channels ?? ["in_app"]
      )

      if (notify.sent) notificationsSent++

      // Log even if 0 new matches — per spec
      await supabase.from("property_alert_delivery_log").insert({
        brokerage_id:       brokerageId,
        alert_id:           alert.id,
        contact_id:         alert.contact_id,
        run_triggered_by:   "cron",
        properties_checked: idxResults.length,
        properties_matched: newMatches.length,
        properties_sent:    notify.sent ? newMatches.length : 0,
        channels_used:      notify.channel ? [notify.channel] : [],
        idx_api_called:     true,
        error_message:      null,
      })

      // Update alert stats
      await supabase.from("property_alerts")
        .update({
          last_run_at:       new Date().toISOString(),
          last_match_count:  newMatches.length,
          total_alerts_sent: (alert.total_alerts_sent ?? 0) + (notify.sent ? newMatches.length : 0),
        })
        .eq("id", alert.id)

    } catch (err: any) {
      const msg = `alert ${alert.id}: ${err?.message ?? "unknown error"}`
      console.error("[alert-engine]", msg)
      errors.push(msg)

      // Log error run
      await supabase.from("property_alert_delivery_log").insert({
        brokerage_id:       brokerageId,
        alert_id:           alert.id,
        contact_id:         alert.contact_id,
        run_triggered_by:   "cron",
        properties_checked: 0,
        properties_matched: 0,
        properties_sent:    0,
        channels_used:      [],
        idx_api_called:     false,
        error_message:      err?.message ?? "unknown",
      }).catch(() => {})
    }
  }

  return { alertsProcessed, newMatchesFound, notificationsSent, errors }
}

/** Builds a query string from alert criteria for IDX search. */
function buildIDXQuery(alert: PropertyAlert & Record<string, any>): string {
  const parts: string[] = []
  if (alert.cities?.length)         parts.push(alert.cities.join(","))
  if (alert.zip_codes?.length)      parts.push(alert.zip_codes.join(","))
  if (alert.min_price != null)      parts.push(`minPrice:${alert.min_price}`)
  if (alert.max_price != null)      parts.push(`maxPrice:${alert.max_price}`)
  if (alert.bedrooms_min != null)   parts.push(`beds:${alert.bedrooms_min}`)
  if (alert.bathrooms_min != null)  parts.push(`baths:${alert.bathrooms_min}`)
  if (alert.property_types?.length) parts.push(alert.property_types.join(","))
  return parts.join(" ")
}
