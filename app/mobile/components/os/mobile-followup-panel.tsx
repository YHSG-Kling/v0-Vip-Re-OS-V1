"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Clock, Phone, MessageSquare, CheckCircle, AlertCircle, User } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import { logActivity, completeActivity } from "@/app/actions/activities"

interface FollowupTask {
  id: string
  contact_id?: string
  title: string
  description?: string
  scheduled_at?: string
  due_date?: string
  priority?: string
  status: string
  contact?: {
    id: string
    first_name?: string
    last_name?: string
    phone?: string
  }
}

interface MobileFollowupPanelProps {
  tasks: FollowupTask[]
  onTaskComplete?: (taskId: string) => void
}

export function MobileFollowupPanel({ tasks, onTaskComplete }: MobileFollowupPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [noteContent, setNoteContent] = useState("")
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  const pendingTasks = tasks
    .filter((t) => t.status !== "completed")
    .sort((a, b) => {
      // Sort by priority first, then by due date
      const priorityOrder = { high: 0, medium: 1, low: 2 }
      const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] ?? 1
      const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] ?? 1
      if (aPriority !== bPriority) return aPriority - bPriority

      const aDate = a.due_date || a.scheduled_at || ""
      const bDate = b.due_date || b.scheduled_at || ""
      return aDate.localeCompare(bDate)
    })
    .slice(0, 5)

  const handleCompleteTask = (taskId: string) => {
    startTransition(async () => {
      // The note is the whole point of this sheet: it is what the agent heard
      // at the door, captured while it is freshest. It used to be dropped.
      const result = await completeActivity(taskId, noteContent)
      if (result.success) {
        toast.success("Follow-up completed")
        setNoteContent("")
        setActiveTaskId(null)
        onTaskComplete?.(taskId)
      } else {
        toast.error("Failed to complete follow-up")
      }
    })
  }

  const handleCall = (phone: string) => {
    window.location.href = `tel:${phone}`
  }

  const handleText = (phone: string) => {
    window.location.href = `sms:${phone}`
  }

  const getPriorityColor = (priority?: string) => {
    switch (priority) {
      case "high":
        return "bg-red-100 text-red-700 border-red-200"
      case "medium":
        return "bg-yellow-100 text-yellow-700 border-yellow-200"
      case "low":
        return "bg-green-100 text-green-700 border-green-200"
      default:
        return "bg-gray-100 text-gray-700 border-gray-200"
    }
  }

  const isOverdue = (task: FollowupTask) => {
    const dueDate = task.due_date || task.scheduled_at
    if (!dueDate) return false
    return new Date(dueDate) < new Date()
  }

  if (pendingTasks.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4 text-orange-500" />
            Follow-ups Due
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-4 text-center">
            <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
            <p className="text-sm text-muted-foreground">
              All caught up! No pending follow-ups.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4 text-orange-500" />
            Follow-ups Due
          </CardTitle>
          <Badge variant="secondary">{pendingTasks.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {pendingTasks.map((task) => {
          const contactName = task.contact
            ? `${task.contact.first_name || ""} ${task.contact.last_name || ""}`.trim()
            : null
          const dueDate = task.due_date || task.scheduled_at
          const overdue = isOverdue(task)

          return (
            <div
              key={task.id}
              className={`p-3 rounded-lg border ${
                overdue ? "bg-red-50 border-red-200" : "bg-muted/30"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {task.priority && (
                      <Badge
                        className={`text-[10px] px-1.5 ${getPriorityColor(task.priority)}`}
                      >
                        {task.priority}
                      </Badge>
                    )}
                    {overdue && (
                      <Badge variant="destructive" className="text-[10px] px-1.5">
                        <AlertCircle className="h-2 w-2 mr-0.5" />
                        Overdue
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium line-clamp-1">{task.title}</p>
                  {contactName && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <User className="h-3 w-3" />
                      {contactName}
                    </p>
                  )}
                  {dueDate && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Due {formatDistanceToNow(new Date(dueDate), { addSuffix: true })}
                    </p>
                  )}
                </div>
              </div>

              {/* Quick Actions */}
              <div className="flex gap-2 mt-2">
                {task.contact?.phone && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 h-8"
                      onClick={() => handleCall(task.contact!.phone!)}
                    >
                      <Phone className="h-3 w-3 mr-1" />
                      Call
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 h-8"
                      onClick={() => handleText(task.contact!.phone!)}
                    >
                      <MessageSquare className="h-3 w-3 mr-1" />
                      Text
                    </Button>
                  </>
                )}
                <Sheet>
                  <SheetTrigger asChild>
                    <Button
                      size="sm"
                      className="flex-1 h-8 bg-green-600 hover:bg-green-700"
                      onClick={() => setActiveTaskId(task.id)}
                    >
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Done
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="h-[280px]">
                    <SheetHeader>
                      <SheetTitle>Complete Follow-up</SheetTitle>
                    </SheetHeader>
                    <div className="mt-4 space-y-4">
                      <p className="text-sm text-muted-foreground">{task.title}</p>
                      <Textarea
                        placeholder="Add notes (optional)..."
                        value={noteContent}
                        onChange={(e) => setNoteContent(e.target.value)}
                        className="min-h-[80px]"
                      />
                      <Button
                        className="w-full"
                        onClick={() => handleCompleteTask(task.id)}
                        disabled={isPending}
                      >
                        {isPending ? "Completing..." : "Mark as Complete"}
                      </Button>
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
