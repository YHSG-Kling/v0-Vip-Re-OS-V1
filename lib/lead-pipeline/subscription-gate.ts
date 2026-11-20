// lib/lead-pipeline/subscription-gate.ts
// The lead-scraping cron must only spend on territories owned by brokerages with
// an ACTIVE subscription — otherwise it ingests leads that can never be assigned.
// `active` and `trialing` subscribers are served (trials are live customers);
// past_due / cancelled / paused are not. Pure + testable; the cron uses
// activeSubscriberBrokerageIds() to filter lead_scraping_markets before scraping.
//
// TOMBSTONE (wave 99A, LAW 2): this file used to be a SECOND access decision —
// a status list that knew nothing of trial expiry, so a tenant whose trial ran
// out on day 14 kept being scraped for as long as its row still read 'trialing'.
// The decision now delegates to the ONE resolver's classifier,
// lib/billing/billing-access.ts resolveBillingAccess, under the capability rule
// PAID_CAPABILITIES['lead.scrape'] (graceAllowed:false — past_due was never
// served here and still is not). The status list below survives only as the
// vocabulary the coverage surface prints.
import { resolveBillingAccess, PAID_CAPABILITIES } from "@/lib/billing/billing-access"

export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const

export function isActiveSubscriptionStatus(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
}

/**
 * PURE: may this subscription row's tenant be scraped (capability 'lead.scrape')?
 * A row that carries `trial_end` is classified by the resolver (an expired trial
 * is refused). A row read WITHOUT the column (`trial_end` undefined — a caller
 * that did not select it) can only be judged on status; every production caller
 * selects it.
 */
function servesLeadScrape(
  s: { status: string | null; trial_end?: string | null },
  now: Date = new Date(),
): boolean {
  if (!isActiveSubscriptionStatus(s.status)) return false
  if (s.trial_end === undefined) return true
  const access = resolveBillingAccess({ status: s.status, trial_end: s.trial_end }, now)
  if (access.blocked) return false
  return access.reason !== "past_due_in_grace" || PAID_CAPABILITIES["lead.scrape"].graceAllowed
}

/**
 * From a list of subscription rows, return the set of brokerage_ids that may be
 * scraped (have at least one subscription the resolver serves for lead.scrape).
 */
export function activeSubscriberBrokerageIds(
  subscriptions: Array<{ brokerage_id: string | null; status: string | null; trial_end?: string | null }>,
  now: Date = new Date(),
): Set<string> {
  const ids = new Set<string>()
  for (const s of subscriptions) {
    if (s.brokerage_id && servesLeadScrape(s, now)) ids.add(s.brokerage_id)
  }
  return ids
}
