"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import {
  Zap,
  ChevronRight,
  DollarSign,
  Users,
  Activity,
  Target,
} from "lucide-react"

export interface BrokerAction {
  id: string
  title: string
  description: string
  priority: "urgent" | "high" | "medium" | "low"
  type: "deal" | "financial" | "people" | "execution" | "recruiting"
  href: string
  value?: number | string
}

interface BrokerActionStackProps {
  actions: BrokerAction[]
}

export function BrokerActionStack({ actions }: BrokerActionStackProps) {
  const priorityStyles = {
    urgent: {
      badge: "destructive" as const,
      bg: "bg-red-500/10 hover:bg-red-500/15",
      border: "border-red-500/30",
      icon: "text-red-500",
    },
    high: {
      badge: "destructive" as const,
      bg: "bg-orange-500/10 hover:bg-orange-500/15",
      border: "border-orange-500/30",
      icon: "text-orange-500",
    },
    medium: {
      badge: "secondary" as const,
      bg: "bg-yellow-500/5 hover:bg-yellow-500/10",
      border: "border-yellow-500/30",
      icon: "text-yellow-600",
    },
    low: {
      badge: "outline" as const,
      bg: "hover:bg-muted/50",
      border: "border-border",
      icon: "text-muted-foreground",
    },
  }

  const typeIcons = {
    deal: Activity,
    financial: DollarSign,
    people: Users,
    execution: Zap,
    recruiting: Target,
  }

  // Sort by priority
  const sortedActions = [...actions].sort((a, b) => {
    const order = { urgent: 0, high: 1, medium: 2, low: 3 }
    return order[a.priority] - order[b.priority]
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Action Stack
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sortedActions.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            No pending actions
          </div>
        ) : (
          sortedActions.map((action) => {
            const styles = priorityStyles[action.priority]
            const Icon = typeIcons[action.type]

            return (
              <Link
                key={action.id}
                href={action.href}
                className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${styles.bg} ${styles.border}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className={`h-4 w-4 shrink-0 ${styles.icon}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{action.title}</div>
                    <div className="text-xs text-muted-foreground truncate">{action.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {action.value && (
                    <span className="text-sm font-medium">
                      {typeof action.value === "number"
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                            maximumFractionDigits: 0,
                          }).format(action.value)
                        : action.value}
                    </span>
                  )}
                  <Badge variant={styles.badge} className="text-xs">
                    {action.priority}
                  </Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </Link>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
