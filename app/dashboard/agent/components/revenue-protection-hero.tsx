"use client"

/**
 * <RevenueProtectionHero> — the headline "Your AI protected $X" card.
 *
 * Shows on the agent dashboard. Single dollar number, big and clear, plus
 * the supporting breakdown:
 *   - Saved GCI (this period) + count of saves
 *   - At-risk by severity (critical / at_risk / watch)
 *   - AI lift % vs no-AI baseline
 *   - "Refresh" button to trigger an on-demand rollup
 *
 * Hidden when there's no snapshot yet (the cron hasn't run for this
 * agent). Once it runs, the card lights up.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Loader2,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  rescanRevenueProtectionAction,
  type AgentRevenueProtection,
} from "@/app/actions/revenue-protection"

interface Props {
  data:        AgentRevenueProtection | null
  brokerageId: string
  agentUserId: string
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}

export function RevenueProtectionHero({ data, brokerageId, agentUserId }: Props) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const r = await rescanRevenueProtectionAction({ brokerageId, agentId: agentUserId })
      if (r.success) {
        toast.success("Revenue protection rescored")
        router.refresh()
      } else {
        toast.error(r.error ?? "Refresh failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed")
    } finally {
      setRefreshing(false)
    }
  }

  // First-run state: no snapshot yet → invite the agent to refresh
  if (!data) {
    return (
      <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50 to-white">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Revenue Protection Score
            </CardTitle>
            <Button size="sm" variant="outline" disabled={refreshing} onClick={handleRefresh} className="h-7 text-xs gap-1.5">
              {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Run first scan
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Your AI radars protect open pipeline. Once it scans, you&apos;ll see the dollars protected this quarter — and how many deals AI saved from falling apart.
          </p>
        </CardHeader>
      </Card>
    )
  }

  const trendArrow = data.protectedGciDelta != null && data.protectedGciDelta !== 0
    ? data.protectedGciDelta > 0
      ? { icon: <TrendingUp className="h-3 w-3" />, color: "text-emerald-700" }
      : { icon: <TrendingDown className="h-3 w-3" />, color: "text-red-700" }
    : null

  return (
    <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Revenue Protection Score
            <span className="text-[10px] uppercase font-medium text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full">
              {data.snapshotType}
            </span>
          </CardTitle>
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={handleRefresh} className="h-7 text-xs gap-1.5">
            {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Hero numbers — protected + saved side by side */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">AI is protecting</p>
            <div className="flex items-baseline gap-2 mt-0.5">
              <p className="text-3xl font-bold text-emerald-900 tabular-nums">{formatUsd(data.protectedGci)}</p>
              {trendArrow && data.protectedGciDelta != null && (
                <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", trendArrow.color)}>
                  {trendArrow.icon}
                  {data.protectedGciDelta > 0 ? "+" : ""}{Math.round(data.protectedGciDelta / 1000)}k
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {data.atRiskDealCount} deal{data.atRiskDealCount === 1 ? "" : "s"} · {data.atRiskListingCount} listing{data.atRiskListingCount === 1 ? "" : "s"}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">AI has saved this period</p>
            <div className="flex items-baseline gap-2 mt-0.5">
              <p className="text-3xl font-bold text-foreground tabular-nums">{formatUsd(data.savedGci)}</p>
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {data.savesCount} save{data.savesCount === 1 ? "" : "s"}
              {data.savesCount > 0 && <> · avg {formatUsd(data.avgSaveValue)}</>}
            </p>
          </div>
        </div>

        {/* Severity breakdown bar */}
        {data.protectedGci > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">Protected by severity</p>
            <div className="flex h-2 rounded-full overflow-hidden bg-muted">
              {data.atRiskBySeverity.critical > 0 && (
                <div
                  className="bg-red-500"
                  style={{ width: `${(data.atRiskBySeverity.critical / data.protectedGci) * 100}%` }}
                  title={`Critical: ${formatUsd(data.atRiskBySeverity.critical)}`}
                />
              )}
              {data.atRiskBySeverity.at_risk > 0 && (
                <div
                  className="bg-orange-500"
                  style={{ width: `${(data.atRiskBySeverity.at_risk / data.protectedGci) * 100}%` }}
                  title={`At risk: ${formatUsd(data.atRiskBySeverity.at_risk)}`}
                />
              )}
              {data.atRiskBySeverity.watch > 0 && (
                <div
                  className="bg-amber-400"
                  style={{ width: `${(data.atRiskBySeverity.watch / data.protectedGci) * 100}%` }}
                  title={`Watch: ${formatUsd(data.atRiskBySeverity.watch)}`}
                />
              )}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1" />Critical {formatUsd(data.atRiskBySeverity.critical)}</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-orange-500 mr-1" />At-risk {formatUsd(data.atRiskBySeverity.at_risk)}</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1" />Watch {formatUsd(data.atRiskBySeverity.watch)}</span>
            </div>
          </div>
        )}

        {/* AI lift line */}
        {data.aiLiftPct > 0 && (
          <p className="text-[11px] text-emerald-800 bg-emerald-50 rounded-md px-2 py-1.5 border border-emerald-100">
            <Sparkles className="h-3 w-3 inline mr-1 text-amber-500" />
            <strong>AI lift {data.aiLiftPct.toFixed(1)}%</strong> vs. industry no-AI baseline ({formatUsd(data.noAiBaselineGci)} expected without intervention).
          </p>
        )}

        {/* Period footer */}
        <p className="text-[10px] text-muted-foreground text-right">
          {new Date(data.periodStart).toLocaleDateString()} — {new Date(data.periodEnd).toLocaleDateString()}
        </p>
      </CardContent>
    </Card>
  )
}
