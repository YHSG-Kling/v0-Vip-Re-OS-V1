"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Activity, CheckCircle, XCircle, AlertTriangle, Clock, FileCheck } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface AuditEvent {
  id: string
  activity_type: string
  description: string
  created_at: string
  metadata?: {
    check_type?: string
    previous_status?: string
    new_status?: string
    is_blocking?: boolean
  }
}

interface AuditFeedPanelProps {
  auditEvents: AuditEvent[]
}

export function AuditFeedPanel({ auditEvents }: AuditFeedPanelProps) {
  const getEventIcon = (event: AuditEvent) => {
    const status = event.metadata?.new_status
    const type = event.activity_type

    if (type === "compliance_batch_pass" || status === "pass" || status === "waived") {
      return <CheckCircle className="h-4 w-4 text-green-600" />
    }
    if (status === "fail") {
      return <XCircle className="h-4 w-4 text-destructive" />
    }
    if (status === "needs_review") {
      return <AlertTriangle className="h-4 w-4 text-orange-500" />
    }
    if (type === "compliance_checks_seeded") {
      return <FileCheck className="h-4 w-4 text-blue-500" />
    }
    return <Clock className="h-4 w-4 text-muted-foreground" />
  }

  const getEventBadge = (event: AuditEvent) => {
    const status = event.metadata?.new_status
    
    if (status === "pass") {
      return <Badge className="bg-green-500 text-white text-[10px]">Passed</Badge>
    }
    if (status === "waived") {
      return <Badge variant="outline" className="text-[10px]">Waived</Badge>
    }
    if (status === "fail") {
      return <Badge variant="destructive" className="text-[10px]">Failed</Badge>
    }
    if (status === "needs_review") {
      return <Badge className="bg-orange-500 text-white text-[10px]">Review</Badge>
    }
    return null
  }

  if (auditEvents.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5 text-muted-foreground" />
            Audit Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="rounded-full bg-muted p-3 mb-3">
              <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">No recent compliance activity</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-5 w-5 text-muted-foreground" />
          Audit Feed
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[300px] px-4 pb-4">
          <div className="space-y-1">
            {auditEvents.map((event, index) => (
              <div
                key={event.id}
                className={`flex items-start gap-3 py-3 ${index !== auditEvents.length - 1 ? "border-b" : ""}`}
              >
                <div className="mt-0.5">{getEventIcon(event)}</div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-foreground line-clamp-2">{event.description}</p>
                    {getEventBadge(event)}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                    </span>
                    {event.metadata?.is_blocking && (
                      <Badge variant="outline" className="text-[10px] px-1">Blocking</Badge>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
