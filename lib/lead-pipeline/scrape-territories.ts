// lib/lead-pipeline/scrape-territories.ts
// ─── SHARED PRE-SCRAPE TERRITORY RESOLVER (canonical, owner round 38) ────────
//
// THE canonical scraping pre-pipeline starts here: "before scrape, check all
// active tenants and their territories which are set up in their settings at
// onboarding, then only scrape those areas."
//
// Territory source of truth: `lead_scraping_markets` (city / state / zip_codes /
// counties + per-source params), created and maintained through the brokerage
// scraping settings (app/actions/lead-scraping-config.ts — every market
// create/update also syncs `subscriber_service_areas`, the per-zip claim roster
// used by the platform distribution rotation).
//
// Active-tenant predicate: the brokerage has at least one subscription in
// ACTIVE_SUBSCRIPTION_STATUSES ("active" | "trialing") — see subscription-gate.
// past_due / cancelled / paused tenants are NOT scraped for.
//
// HONESTY RULE: when there are no active subscribers, or active subscribers have
// no active territories configured, every scraper NO-OPS with a stated reason.
// The platform never falls back to scraping fixed/global geography.
//
// All scrapers derive their scrape areas from this resolver:
//   • app/api/cron/lead-scraping/route.ts (ZenRows / BatchData / Apify social /
//     Exa / Tavily / OSINT / recruiting) iterates resolver territories only.
//   • lib/kernel/scraping.ts runScrapeSourcesChronologically filters its market
//     work-list through the same pure resolver.

import {
  activeSubscriberBrokerageIds,
} from "./subscription-gate"

// Minimal shape a territory row must carry to be scrapable. The DB rows from
// lead_scraping_markets are a superset (params relations, budget, priority…).
export interface ScrapeTerritoryLike {
  brokerage_id: string | null
  city?: string | null
  state?: string | null
  zip_codes?: string[] | null
  counties?: string[] | null
}

export type ScrapeNoOpReason =
  | "ok"
  | "no_active_subscribers"
  | "no_active_territories"
  /** The territory query itself failed — distinct from "nobody configured one". */
  | "territory_query_failed"

export interface ScrapeTerritoryResolution<M extends ScrapeTerritoryLike = ScrapeTerritoryLike> {
  /** Active-subscriber-owned, is_active territories — the ONLY areas any scraper may scrape. */
  territories: M[]
  /** Brokerages with a live (active/trialing) subscription. */
  activeBrokerageIds: string[]
  /** true → scrapers must not scrape at all this run. */
  noOp: boolean
  /** Honest stated reason ("ok" when territories exist). */
  reason: ScrapeNoOpReason
  /** Present only when reason is "territory_query_failed". */
  error?: string
}

/**
 * PURE resolver — the testable core. Takes the raw subscription rows and the
 * ACTIVE (is_active=true) territory rows, returns only territories owned by an
 * active-subscription tenant. No territories → honest no-op with the reason.
 */
export function resolveScrapeTerritoriesFrom<M extends ScrapeTerritoryLike>(
  subscriptions: Array<{ brokerage_id: string | null; status: string | null }>,
  activeMarkets: M[],
): ScrapeTerritoryResolution<M> {
  const activeIds = activeSubscriberBrokerageIds(subscriptions)
  if (activeIds.size === 0) {
    return { territories: [], activeBrokerageIds: [], noOp: true, reason: "no_active_subscribers" }
  }
  const territories = activeMarkets.filter(
    (m) => !!m.brokerage_id && activeIds.has(m.brokerage_id),
  )
  if (territories.length === 0) {
    return { territories: [], activeBrokerageIds: [...activeIds], noOp: true, reason: "no_active_territories" }
  }
  return { territories, activeBrokerageIds: [...activeIds], noOp: false, reason: "ok" }
}

/** Pure: the union of areas across resolved territories (deduped). Useful for
 *  diagnostics + tests; scrapers themselves iterate per-territory so budget,
 *  params, and brokerage ownership stay attached to each area. */
export function territoryUnion(territories: ScrapeTerritoryLike[]): {
  cities: string[]
  states: string[]
  zipCodes: string[]
  counties: string[]
} {
  const cities = new Set<string>()
  const states = new Set<string>()
  const zips = new Set<string>()
  const counties = new Set<string>()
  for (const t of territories) {
    if (t.city?.trim()) cities.add(t.city.trim().toLowerCase())
    if (t.state?.trim()) states.add(t.state.trim().toUpperCase())
    for (const z of t.zip_codes ?? []) if (z?.trim()) zips.add(z.trim())
    for (const c of t.counties ?? []) if (c?.trim()) counties.add(c.trim().toLowerCase())
  }
  return { cities: [...cities], states: [...states], zipCodes: [...zips], counties: [...counties] }
}

// The exact select the scraping cron needs — kept here so the work-list shape
// is owned by the resolver, not re-declared per scraper.
export const SCRAPE_TERRITORY_SELECT = `
  id, brokerage_id, team_id, agent_id, territory_scope, name, city, state,
  zip_codes, counties, enabled_sources, monthly_budget_usd, spend_this_month,
  max_records_per_run, priority, last_scraped_at,
  lead_scraping_property_params (id, min_price, max_price, min_beds, max_beds,
    property_types, days_on_market_min),
  lead_scraping_motivated_params (id, is_active, signal_types, lookback_days,
    facebook_group_urls, reddit_subreddits)
`

/**
 * DB resolver — loads live subscriptions + active territories and runs the pure
 * resolver. Accepts any supabase client (SSR or service).
 */
export async function resolveActiveScrapeTerritories(
  supabase: { from: (table: string) => any },
): Promise<ScrapeTerritoryResolution<any>> {
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("brokerage_id, status")

  const activeIds = activeSubscriberBrokerageIds((subs ?? []) as Array<{ brokerage_id: string | null; status: string | null }>)
  if (activeIds.size === 0) {
    return { territories: [], activeBrokerageIds: [], noOp: true, reason: "no_active_subscribers" }
  }

  const { data: markets, error: marketsError } = await supabase
    .from("lead_scraping_markets")
    .select(SCRAPE_TERRITORY_SELECT)
    .eq("is_active", true)
    .in("brokerage_id", [...activeIds])
    .order("priority", { ascending: false })

  // A failed select is NOT an empty market list. This error was previously discarded,
  // and PostgREST rejects the WHOLE query when an embedded select names a column the
  // embedded table lacks — which it did: lead_scraping_property_params has neither
  // `is_active` nor `target_sites`. Every scrape run therefore resolved zero
  // territories and reported "no_active_territories", which reads as "nobody has set
  // one up" rather than "this query cannot succeed". Surfacing it as its own reason
  // means a broken select can never again look like an idle pipeline.
  if (marketsError) {
    return {
      territories: [],
      activeBrokerageIds: [...activeIds],
      noOp: true,
      reason: "territory_query_failed",
      error: marketsError.message,
    }
  }

  return resolveScrapeTerritoriesFrom(
    (subs ?? []) as Array<{ brokerage_id: string | null; status: string | null }>,
    (markets ?? []) as any[],
  )
}
