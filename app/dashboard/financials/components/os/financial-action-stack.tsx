"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Zap,
  DollarSign,
  Receipt,
  FileText,
  AlertTriangle,
  Clock,
  CheckCircle2,
  ChevronRight,
  TrendingUp,
  Wallet,
} from "lucide-react"
import Link from "next/link"
import { byPriorityDesc } from "@/lib/kernel/priority-rank"

export interface FinancialAction {
  id: string
  title: string
  description: string
  priority: "urgent" | "high" | "medium" | "low"
  type: "commission" | "expense" | "payout" | "report" | "budget" | "review"
  href?: string
  onClick?: () => void
  value?: number
  dueDate?: string
  isOverdue?: boolean
}

interface FinancialActionStackProps {
  actions: FinancialAction[]
  maxVisible?: number
  onViewAll?: () => void
}

export function FinancialActionStack({
  actions,
  maxVisible = 5,
  onViewAll,
}: FinancialActionStackProps) {
  const formatCurrency = (val?: number) =>
    val != null
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(val)
      : null

  const priorityColors = {
    urgent: "border-red-200 bg-red-50",
    high: "border-amber-200 bg-amber-50",
    medium: "border-blue-200 bg-blue-50",
    low: "border-gray-200 bg-gray-50",
  }

  const priorityBadgeColors = {
    urgent: "border-red-300 text-red-700 bg-red-100",
    high: "border-amber-300 text-amber-700 bg-amber-100",
    medium: "border-blue-300 text-blue-700 bg-blue-100",
    low: "border-gray-300 text-gray-700 bg-gray-100",
  }

  const typeIcons = {
    commission: <DollarSign className="h-4 w-4" />,
    expense: <Receipt className="h-4 w-4" />,
    payout: <Wallet className="h-4 w-4" />,
    report: <FileText className="h-4 w-4" />,
    budget: <TrendingUp className="h-4 w-4" />,
    review: <CheckCircle2 className="h-4 w-4" />,
  }

  const typeColors = {
    commission: "text-green-600 bg-green-100",
    expense: "text-orange-600 bg-orange-100",
    payout: "text-purple-600 bg-purple-100",
    report: "text-blue-600 bg-blue-100",
    budget: "text-teal-600 bg-teal-100",
    review: "text-violet-600 bg-violet-100",
  }

  // Sort by overdue status, then priority. TOMBSTONE (§1.1, 2026-09-03): the
  // local `priorityOrder {urgent:0 … low:3}` that stood here was one of five
  // hand copies of the same map — survivor lib/kernel/priority-rank.ts:45,
  // comparator `byPriorityDesc` imported above.
  const sortedActions = [...actions].sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1
    if (!a.isOverdue && b.isOverdue) return 1
    return byPriorityDesc(a, b)
  })

  const visibleActions = sortedActions.slice(0, maxVisible)
  const hasMore = sortedActions.length > maxVisible

  return (
    <Card className="border-violet-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-violet-100">
              <Zap className="h-5 w-5 text-violet-700" />
            </div>
            <div>
              <CardTitle className="text-base">Financial Actions</CardTitle>
              <CardDescription>
                {actions.length} action{actions.length !== 1 ? "s" : ""} requiring attention
              </CardDescription>
            </div>
          </div>
          {actions.filter((a) => a.priority === "urgent" || a.isOverdue).length > 0 && (
            <Badge variant="destructive" className="text-xs">
              {actions.filter((a) => a.priority === "urgent" || a.isOverdue).length} Urgent
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {visibleActions.length > 0 ? (
          <>
            {visibleActions.map((action) => (
              <div
                key={action.id}
                className={`p-3 rounded-lg border ${priorityColors[action.priority]} transition-colors hover:shadow-sm`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className={`p-1.5 rounded ${typeColors[action.type]}`}>
                      {typeIcons[action.type]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm font-medium">{action.title}</h4>
                        {action.isOverdue && (
                          <Badge variant="destructive" className="text-xs">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Overdue
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className={`text-xs ${priorityBadgeColors[action.priority]}`}
                        >
                          {action.priority}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {action.description}
                      </p>
                      {(action.value || action.dueDate) && (
                        <div className="flex items-center gap-3 mt-1">
                          {action.value && (
                            <span className="text-sm font-semibold text-green-600">
                              {formatCurrency(action.value)}
                            </span>
                          )}
                          {action.dueDate && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Due: {new Date(action.dueDate).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {action.href ? (
                    <Link href={action.href}>
                      <Button variant="ghost" size="sm" className="shrink-0">
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </Link>
                  ) : action.onClick ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={action.onClick}
                      className="shrink-0"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}

            {hasMore && (
              <Button
                variant="outline"
                className="w-full mt-2"
                onClick={onViewAll}
              >
                View All ({sortedActions.length} actions)
              </Button>
            )}
          </>
        ) : (
          <div className="text-center py-6 text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <p className="text-sm">All caught up! No pending financial actions.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
