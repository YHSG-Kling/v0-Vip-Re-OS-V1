"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Circle, ArrowRight, MapPin, AlertTriangle, Calendar } from "lucide-react"
import { bulkUpdateMilestones } from "@/app/actions/multi-persona"
import { useState, useTransition, useMemo } from "react"

interface Milestone {
  id: string
  milestone_name: string
  status: string
  milestone_date: string
  transaction_id: string
  transactions?: {
    property_address: string
  }
}

interface GroupedMilestones {
  transactionId: string
  propertyAddress: string
  milestones: Milestone[]
  hasOverdue: boolean
}

export function MilestoneQueue({ milestones }: { milestones: Milestone[] }) {
  const [isPending, startTransition] = useTransition()
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())

  // Group milestones by transaction
  const groupedByTransaction = useMemo(() => {
    const groups = new Map<string, GroupedMilestones>()
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    milestones.forEach((milestone) => {
      const txnId = milestone.transaction_id
      const existing = groups.get(txnId)
      const isOverdue = milestone.milestone_date ? new Date(milestone.milestone_date) < today : false

      if (existing) {
        existing.milestones.push(milestone)
        if (isOverdue) existing.hasOverdue = true
      } else {
        groups.set(txnId, {
          transactionId: txnId,
          propertyAddress: milestone.transactions?.property_address || "Unknown Property",
          milestones: [milestone],
          hasOverdue: isOverdue,
        })
      }
    })

    // Sort by overdue first, then by number of milestones
    return Array.from(groups.values()).sort((a, b) => {
      if (a.hasOverdue && !b.hasOverdue) return -1
      if (!a.hasOverdue && b.hasOverdue) return 1
      return b.milestones.length - a.milestones.length
    })
  }, [milestones])

  const handleComplete = (milestoneId: string) => {
    startTransition(async () => {
      await bulkUpdateMilestones([{ milestoneId, status: "completed" }])
      setCompletedIds((prev) => new Set([...prev, milestoneId]))
    })
  }

  const handleCompleteAll = (milestoneIds: string[]) => {
    startTransition(async () => {
      await bulkUpdateMilestones(milestoneIds.map((id) => ({ milestoneId: id, status: "completed" })))
      setCompletedIds((prev) => new Set([...prev, ...milestoneIds]))
    })
  }

  const getStatusIcon = (status: string, id: string) => {
    if (completedIds.has(id) || status === "completed") {
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    }
    if (status === "in_progress") {
      return <ArrowRight className="h-4 w-4 text-blue-600" />
    }
    return <Circle className="h-4 w-4 text-muted-foreground" />
  }

  const formatMilestoneName = (name: string) => {
    if (!name) return "Milestone"
    return name.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
  }

  const isOverdue = (dateStr: string) => {
    if (!dateStr) return false
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return new Date(dateStr) < today
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="h-5 w-5 text-blue-600" />
          Milestone Queue
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {groupedByTransaction.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
            <p>All milestones complete</p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto divide-y">
            {groupedByTransaction.map((group) => {
              const pendingMilestones = group.milestones.filter(
                (m) => !completedIds.has(m.id) && m.status !== "completed"
              )

              if (pendingMilestones.length === 0) return null

              return (
                <div key={group.transactionId} className="p-3">
                  {/* Transaction Header */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm font-medium truncate">{group.propertyAddress}</span>
                      {group.hasOverdue && (
                        <Badge variant="destructive" className="text-xs">
                          Overdue
                        </Badge>
                      )}
                    </div>
                    {pendingMilestones.length > 1 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCompleteAll(pendingMilestones.map((m) => m.id))}
                        disabled={isPending}
                        className="text-xs h-6 px-2"
                      >
                        Complete All
                      </Button>
                    )}
                  </div>

                  {/* Milestones */}
                  <div className="space-y-1 pl-5">
                    {pendingMilestones.map((milestone) => {
                      const overdue = isOverdue(milestone.milestone_date)
                      return (
                        <div key={milestone.id} className="flex items-center gap-2 py-1">
                          {getStatusIcon(milestone.status, milestone.id)}
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm truncate ${overdue ? "text-red-600" : ""}`}>
                              {formatMilestoneName(milestone.milestone_name)}
                            </p>
                          </div>
                          {milestone.milestone_date && (
                            <span
                              className={`text-xs flex items-center gap-1 ${overdue ? "text-red-600" : "text-muted-foreground"}`}
                            >
                              <Calendar className="h-3 w-3" />
                              {new Date(milestone.milestone_date).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          )}
                          {!completedIds.has(milestone.id) && milestone.status !== "completed" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleComplete(milestone.id)}
                              disabled={isPending}
                              className="text-xs h-6 px-2"
                            >
                              Done
                            </Button>
                          )}
                          {completedIds.has(milestone.id) && (
                            <Badge variant="outline" className="text-emerald-600 border-emerald-300 text-xs">
                              Done
                            </Badge>
                          )}
                        </div>
                      )
                    })}
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
