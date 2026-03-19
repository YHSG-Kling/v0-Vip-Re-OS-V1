"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, Home, Calendar, Users } from "lucide-react"

interface OpenHouseReadinessCardProps {
  listingId: string
  scheduledEvent?: {
    id: string
    event_date: string
    start_time: string
    end_time: string
    status: string
  }
  promotionStatus: "not_started" | "scheduled" | "published"
  rsvpCount: number
}

export function OpenHouseReadinessCard({
  listingId,
  scheduledEvent,
  promotionStatus,
  rsvpCount,
}: OpenHouseReadinessCardProps) {
  const hasEvent = !!scheduledEvent
  const isPromoted = promotionStatus === "published" || promotionStatus === "scheduled"
  const isReady = hasEvent && isPromoted

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  }

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-muted"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Home className="h-4 w-4 text-indigo-600" />
            Open House
          </span>
          <Badge variant={isReady ? "default" : "secondary"} className="text-xs">
            {hasEvent ? (scheduledEvent.status === "completed" ? "Completed" : "Scheduled") : "Not Scheduled"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {hasEvent ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              Event Scheduled
            </span>
            {scheduledEvent && (
              <span className="text-foreground font-medium">
                {formatDate(scheduledEvent.event_date)}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {isPromoted ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              Promotion
            </span>
            <span className={isPromoted ? "text-green-700 font-medium" : "text-muted-foreground"}>
              {promotionStatus === "published" ? "Live" : promotionStatus === "scheduled" ? "Scheduled" : "Not Started"}
            </span>
          </div>

          {hasEvent && (
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                RSVPs
              </span>
              <span className="text-foreground font-medium">{rsvpCount}</span>
            </div>
          )}
        </div>

        {scheduledEvent && (
          <div className="p-2 bg-muted/50 rounded text-xs">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span>
                {scheduledEvent.start_time} - {scheduledEvent.end_time}
              </span>
            </div>
          </div>
        )}

        <Link href={`/dashboard/listings/${listingId}/open-house`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            {hasEvent ? "Manage Open House" : "Schedule Open House"}
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
