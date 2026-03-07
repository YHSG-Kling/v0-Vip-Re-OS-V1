"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Clock, AlertTriangle, Calendar, CheckCircle2 } from "lucide-react"
import { useMemo } from "react"

interface Deadline {
  id: string
  deadline_type: string
  deadline_date: string
  status: string
  notes?: string
  transaction_id: string
  transactions?: {
    property_address: string
  }
}

type DeadlineGroup = "OVERDUE" | "TODAY" | "THIS_WEEK" | "NEXT_WEEK"

export function DeadlineTracking({ deadlines }: { deadlines: Deadline[] }) {
  const groupedDeadlines = useMemo(() => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
    const endOfThisWeek = new Date(today.getTime() + (7 - today.getDay()) * 24 * 60 * 60 * 1000)
    const endOfNextWeek = new Date(endOfThisWeek.getTime() + 7 * 24 * 60 * 60 * 1000)

    const groups: Record<DeadlineGroup, Deadline[]> = {
      OVERDUE: [],
      TODAY: [],
      THIS_WEEK: [],
      NEXT_WEEK: [],
    }

    deadlines.forEach((deadline) => {
      const deadlineDate = new Date(deadline.deadline_date)
      const deadlineDateOnly = new Date(
        deadlineDate.getFullYear(),
        deadlineDate.getMonth(),
        deadlineDate.getDate()
      )

      if (deadlineDateOnly < today) {
        groups.OVERDUE.push(deadline)
      } else if (deadlineDateOnly.getTime() === today.getTime()) {
        groups.TODAY.push(deadline)
      } else if (deadlineDateOnly < endOfThisWeek) {
        groups.THIS_WEEK.push(deadline)
      } else if (deadlineDateOnly < endOfNextWeek) {
        groups.NEXT_WEEK.push(deadline)
      }
    })

    return groups
  }, [deadlines])

  const getGroupLabel = (group: DeadlineGroup) => {
    switch (group) {
      case "OVERDUE":
        return { label: "Overdue", variant: "destructive" as const, icon: AlertTriangle }
      case "TODAY":
        return { label: "Today", variant: "default" as const, icon: Clock }
      case "THIS_WEEK":
        return { label: "This Week", variant: "secondary" as const, icon: Calendar }
      case "NEXT_WEEK":
        return { label: "Next Week", variant: "outline" as const, icon: Calendar }
    }
  }

  const formatDeadlineType = (type: string) => {
    if (!type) return "Deadline"
    return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }

  const hasAnyDeadlines = Object.values(groupedDeadlines).some((group) => group.length > 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-5 w-5 text-amber-600" />
          Upcoming Deadlines
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!hasAnyDeadlines ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
            <p>No upcoming deadlines</p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {(["OVERDUE", "TODAY", "THIS_WEEK", "NEXT_WEEK"] as DeadlineGroup[]).map((group) => {
              const items = groupedDeadlines[group]
              if (items.length === 0) return null

              const { label, variant, icon: Icon } = getGroupLabel(group)

              return (
                <div key={group}>
                  {/* Group Header */}
                  <div className="sticky top-0 px-4 py-2 bg-muted/80 backdrop-blur-sm border-b flex items-center gap-2">
                    <Icon className={`h-3.5 w-3.5 ${group === "OVERDUE" ? "text-red-500" : group === "TODAY" ? "text-amber-500" : "text-muted-foreground"}`} />
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {label}
                    </span>
                    <Badge variant={variant} className="text-xs ml-auto">
                      {items.length}
                    </Badge>
                  </div>

                  {/* Group Items */}
                  <div className="divide-y">
                    {items.map((deadline) => (
                      <div key={deadline.id} className="p-3 hover:bg-muted/50">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">
                              {formatDeadlineType(deadline.deadline_type)}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {deadline.transactions?.property_address || "Unknown property"}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className={`text-xs font-medium ${group === "OVERDUE" ? "text-red-600" : group === "TODAY" ? "text-amber-600" : "text-muted-foreground"}`}>
                              {formatDate(deadline.deadline_date)}
                            </p>
                          </div>
                        </div>
                        {deadline.notes && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{deadline.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
