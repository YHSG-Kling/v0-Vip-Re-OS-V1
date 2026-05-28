"use client"

/**
 * ListingRiskWidget — agent dashboard surface for the listing-health-scan cron.
 *
 * Mirrors DealRiskWidget. Surfaces active / coming-soon listings where
 * health-radar monitoring detected DOM/showings/feedback/price/activity
 * issues with the top 2 concerns + jump-to-listing-detail.
 */

import Link from "next/link"
import { Radio, AlertTriangle, AlertCircle, ArrowRight, Clock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { AgentListingRisk } from "@/app/actions/listing-risk-agent"

interface Props {
  atRisk: AgentListingRisk[]
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
    icon: <Radio className="h-4 w-4 text-amber-600" />,
  },
  healthy: {
    label: "Healthy",
    badge: "bg-green-500 text-white",
    icon: <Radio className="h-4 w-4 text-green-600" />,
  },
} as const

export function ListingRiskWidget({ atRisk }: Props) {
  if (atRisk.length === 0) return null

  return (
    <Card className="border-amber-200 dark:border-amber-900">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4 text-amber-500" />
            Listings at Risk
          </CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {atRisk.length} open
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Active listings the health radar flagged for DOM, showings, feedback,
          price-vs-comps, or activity. Click through to see recommended actions.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {atRisk.map((l) => {
          const style = RISK_STYLES[l.riskLevel]
          return (
            <Link
              key={l.listingId}
              href={`/dashboard/listings/${l.listingId}/lifecycle`}
              className="block"
            >
              <div className="flex items-start justify-between gap-3 p-3 border rounded-lg bg-card hover:bg-muted/40 transition">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  {style.icon}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {l.propertyAddress ?? "Listing"}
                      </span>
                      <Badge className={`text-[10px] ${style.badge}`}>{style.label}</Badge>
                      {l.scoreDelta != null && l.scoreDelta < 0 && (
                        <Badge variant="outline" className="text-[10px] text-red-600">
                          {l.scoreDelta} pts
                        </Badge>
                      )}
                      {l.openInterventions > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {l.openInterventions} action{l.openInterventions === 1 ? "" : "s"}
                        </Badge>
                      )}
                      {l.daysOnMarket != null && (
                        <Badge variant="outline" className="text-[10px]">
                          {l.daysOnMarket}d on market
                        </Badge>
                      )}
                    </div>
                    {(l.city || l.listPrice) && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {l.city}{l.state ? `, ${l.state}` : ""}
                        {l.listPrice ? ` · $${Number(l.listPrice).toLocaleString()}` : ""}
                      </p>
                    )}
                    {l.topConcerns.length > 0 && (
                      <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                        {l.topConcerns.slice(0, 2).map((c, idx) => (
                          <li key={idx} className="truncate">
                            • <span className="font-medium">{c.category.toLowerCase()}:</span> {c.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-1">
                      <Clock className="h-3 w-3" />
                      Score: {Math.round(l.healthScore)}/100
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
