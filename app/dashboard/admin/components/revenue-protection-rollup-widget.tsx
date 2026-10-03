import Link from "next/link"
import { ShieldCheck, ArrowRight, TrendingUp, TrendingDown } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getBrokerageRevenueProtection } from "@/app/actions/revenue-protection"

/**
 * <RevenueProtectionRollupWidget> — broker landing rollup.
 *
 * Server component. Reads the latest brokerage-wide quarterly snapshot
 * from revenue_protection_snapshots plus the top 5 agents by protected
 * GCI. RLS gates by brokerage on the table.
 *
 * Surfaces the broker's marketing line: total $ AI is protecting across
 * the whole book of business + total $ saved this quarter.
 */
interface Props {
  brokerageId: string
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}

export async function RevenueProtectionRollupWidget({ brokerageId }: Props) {
  const res = await getBrokerageRevenueProtection({ brokerageId })
  if (!res.success || !res.data) return null

  const data = res.data
  const trendArrow = data.protectedGciDelta != null && data.protectedGciDelta !== 0
    ? data.protectedGciDelta > 0
      ? { icon: <TrendingUp className="h-3.5 w-3.5" />, color: "text-emerald-700" }
      : { icon: <TrendingDown className="h-3.5 w-3.5" />, color: "text-red-700" }
    : null

  return (
    <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Brokerage Revenue Protection
            <Badge variant="outline" className="text-[10px]">{data.snapshotType}</Badge>
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            {new Date(data.periodStart).toLocaleDateString()} — {new Date(data.periodEnd).toLocaleDateString()}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Hero grid */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Protected pipeline</p>
            <div className="flex items-baseline gap-2 mt-0.5">
              <p className="text-2xl font-bold text-emerald-900 tabular-nums">{formatUsd(data.protectedGci)}</p>
              {trendArrow && data.protectedGciDelta != null && (
                <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", trendArrow.color)}>
                  {trendArrow.icon}
                  {data.protectedGciDelta > 0 ? "+" : ""}{Math.round(data.protectedGciDelta / 1000)}k
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{data.atRiskDealCount} deals · {data.atRiskListingCount} listings</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Saved this period</p>
            <p className="text-2xl font-bold tabular-nums mt-0.5">{formatUsd(data.savedGci)}</p>
            <p className="text-xs text-muted-foreground">{data.savesCount} saves · avg {formatUsd(data.avgSaveValue)}</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">AI lift</p>
            <p className="text-2xl font-bold tabular-nums mt-0.5 text-emerald-700">{data.aiLiftPct.toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground">vs no-AI baseline</p>
          </div>
        </div>

        {/* Top agents */}
        {data.perAgent.length > 0 && (
          <div className="border-t pt-3">
            <p className="text-xs font-semibold text-foreground mb-2">Top agents by protected GCI</p>
            <ul className="space-y-1.5">
              {data.perAgent.slice(0, 5).map((a) => (
                <li key={a.agentId} className="flex items-center justify-between text-xs gap-3">
                  {/* REPOINTED (dangling-link sweep, 2026-09-02): was
                      `/dashboard/admin/agents/${id}` — app/dashboard/admin/agents is the
                      offboarding page with no [id] child. `agentId` is the users.id the
                      action resolves names from (revenue-protection.ts:139 `.from("users")
                      .in("id", agentIds)`), so the per-user admin page is the survivor. */}
                  <Link href={`/dashboard/admin/users/${a.agentId}`} className="flex-1 min-w-0 truncate hover:underline">
                    {a.agentName ?? "Unknown agent"}
                  </Link>
                  <span className="text-muted-foreground tabular-nums w-24 text-right">{formatUsd(a.protectedGci)}</span>
                  <span className="tabular-nums w-20 text-right text-emerald-700">
                    {a.savesCount > 0 ? `${a.savesCount} saves` : "—"}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
