import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { MarketInsightsDashboardClient } from "./market-insights-client"
import { MarketAlertsPanel } from "./components/market-alerts-panel"
import {
  getAgentMarketSources,
  getCurrentInsight,
  getCurrentMarketData,
  getTrendData,
  getRecentCMAReports,
} from "@/app/actions/market-insight-actions"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Market Insights | Dashboard",
  description: "AI-powered market analysis and insights",
}

export default async function MarketInsightsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { brokerageId, agentId } = await getAgentContext()

  // Load market sources
  const sources = await getAgentMarketSources()

  // TERRITORY MARKETPLACE prefill (round 40, rec 4): the zip the owner searched
  // on /pricing rode through /signup?zip= into billing_metadata.signup_intent.
  // Surface it here as the SUGGESTED first market (dialog prefill only — the
  // user still creates the market; nothing is auto-created). Service read
  // behind the auth guard above, same pattern as scrape-diagnostics.
  let suggestedZip: string | null = null
  if (brokerageId) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { loadCarriedTerritoryZip } = await import("@/lib/platform/territory-marketplace")
      suggestedZip = await loadCarriedTerritoryZip(createServiceClient(), brokerageId)
    } catch { /* suggestion only — never blocks the page */ }
  }

  // If there are sources, load data for the first one
  let initialInsight = null
  let initialMarketData = null
  let initialTrends: any[] = []
  let initialCMAReports: any[] = []
  let initialMarketArea = ""

  if (sources.length > 0) {
    initialMarketArea = sources[0].market_area
    const [insight, marketData, trends, cmaReports] = await Promise.all([
      getCurrentInsight(initialMarketArea),
      getCurrentMarketData(initialMarketArea),
      getTrendData(initialMarketArea),
      getRecentCMAReports(initialMarketArea),
    ])
    initialInsight = insight
    initialMarketData = marketData
    initialTrends = trends
    initialCMAReports = cmaReports
  }

  return (
    <>
      <MarketInsightsDashboardClient
        brokerageId={brokerageId ?? ""}
        agentId={agentId ?? ""}
        sources={sources}
        initialMarketArea={initialMarketArea}
        initialInsight={initialInsight}
        initialMarketData={initialMarketData}
        initialTrends={initialTrends}
        initialCMAReports={initialCMAReports}
        suggestedZip={suggestedZip}
      />
      {/* THE ALERT ENGINE, REACHABLE. getMarketAlerts read the agent's
          specializations against recent market_data and returned prioritised
          alerts — complete, gated, and called from nowhere. This is its
          surface. */}
      <div className="px-4 pb-6 md:px-6">
        <MarketAlertsPanel agentId={agentId ?? ""} />
      </div>
    </>
  )
}
