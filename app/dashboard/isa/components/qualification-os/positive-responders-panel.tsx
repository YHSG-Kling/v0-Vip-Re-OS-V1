"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  UserCheck,
  Calendar,
  Phone,
  ArrowRight,
  Star,
  MessageSquare,
  Clock,
} from "lucide-react"

interface PositiveResponder {
  id: string
  contactId: string
  contactName: string
  phone: string | null
  engagementReason: string
  engagementScore: number
  lastEngagedAt: string
  isReadyForHandoff: boolean
  aiOwned: boolean
  qualificationResult: string | null
}

interface PositiveRespondersPanelProps {
  responders: PositiveResponder[]
  onScheduleCallback?: (contactId: string) => void
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

export function PositiveRespondersPanel({
  responders,
  onScheduleCallback,
}: PositiveRespondersPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const handoffReady = responders.filter((r) => r.isReadyForHandoff)
  const stillAIOwned = responders.filter((r) => !r.isReadyForHandoff && r.aiOwned)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-green-600" />
            Positive Responders
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">
              {handoffReady.length} handoff ready
            </Badge>
            <Badge variant="outline" className="text-xs">
              {stillAIOwned.length} AI-owned
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {responders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <UserCheck className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No positive responders yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Leads with meaningful engagement will appear here
            </p>
          </div>
        ) : (
          <ScrollArea className="h-[280px]">
            <div className="space-y-2 pr-2">
              {responders.map((responder) => (
                <div
                  key={responder.id}
                  className={`border rounded-lg p-3 transition-colors ${
                    responder.isReadyForHandoff
                      ? "bg-green-50/50 border-green-200"
                      : "bg-card hover:bg-accent/30"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{responder.contactName}</p>
                        {responder.engagementScore >= 80 && (
                          <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {responder.phone && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {responder.phone}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTimeAgo(responder.lastEngagedAt)}
                        </span>
                      </div>
                    </div>
                    <Badge
                      variant={responder.isReadyForHandoff ? "default" : "secondary"}
                      className="text-xs shrink-0"
                    >
                      {responder.engagementScore}% engaged
                    </Badge>
                  </div>

                  <div className="mt-2 flex items-start gap-2">
                    <MessageSquare className="h-3.5 w-3.5 text-indigo-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-muted-foreground">{responder.engagementReason}</p>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t">
                    <div className="flex items-center gap-1">
                      {responder.isReadyForHandoff ? (
                        <Badge className="bg-green-100 text-green-700 text-[10px] h-5">
                          Ready for Human Handoff
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] h-5">
                          AI Still Owns
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {responder.isReadyForHandoff && (
                        <Link href="/dashboard/isa/calendar">
                          <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700">
                            <Calendar className="h-3 w-3 mr-1" />
                            Schedule
                          </Button>
                        </Link>
                      )}
                      <Link href={`/dashboard/contacts/${responder.contactId}`}>
                        <Button variant="ghost" size="sm" className="h-7 text-xs">
                          View
                          <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
