import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { MarketInsightsDashboardClient } from "./market-insights-client"
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
    <MarketInsightsDashboardClient
      brokerageId={brokerageId}
      agentId={agentId}
      sources={sources}
      initialMarketArea={initialMarketArea}
      initialInsight={initialInsight}
      initialMarketData={initialMarketData}
      initialTrends={initialTrends}
      initialCMAReports={initialCMAReports}
    />
  )
}
