"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Circle, Clock } from "lucide-react"

interface Milestone {
  id: string
  milestone_name: string
  status: string
  milestone_date: string | null
  completed_at: string | null
}

const MILESTONE_LABELS: Record<string, string> = {
  earnest_money_due: "Earnest Money Due",
  inspection_deadline: "Inspection Deadline",
  inspection_completed: "Inspection Completed",
  financing_deadline: "Financing Deadline",
  clear_to_close_received: "Clear to Close",
  final_walkthrough_scheduled: "Final Walkthrough",
  closing_date: "Closing Date"
}

export function ClientMilestones({ milestones }: { milestones: Milestone[] }) {
  const getIcon = (status: string) => {
    if (status === 'completed') return <CheckCircle2 className="h-5 w-5 text-green-600" />
    if (status === 'overdue') return <Clock className="h-5 w-5 text-red-600" />
    return <Circle className="h-5 w-5 text-muted-foreground" />
  }

  const getStatusBadge = (status: string) => {
    if (status === 'completed') return <Badge variant="outline" className="bg-green-50">Completed</Badge>
    if (status === 'overdue') return <Badge variant="destructive">Overdue</Badge>
    return <Badge variant="outline">Pending</Badge>
  }

  const formatDate = (date: string | null) => {
    if (!date) return 'TBD'
    return new Date(date).toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    })
  }

  // Highlight earnest money as critical
  const earnestMoney = milestones.find(m => m.milestone_name === 'earnest_money_due')

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Timeline & Key Dates</h2>

      {earnestMoney && (
        <Card className="p-4 border-2 border-orange-200 bg-orange-50">
          <div className="flex items-start gap-3">
            {getIcon(earnestMoney.status)}
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  {MILESTONE_LABELS[earnestMoney.milestone_name]}
                </h3>
                {getStatusBadge(earnestMoney.status)}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Due: {formatDate(earnestMoney.milestone_date)}
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-3">
        {milestones
          .filter(m => m.milestone_name !== 'earnest_money_due')
          .map(milestone => (
            <Card key={milestone.id} className="p-4">
              <div className="flex items-start gap-3">
                {getIcon(milestone.status)}
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">
                      {MILESTONE_LABELS[milestone.milestone_name] || milestone.milestone_name}
                    </h3>
                    {getStatusBadge(milestone.status)}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {milestone.completed_at 
                      ? `Completed ${formatDate(milestone.completed_at)}`
                      : milestone.milestone_date 
                        ? `Due ${formatDate(milestone.milestone_date)}`
                        : 'Date TBD'
                    }
                  </p>
                </div>
              </div>
            </Card>
          ))}
      </div>
    </div>
  )
}
