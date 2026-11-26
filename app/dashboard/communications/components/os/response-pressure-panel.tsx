"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { 
  Clock, 
  AlertTriangle, 
  
  Mail, 
  MessageSquare,
  ArrowRight,
  Zap
} from "lucide-react"

interface PressureItem {
  id: string
  contactName: string
  channel: "email" | "sms" | "voicemail"
  subject?: string
  preview: string
  waitingHours: number
  urgency: "critical" | "high" | "medium" | "low"
  sentiment?: string
  contactId: string
  conversationId: string
}

interface ResponsePressurePanelProps {
  items: PressureItem[]
  onReply: (item: PressureItem) => void
  onGenerateResponse: (item: PressureItem) => void
  onMarkRead: (item: PressureItem) => void
}

export function ResponsePressurePanel({
  items,
  onReply,
  onGenerateResponse,
  onMarkRead,
}: ResponsePressurePanelProps) {
  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case "critical": return "destructive"
      case "high": return "default"
      case "medium": return "secondary"
      default: return "outline"
    }
  }

  const getChannelIcon = (channel: string) => {
    switch (channel) {
      case "email": return <Mail className="h-4 w-4" />
      case "sms": return <MessageSquare className="h-4 w-4" />
      default: return <Mail className="h-4 w-4" />
    }
  }

  const formatWaitTime = (hours: number) => {
    if (hours < 1) return "< 1h"
    if (hours < 24) return `${Math.round(hours)}h`
    return `${Math.round(hours / 24)}d`
  }

  const sortedItems = [...items].sort((a, b) => {
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 }
    return urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || b.waitingHours - a.waitingHours
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Response Pressure
            </CardTitle>
            <CardDescription>Messages awaiting your response</CardDescription>
          </div>
          {items.filter(i => i.urgency === "critical").length > 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              {items.filter(i => i.urgency === "critical").length} critical
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px]">
          <div className="space-y-3">
            {sortedItems.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>All caught up! No pending responses.</p>
              </div>
            ) : (
              sortedItems.map((item) => (
                <div
                  key={item.id}
                  className={`p-3 rounded-lg border ${
                    item.urgency === "critical" ? "border-destructive bg-destructive/5" :
                    item.urgency === "high" ? "border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20" :
                    "bg-muted/30"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getChannelIcon(item.channel)}
                        <span className="font-medium truncate">{item.contactName}</span>
                        <Badge variant={getUrgencyColor(item.urgency)} className="text-xs">
                          {item.urgency}
                        </Badge>
                      </div>
                      {item.subject && (
                        <p className="text-sm font-medium truncate">{item.subject}</p>
                      )}
                      <p className="text-sm text-muted-foreground truncate">{item.preview}</p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Waiting {formatWaitTime(item.waitingHours)}
                        {item.sentiment && (
                          <>
                            <span className="mx-1">|</span>
                            {item.sentiment}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button size="sm" onClick={() => onReply(item)}>
                        Reply
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        onClick={() => onGenerateResponse(item)}
                        className="gap-1"
                      >
                        <Zap className="h-3 w-3" />
                        AI Draft
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
