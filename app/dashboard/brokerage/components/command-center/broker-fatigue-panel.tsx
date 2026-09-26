"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import {
  Heart,
  ArrowRight,
  User,
} from "lucide-react"

interface FatigueBuyer {
  id: string
  contactId: string
  firstName: string
  lastName: string
  fatigueScore: number
  status: "critical" | "warning" | "watch"
  agentName?: string
  daysSearching?: number
}

interface BrokerFatiguePanelProps {
  buyers: FatigueBuyer[]
  alertCount: number
  summary: {
    critical: number
    warning: number
    watch: number
  }
}

export function BrokerFatiguePanel({ buyers, alertCount, summary }: BrokerFatiguePanelProps) {
  const statusStyles = {
    critical: {
      badge: "destructive" as const,
      bg: "bg-red-500/10",
      border: "border-red-500/30",
      text: "text-red-600",
      progress: "bg-red-500",
    },
    warning: {
      badge: "secondary" as const,
      bg: "bg-orange-500/10",
      border: "border-orange-500/30",
      text: "text-orange-600",
      progress: "bg-orange-500",
    },
    watch: {
      badge: "secondary" as const,
      bg: "bg-yellow-500/10",
      border: "border-yellow-500/30",
      text: "text-yellow-600",
      progress: "bg-yellow-500",
    },
  }

  // Show top 5 highest fatigue buyers
  const topBuyers = buyers.slice(0, 5)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Heart className="h-4 w-4" />
            Buyer Fatigue
          </CardTitle>
          <div className="flex items-center gap-2">
            {alertCount > 0 && (
              <Badge variant="destructive" className="text-xs">
                {alertCount} Alert{alertCount !== 1 ? "s" : ""}
              </Badge>
            )}
            <Link href="/dashboard/brokerage/fatigue">
              <Button variant="ghost" size="sm" className="text-xs">
                View All
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-2 p-3 bg-muted/50 rounded-lg text-center">
          <div>
            <div className="text-lg font-bold text-red-600">{summary.critical}</div>
            <div className="text-xs text-muted-foreground">Critical</div>
          </div>
          <div>
            <div className="text-lg font-bold text-orange-600">{summary.warning}</div>
            <div className="text-xs text-muted-foreground">Warning</div>
          </div>
          <div>
            <div className="text-lg font-bold text-yellow-600">{summary.watch}</div>
            <div className="text-xs text-muted-foreground">Watch</div>
          </div>
        </div>

        {/* Buyer List */}
        {topBuyers.length === 0 ? (
          <div className="text-center py-6">
            <Heart className="h-8 w-8 mx-auto mb-2 text-green-600" />
            <p className="text-sm text-muted-foreground">No elevated fatigue detected</p>
          </div>
        ) : (
          topBuyers.map((buyer) => {
            const styles = statusStyles[buyer.status]
            return (
              <div
                key={buyer.id}
                className={`p-3 rounded-lg border ${styles.bg} ${styles.border}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <User className={`h-4 w-4 ${styles.text}`} />
                    <span className="font-medium text-sm">
                      {buyer.firstName} {buyer.lastName}
                    </span>
                    {buyer.agentName && (
                      <span className="text-xs text-muted-foreground">({buyer.agentName})</span>
                    )}
                  </div>
                  <Badge variant={styles.badge} className="text-xs">
                    {buyer.fatigueScore}
                  </Badge>
                </div>
                <Progress
                  value={buyer.fatigueScore}
                  className="h-1.5"
                />
                {buyer.daysSearching && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Searching for {buyer.daysSearching} days
                  </div>
                )}
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
