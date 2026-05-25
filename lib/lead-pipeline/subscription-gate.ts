// lib/lead-pipeline/subscription-gate.ts
// The lead-scraping cron must only spend on territories owned by brokerages with
// an ACTIVE subscription — otherwise it ingests leads that can never be assigned.
// `active` and `trialing` subscribers are served (trials are live customers);
// past_due / cancelled / paused are not. Pure + testable; the cron uses
// activeSubscriberBrokerageIds() to filter lead_scraping_markets before scraping.

export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const

export function isActiveSubscriptionStatus(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
}

/**
 * From a list of subscription rows, return the set of brokerage_ids that may be
 * scraped (have at least one active/trialing subscription).
 */
export function activeSubscriberBrokerageIds(
  subscriptions: Array<{ brokerage_id: string | null; status: string | null }>,
): Set<string> {
  const ids = new Set<string>()
  for (const s of subscriptions) {
    if (s.brokerage_id && isActiveSubscriptionStatus(s.status)) ids.add(s.brokerage_id)
  }
  return ids
}
