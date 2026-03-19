"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertTriangle,
  TrendingUp,
  DollarSign,
  FileText,
  ChevronRight,
  Clock,
  CheckCircle2,
} from "lucide-react"
import Link from "next/link"

export type FinancialPriority = {
  id: string
  title: string
  description: string
  urgency: "critical" | "high" | "medium" | "low"
  metric?: string
  metricLabel?: string
  ctaLabel: string
  ctaHref?: string
  ctaAction?: () => void
}

interface FinancialCommandStripProps {
  priority: FinancialPriority | null
  periodSummary?: {
    mtdRevenue?: number
    ytdRevenue?: number
    pendingCommissions?: number
    expensesMTD?: number
  }
  role: "agent" | "team_lead" | "broker" | "admin"
}

export function FinancialCommandStrip({
  priority,
  periodSummary,
  role,
}: FinancialCommandStripProps) {
  const urgencyColors = {
    critical: "bg-red-50 border-red-200 text-red-800",
    high: "bg-amber-50 border-amber-200 text-amber-800",
    medium: "bg-blue-50 border-blue-200 text-blue-800",
    low: "bg-green-50 border-green-200 text-green-800",
  }

  const urgencyIcons = {
    critical: <AlertTriangle className="h-5 w-5 text-red-600" />,
    high: <Clock className="h-5 w-5 text-amber-600" />,
    medium: <TrendingUp className="h-5 w-5 text-blue-600" />,
    low: <CheckCircle2 className="h-5 w-5 text-green-600" />,
  }

  const formatCurrency = (val?: number) =>
    val != null
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(val)
      : "$0"

  return (
    <Card className="border-2 border-violet-200 bg-gradient-to-r from-violet-50 to-white">
      <CardContent className="p-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Priority Alert Section */}
          {priority ? (
            <div className="flex items-start gap-3 flex-1">
              <div
                className={`p-2 rounded-lg border ${urgencyColors[priority.urgency]}`}
              >
                {urgencyIcons[priority.urgency]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-foreground truncate">
                    {priority.title}
                  </h3>
                  <Badge
                    variant="outline"
                    className={`text-xs ${
                      priority.urgency === "critical"
                        ? "border-red-300 text-red-700"
                        : priority.urgency === "high"
                          ? "border-amber-300 text-amber-700"
                          : "border-blue-300 text-blue-700"
                    }`}
                  >
                    {priority.urgency}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-1">
                  {priority.description}
                </p>
                {priority.metric && (
                  <div className="mt-1">
                    <span className="text-lg font-bold text-violet-700">
                      {priority.metric}
                    </span>
                    {priority.metricLabel && (
                      <span className="text-xs text-muted-foreground ml-1">
                        {priority.metricLabel}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {priority.ctaHref ? (
                <Link href={priority.ctaHref}>
                  <Button size="sm" className="bg-violet-600 hover:bg-violet-700 whitespace-nowrap">
                    {priority.ctaLabel}
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </Link>
              ) : priority.ctaAction ? (
                <Button
                  size="sm"
                  onClick={priority.ctaAction}
                  className="bg-violet-600 hover:bg-violet-700 whitespace-nowrap"
                >
                  {priority.ctaLabel}
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-1">
              <div className="p-2 rounded-lg border bg-green-50 border-green-200">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">
                  Financials On Track
                </h3>
                <p className="text-sm text-muted-foreground">
                  No urgent financial items requiring attention
                </p>
              </div>
            </div>
          )}

          {/* Period Summary Metrics */}
          {periodSummary && (
            <div className="flex items-center gap-4 border-l pl-4 border-violet-200">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">MTD Revenue</p>
                <p className="text-sm font-semibold text-green-600">
                  {formatCurrency(periodSummary.mtdRevenue)}
                </p>
              </div>
              {role !== "agent" && (
                <div className="text-center">
                  <p className="text-xs text-muted-foreground">Pending</p>
                  <p className="text-sm font-semibold text-amber-600">
                    {formatCurrency(periodSummary.pendingCommissions)}
                  </p>
                </div>
              )}
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Expenses MTD</p>
                <p className="text-sm font-semibold text-red-600">
                  {formatCurrency(periodSummary.expensesMTD)}
                </p>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
