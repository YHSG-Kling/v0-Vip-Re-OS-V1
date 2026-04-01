"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileUp,
  MessageSquare,
  Calendar,
  ChevronRight,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

interface NextAction {
  id: string
  type: "upload_document" | "confirm_milestone" | "respond_request" | "review_file" | "update_status"
  title: string
  description?: string
  dueDate?: string
  priority: "high" | "medium" | "low"
  relatedFileId?: string
  relatedFileName?: string
}

interface ExternalNextActionsPanelProps {
  partnerType: "vendor" | "lender" | "title"
  partnerId: string
  actions: NextAction[]
  onCompleteAction: (actionId: string) => Promise<{ success: boolean; error?: string }>
}

export function ExternalNextActionsPanel({
  partnerType,
  partnerId,
  actions,
  onCompleteAction,
}: ExternalNextActionsPanelProps) {
  const [completingId, setCompletingId] = useState<string | null>(null)

  const getActionIcon = (type: NextAction["type"]) => {
    switch (type) {
      case "upload_document":
        return <FileUp className="h-4 w-4" />
      case "confirm_milestone":
        return <CheckCircle2 className="h-4 w-4" />
      case "respond_request":
        return <MessageSquare className="h-4 w-4" />
      case "review_file":
        return <FileUp className="h-4 w-4" />
      case "update_status":
        return <Clock className="h-4 w-4" />
      default:
        return <CheckCircle2 className="h-4 w-4" />
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "bg-red-100 text-red-700 border-red-200"
      case "medium":
        return "bg-orange-100 text-orange-700 border-orange-200"
      default:
        return "bg-gray-100 text-gray-700 border-gray-200"
    }
  }

  const getActionPriority = (action: NextAction): number => {
    // Partner-specific action prioritization per Kernel OS contract
    const priorityMap: Record<typeof partnerType, Record<NextAction['type'], number>> = {
      vendor: {
        upload_document: 1,
        update_status: 2,
        confirm_milestone: 3,
        respond_request: 4,
        review_file: 5,
      },
      lender: {
        confirm_milestone: 1,
        upload_document: 2,
        review_file: 3,
        update_status: 4,
        respond_request: 5,
      },
      title: {
        confirm_milestone: 1,
        upload_document: 2,
        respond_request: 3,
        review_file: 4,
        update_status: 5,
      },
    }
    return priorityMap[partnerType][action.type] || 99
  }

  // Sort actions by partner-specific priority
  const sortedActions = [...actions].sort((a, b) => {
    const priorityA = getActionPriority(a)
    const priorityB = getActionPriority(b)
    if (priorityA !== priorityB) return priorityA - priorityB
    return a.priority === "high" ? -1 : 1
  })

  const handleAction = async (action: NextAction) => {
    if (!onCompleteAction) {
      toast.error("This action is not available at this time.")
      return
    }

    setCompletingId(action.id)
    try {
      const result = await onCompleteAction(action.id)
      if (result.success) {
        toast.success("Action completed")
      } else {
        toast.error(result.error || "Failed to complete action")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setCompletingId(null)
    }
  }

  const highPriorityCount = actions.filter((a) => a.priority === "high").length

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Next Actions ({actions.length})
          </CardTitle>
          {highPriorityCount > 0 && (
            <Badge variant="destructive" className="text-xs">
              {highPriorityCount} Urgent
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {actions.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-50 text-green-500" />
            <p className="text-sm">All caught up!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedActions.slice(0, 5).map((action) => (
              <div
                key={action.id}
                className="p-3 bg-muted/50 rounded-lg border-l-4"
                style={{
                  borderLeftColor:
                    action.priority === "high"
                      ? "#ef4444"
                      : action.priority === "medium"
                        ? "#f97316"
                        : "#6b7280",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{getActionIcon(action.type)}</span>
                      <p className="text-sm font-medium">{action.title}</p>
                    </div>
                    {action.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                        {action.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <Badge className={`text-[10px] ${getPriorityColor(action.priority)}`}>
                        {action.priority}
                      </Badge>
                      {action.dueDate && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(action.dueDate).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-8"
                    onClick={() => handleAction(action)}
                    disabled={completingId === action.id}
                  >
                    {completingId === action.id ? "..." : "Complete"}
                  </Button>
                </div>
              </div>
            ))}
            {sortedActions.length > 5 && (
              <Button variant="ghost" size="sm" className="w-full mt-2">
                View All {sortedActions.length} Actions
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
