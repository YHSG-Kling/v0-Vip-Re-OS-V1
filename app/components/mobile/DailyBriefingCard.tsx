"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertCircle, RefreshCw, User, CheckCircle2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface PriorityContact {
  id: string
  first_name: string
  last_name: string
  buyer_stage: string
  suggested_action: string
}

interface PriorityTask {
  id: string
  title: string
  due_date?: string
}

interface DailyBriefingCardProps {
  agentFirstName: string
  briefing: {
    id: string
    briefing_date: string
    summary: string
    top_priority_actions: PriorityTask[] | null
    hot_leads: PriorityContact[] | null
    active_transactions_summary: { count: number; total_value: number } | null
    todays_events: { id: string; title: string; start_at: string }[] | null
    generated_at: string
  } | null
  lastBriefingDate?: string
  onRefresh?: () => void
}

function getTimeOfDayGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  return "Good evening"
}

function getBuyerStageBadgeColor(stage: string): string {
  switch (stage?.toLowerCase()) {
    case "hot":
    case "ready_to_buy":
      return "bg-red-100 text-red-800"
    case "active":
    case "searching":
      return "bg-amber-100 text-amber-800"
    case "nurture":
    case "long_term":
      return "bg-blue-100 text-blue-800"
    default:
      return "bg-muted text-muted-foreground"
  }
}

export function DailyBriefingCard({
  agentFirstName,
  briefing,
  lastBriefingDate,
  onRefresh,
}: DailyBriefingCardProps) {
  const greeting = getTimeOfDayGreeting()

  if (!briefing) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-8 text-center">
          <AlertCircle className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-muted-foreground mb-1">No briefing for today</p>
          {lastBriefingDate && (
            <p className="text-sm text-muted-foreground mb-4">
              Last briefing: {formatDistanceToNow(new Date(lastBriefingDate), { addSuffix: true })}
            </p>
          )}
          {onRefresh && (
            <Button variant="outline" size="lg" className="min-h-[44px]" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Briefing
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  const priorityContacts = (briefing.hot_leads || []).slice(0, 3)
  const priorityTasks = (briefing.top_priority_actions || []).slice(0, 3)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">
            {greeting}, {agentFirstName}
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            AI Draft
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        {briefing.summary && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {briefing.summary}
          </p>
        )}

        {/* Priority Contacts */}
        {priorityContacts.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Priority Contacts</h4>
            <div className="space-y-2">
              {priorityContacts.map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 min-h-[44px]"
                >
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <User className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">
                      {contact.first_name} {contact.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {contact.suggested_action}
                    </p>
                  </div>
                  <Badge className={getBuyerStageBadgeColor(contact.buyer_stage)}>
                    {contact.buyer_stage?.replace(/_/g, " ") || "Lead"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Priority Tasks */}
        {priorityTasks.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Today&apos;s Priorities</h4>
            <ul className="space-y-1">
              {priorityTasks.map((task) => (
                <li key={task.id} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <span>{task.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Market Summary from transactions */}
        {briefing.active_transactions_summary && (
          <div className="text-sm text-muted-foreground border-t pt-3">
            You have {briefing.active_transactions_summary.count} active transaction
            {briefing.active_transactions_summary.count !== 1 ? "s" : ""} worth $
            {(briefing.active_transactions_summary.total_value / 1000000).toFixed(1)}M
          </div>
        )}
      </CardContent>
    </Card>
  )
}
