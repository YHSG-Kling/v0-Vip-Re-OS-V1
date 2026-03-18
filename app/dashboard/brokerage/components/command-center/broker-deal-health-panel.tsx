"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  Clock,
} from "lucide-react"

interface DealHealthItem {
  id: string
  transactionId: string
  propertyAddress: string
  score: number
  riskLevel: "critical" | "at_risk" | "watch" | "healthy"
  aiNarrative?: string
  agentName?: string
  closeDate?: string
}

interface BrokerDealHealthPanelProps {
  deals: DealHealthItem[]
  summary: {
    critical: number
    at_risk: number
    watch: number
    healthy: number
    total: number
  }
}

export function BrokerDealHealthPanel({ deals, summary }: BrokerDealHealthPanelProps) {
  const riskStyles = {
    critical: {
      badge: "destructive" as const,
      bg: "bg-red-500/10",
      border: "border-red-500/30",
      text: "text-red-600",
    },
    at_risk: {
      badge: "destructive" as const,
      bg: "bg-orange-500/10",
      border: "border-orange-500/30",
      text: "text-orange-600",
    },
    watch: {
      badge: "secondary" as const,
      bg: "bg-yellow-500/10",
      border: "border-yellow-500/30",
      text: "text-yellow-600",
    },
    healthy: {
      badge: "outline" as const,
      bg: "bg-green-500/10",
      border: "border-green-500/30",
      text: "text-green-600",
    },
  }

  // Show only at-risk deals, limited to 5
  const atRiskDeals = deals
    .filter((d) => d.riskLevel !== "healthy")
    .slice(0, 5)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Deal Health
          </CardTitle>
          <div className="flex items-center gap-2">
            {summary.critical > 0 && (
              <Badge variant="destructive" className="text-xs">
                {summary.critical} Critical
              </Badge>
            )}
            {summary.at_risk > 0 && (
              <Badge variant="secondary" className="text-xs">
                {summary.at_risk} At Risk
              </Badge>
            )}
            <Link href="/dashboard/brokerage/deal-health">
              <Button variant="ghost" size="sm" className="text-xs">
                View All
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {atRiskDeals.length === 0 ? (
          <div className="text-center py-6">
            <Activity className="h-8 w-8 mx-auto mb-2 text-green-600" />
            <p className="text-sm text-muted-foreground">All deals are healthy</p>
            <p className="text-xs text-muted-foreground mt-1">{summary.total} active transactions</p>
          </div>
        ) : (
          atRiskDeals.map((deal) => {
            const styles = riskStyles[deal.riskLevel]
            return (
              <Link
                key={deal.id}
                href={`/dashboard/transactions/${deal.transactionId}`}
                className={`block p-3 rounded-lg border ${styles.bg} ${styles.border} hover:opacity-80 transition-opacity`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${styles.text}`} />
                      <span className="font-medium text-sm truncate">{deal.propertyAddress}</span>
                    </div>
                    {deal.aiNarrative && (
                      <p className="text-xs text-muted-foreground line-clamp-2 ml-5">
                        {deal.aiNarrative}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-2 ml-5 text-xs text-muted-foreground">
                      {deal.agentName && <span>{deal.agentName}</span>}
                      {deal.closeDate && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Closes {new Date(deal.closeDate).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-lg font-bold ${styles.text}`}>{deal.score}</div>
                    <Badge variant={styles.badge} className="text-xs">
                      {deal.riskLevel.replace("_", " ")}
                    </Badge>
                  </div>
                </div>
              </Link>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
