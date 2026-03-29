import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getSourcePerformance } from "@/app/actions/source-analytics"
import { SourceAnalyticsClient } from "./source-analytics-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Source Analytics | Dashboard",
  description: "Attribution and ROI reporting by acquisition source",
}

export default async function SourceAnalyticsPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin" || ctx.userType === "superadmin"

  // Initial data load — last 90 days, all source families
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  const initialResult = await getSourcePerformance({
    brokerageId: ctx.brokerageId,
    agentId: isBrokerOrAdmin ? undefined : ctx.userId,
    dateFrom: ninetyDaysAgo,
    sortBy: "volume",
  })

  return (
    <div className="flex flex-col min-h-full">
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Source Analytics</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Attribution, funnel performance, and ROI by acquisition source
            </p>
          </div>
        </div>
      </div>
      <SourceAnalyticsClient
        userId={ctx.userId}
        brokerageId={ctx.brokerageId}
        userType={ctx.userType}
        agentId={isBrokerOrAdmin ? null : ctx.agentId}
        initialSources={initialResult.sources}
        initialSummary={initialResult.summary}
      />
    </div>
  )
}
