import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getSourceDrilldown } from "@/app/actions/source-analytics"
import { SourceDetailClient } from "./source-detail-client"
import type { SourceFamily } from "@/app/actions/source-analytics"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ sourceId: string }>
  searchParams: Promise<{ family?: string; dateFrom?: string; dateTo?: string }>
}

export default async function SourceDetailPage({ params, searchParams }: Props) {
  const [ctx, resolvedParams, resolvedSearch] = await Promise.all([
    getAgentContext(),
    params,
    searchParams,
  ])

  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const sourceName = decodeURIComponent(resolvedParams.sourceId)
  const family = (resolvedSearch.family ?? "contact_direct") as SourceFamily
  const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin" || ctx.userType === "superadmin"

  const result = await getSourceDrilldown(
    ctx.brokerageId,
    `${sourceName}::${family}`,
    isBrokerOrAdmin ? undefined : ctx.userId,
    resolvedSearch.dateFrom,
    resolvedSearch.dateTo
  )

  return (
    <div className="flex flex-col min-h-full">
      <div className="border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <a href="/dashboard/analytics/source" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Source Analytics
          </a>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-xl font-bold capitalize">{sourceName.replace(/_/g, " ")}</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5 capitalize">
          {family.replace("_", " ")} source — drill-down detail
        </p>
      </div>
      <SourceDetailClient
        sourceName={sourceName}
        sourceFamily={family}
        brokerageId={ctx.brokerageId}
        userId={ctx.userId}
        userType={ctx.userType}
        initialData={result}
      />
    </div>
  )
}
