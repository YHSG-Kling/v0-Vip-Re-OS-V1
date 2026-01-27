"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Circle, ArrowRight } from "lucide-react"
import { bulkUpdateMilestones } from "@/app/actions/multi-persona"
import { useState, useTransition } from "react"

interface Milestone {
  id: string
  milestone_name: string
  status: string
  due_date: string
  transactions?: {
    property_address: string
  }
}

export function MilestoneQueue({ milestones }: { milestones: Milestone[] }) {
  const [isPending, startTransition] = useTransition()
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())

  const handleComplete = (milestoneId: string) => {
    startTransition(async () => {
      await bulkUpdateMilestones([{ milestoneId, status: "completed" }])
      setCompletedIds((prev) => new Set([...prev, milestoneId]))
    })
  }

  const getStatusIcon = (status: string, id: string) => {
    if (completedIds.has(id) || status === "completed") {
      return <CheckCircle2 className="h-4 w-4 text-green-600" />
    }
    if (status === "in_progress") {
      return <ArrowRight className="h-4 w-4 text-blue-600" />
    }
    return <Circle className="h-4 w-4 text-muted-foreground" />
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
        <div className="divide-y max-h-80 overflow-y-auto">
          {milestones.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-sm">All milestones complete</div>
          ) : (
            milestones.slice(0, 10).map((milestone) => (
              <div key={milestone.id} className="p-3 hover:bg-muted/50">
                <div className="flex items-start gap-3">
                  {getStatusIcon(milestone.status, milestone.id)}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{milestone.milestone_name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {milestone.transactions?.property_address}
                    </p>
                    {milestone.due_date && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Due: {new Date(milestone.due_date).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  {!completedIds.has(milestone.id) && milestone.status !== "completed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleComplete(milestone.id)}
                      disabled={isPending}
                      className="bg-transparent text-xs"
                    >
                      Done
                    </Button>
                  )}
                  {completedIds.has(milestone.id) && (
                    <Badge variant="outline" className="text-green-600 border-green-600">
                      Completed
                    </Badge>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
