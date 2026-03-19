"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Clock, AlertTriangle, CheckCircle2, Calendar } from "lucide-react"

interface Deadline {
  id: string
  title: string
  transaction_address: string
  due_date: string
  status: "upcoming" | "due_soon" | "overdue" | "completed"
}

interface DeadlineTrackingProps {
  deadlines?: Deadline[]
}

export function DeadlineTracking({ deadlines = [] }: DeadlineTrackingProps) {
  const getDeadlineIcon = (status: string) => {
    switch (status) {
      case "overdue":
        return <AlertTriangle className="w-4 h-4 text-red-500" />
      case "due_soon":
        return <Clock className="w-4 h-4 text-amber-500" />
      case "completed":
        return <CheckCircle2 className="w-4 h-4 text-emerald-500" />
      default:
        return <Calendar className="w-4 h-4 text-blue-500" />
    }
  }

  const getDeadlineBadge = (status: string) => {
    switch (status) {
      case "overdue":
        return <Badge variant="destructive">Overdue</Badge>
      case "due_soon":
        return <Badge variant="secondary" className="bg-amber-100 text-amber-800">Due Soon</Badge>
      case "completed":
        return <Badge variant="outline">Completed</Badge>
      default:
        return <Badge variant="outline">Upcoming</Badge>
    }
  }

  const getDaysUntil = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    
    if (diff < 0) return `${Math.abs(diff)} days overdue`
    if (diff === 0) return "Due today"
    if (diff === 1) return "Due tomorrow"
    return `${diff} days left`
  }

  if (deadlines.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Upcoming Deadlines</CardTitle>
          <CardDescription>Critical dates to track</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Calendar className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>No upcoming deadlines</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming Deadlines</CardTitle>
        <CardDescription>{deadlines.length} deadlines to track</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {deadlines.map((deadline) => (
            <div
              key={deadline.id}
              className="flex items-start gap-3 p-3 border rounded-lg"
            >
              <div className="mt-0.5">{getDeadlineIcon(deadline.status)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium truncate">{deadline.title}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {deadline.transaction_address}
                    </p>
                  </div>
                  {getDeadlineBadge(deadline.status)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {getDaysUntil(deadline.due_date)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
