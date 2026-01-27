"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Clock, AlertTriangle, Calendar } from "lucide-react"

interface Deadline {
  id: string
  deadline_name: string
  due_date: string
  status: string
  priority: string
  transactions?: {
    property_address: string
  }
}

export function DeadlineTracking({ deadlines }: { deadlines: Deadline[] }) {
  const getDaysRemaining = (dueDate: string) => {
    return Math.floor((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  }

  const getPriorityColor = (priority: string, daysRemaining: number) => {
    if (daysRemaining <= 1) return "destructive"
    if (daysRemaining <= 3 || priority === "high") return "default"
    return "secondary"
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-5 w-5 text-orange-600" />
          Upcoming Deadlines
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y max-h-80 overflow-y-auto">
          {deadlines.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-sm">No upcoming deadlines</div>
          ) : (
            deadlines.slice(0, 10).map((deadline) => {
              const daysRemaining = getDaysRemaining(deadline.due_date)
              return (
                <div key={deadline.id} className="p-3 hover:bg-muted/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{deadline.deadline_name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {deadline.transactions?.property_address}
                      </p>
                    </div>
                    <Badge variant={getPriorityColor(deadline.priority, daysRemaining)}>
                      {daysRemaining <= 0 ? (
                        <span className="flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Overdue
                        </span>
                      ) : daysRemaining === 1 ? (
                        "Tomorrow"
                      ) : (
                        `${daysRemaining}d`
                      )}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    {new Date(deadline.due_date).toLocaleDateString()}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}
