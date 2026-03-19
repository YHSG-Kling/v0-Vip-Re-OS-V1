"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Circle, ArrowRight } from "lucide-react"

interface Milestone {
  id: string
  name: string
  transaction_address: string
  status: "pending" | "in_progress" | "completed"
  order: number
}

interface MilestoneQueueProps {
  milestones?: Milestone[]
  onComplete?: (id: string) => void
}

export function MilestoneQueue({ milestones = [], onComplete }: MilestoneQueueProps) {
  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="w-5 h-5 text-emerald-500" />
      case "in_progress":
        return <Circle className="w-5 h-5 text-blue-500 fill-blue-500/20" />
      default:
        return <Circle className="w-5 h-5 text-muted-foreground" />
    }
  }

  if (milestones.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Milestone Queue</CardTitle>
          <CardDescription>Next milestones to complete</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>No pending milestones</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Milestone Queue</CardTitle>
        <CardDescription>{milestones.filter(m => m.status !== "completed").length} milestones pending</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {milestones.map((milestone, index) => (
            <div
              key={milestone.id}
              className={`flex items-center gap-3 p-3 border rounded-lg ${
                milestone.status === "completed" ? "bg-muted/50" : ""
              }`}
            >
              {getStatusIcon(milestone.status)}
              <div className="flex-1 min-w-0">
                <p className={`font-medium ${milestone.status === "completed" ? "line-through text-muted-foreground" : ""}`}>
                  {milestone.name}
                </p>
                <p className="text-sm text-muted-foreground truncate">
                  {milestone.transaction_address}
                </p>
              </div>
              {milestone.status === "in_progress" && onComplete && (
                <Button size="sm" onClick={() => onComplete(milestone.id)}>
                  Complete <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              )}
              {milestone.status === "pending" && (
                <Badge variant="outline">Pending</Badge>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
