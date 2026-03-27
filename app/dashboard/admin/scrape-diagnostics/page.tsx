import { createClient } from "@/lib/supabase/server"
import { ScrapeDiagnosticsClient } from "./scrape-diagnostics-client"

export const metadata = {
  title:       "Scrape Diagnostics | Kernel OS Admin",
  description: "Provider health, territory budgets, pipeline funnel, and dry-run preview for the lead scraping system",
}

/**
 * Admin Scrape Diagnostics Page — Kernel OS
 *
 * All data comes from real DB queries:
 *   - scraper_executions — recent runs per source
 *   - lead_scraping_markets — territory budgets
 *   - raw_scraped_leads — pipeline funnel grouped by source + status
 *
 * Zero mock data.
 */
export default async function ScrapeDiagnosticsPage() {
  const supabase = await createClient()

  // Fetch all three data sets in parallel
  const [marketsResult, executionsResult, funnelResult] = await Promise.all([
    supabase
      .from("lead_scraping_markets")
      .select("id, name, city, state, enabled_sources, monthly_budget_usd, spend_this_month, is_active, last_scraped_at")
      .order("priority", { ascending: false })
      .limit(50),

    supabase
      .from("scraper_executions")
      .select("id, scraper_type, status, started_at, completed_at, total_items_found, leads_created, api_cost, error_message")
      .order("started_at", { ascending: false })
      .limit(25),

    // Group raw_scraped_leads by source + processing_status using a select aggregation.
    // Supabase JS client doesn't support GROUP BY directly, so we fetch and aggregate client-side.
    supabase
      .from("raw_scraped_leads")
      .select("source, processing_status")
      .limit(10000),
  ])

  const markets    = marketsResult.data    ?? []
  const executions = executionsResult.data ?? []

  // Aggregate funnel rows in-process — no GROUP BY needed, just count
  const funnelMap: Record<string, Record<string, number>> = {}
  for (const row of funnelResult.data ?? []) {
    const src    = row.source            ?? "unknown"
    const status = row.processing_status ?? "unknown"
    if (!funnelMap[src])       funnelMap[src]         = {}
    if (!funnelMap[src][status]) funnelMap[src][status] = 0
    funnelMap[src][status]++
  }

  const funnel = Object.entries(funnelMap).flatMap(([source, statuses]) =>
    Object.entries(statuses).map(([processing_status, count]) => ({
      source,
      processing_status,
      count,
    }))
  )

  return (
    <ScrapeDiagnosticsClient
      data={{ markets, executions, funnel }}
    />
  )
}
