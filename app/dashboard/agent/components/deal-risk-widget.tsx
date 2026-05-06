"use client"

/**
 * DealRiskWidget — agent dashboard surface for the deal-health-scan cron.
 * Surfaces transactions where the agent's deals have crossed into watch /
 * at_risk / critical risk levels with concise reasons + jump-to-detail.
 */

import Link from "next/link"
import { ShieldAlert, AlertTriangle, AlertCircle, ArrowRight, Clock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { AgentDealRisk } from "@/app/actions/deal-risk-agent"

interface Props {
  atRisk: AgentDealRisk[]
}

const RISK_STYLES = {
  critical: {
    label: "Critical",
    badge: "bg-red-500 text-white",
    icon: <AlertCircle className="h-4 w-4 text-red-600" />,
  },
  at_risk: {
    label: "At Risk",
    badge: "bg-orange-500 text-white",
    icon: <AlertTriangle className="h-4 w-4 text-orange-600" />,
  },
  watch: {
    label: "Watch",
    badge: "bg-amber-500 text-white",
    icon: <ShieldAlert className="h-4 w-4 text-amber-600" />,
  },
  healthy: {
    label: "Healthy",
    badge: "bg-green-500 text-white",
    icon: <ShieldAlert className="h-4 w-4 text-green-600" />,
  },
} as const

export function DealRiskWidget({ atRisk }: Props) {
  if (atRisk.length === 0) return null

  return (
    <Card className="border-orange-200 dark:border-orange-900">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-orange-500" />
            Transactions at Risk
          </CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {atRisk.length} open
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Active transactions where deal-health monitoring detected issues.
          Click through to see proactive interventions.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {atRisk.map((d) => {
          const style = RISK_STYLES[d.riskLevel]
          return (
            <Link
              key={d.transactionId}
              href={`/dashboard/transactions/${d.transactionId}`}
              className="block"
            >
              <div className="flex items-start justify-between gap-3 p-3 border rounded-lg bg-card hover:bg-muted/40 transition">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  {style.icon}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {d.propertyAddress ?? d.contactName ?? "Transaction"}
                      </span>
                      <Badge className={`text-[10px] ${style.badge}`}>{style.label}</Badge>
                      {d.scoreDelta != null && d.scoreDelta < 0 && (
                        <Badge variant="outline" className="text-[10px] text-red-600">
                          {d.scoreDelta} pts
                        </Badge>
                      )}
                      {d.openInterventions > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {d.openInterventions} action{d.openInterventions === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </div>
                    {d.contactName && d.propertyAddress && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {d.contactName}
                      </p>
                    )}
                    {d.topConcerns.length > 0 && (
                      <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                        {d.topConcerns.slice(0, 2).map((c, idx) => (
                          <li key={idx} className="truncate">
                            • <span className="font-medium">{c.category}:</span> {c.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-1">
                      <Clock className="h-3 w-3" />
                      Score: {Math.round(d.healthScore)}/100
                    </div>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
              </div>
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
