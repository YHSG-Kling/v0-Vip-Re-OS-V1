"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, Calendar, Thermometer, Star, MessageSquare } from "lucide-react"

interface RelationshipRadarProps {
  contactId: string
  engagementScore?: number | null
  daysSinceContact?: number | null
  messageTemperature?: "hot" | "warm" | "cold" | "unknown" | null
  referralPotential?: "high" | "medium" | "low" | null
  openThreadCount?: number
  upcomingMilestones?: Array<{ event: string; daysAway: number }> | null
}

export function RelationshipRadar({
  contactId,
  engagementScore,
  daysSinceContact,
  messageTemperature,
  referralPotential,
  openThreadCount = 0,
  upcomingMilestones,
}: RelationshipRadarProps) {
  const getDaysSinceColor = (days: number | null | undefined) => {
    if (days === null || days === undefined) return "text-gray-400"
    if (days < 7) return "text-emerald-600"
    if (days < 30) return "text-amber-600"
    return "text-red-600"
  }

  const getTemperatureBadge = (temp: string | null | undefined) => {
    switch (temp) {
      case "hot":
        return { text: "Hot", className: "bg-red-100 text-red-700", icon: "🔥" }
      case "warm":
        return { text: "Warm", className: "bg-amber-100 text-amber-700", icon: "☀️" }
      case "cold":
        return { text: "Cold", className: "bg-blue-100 text-blue-700", icon: "❄️" }
      default:
        return { text: "Unknown", className: "bg-gray-100 text-gray-600", icon: "❓" }
    }
  }

  const getReferralBadge = (potential: string | null | undefined) => {
    switch (potential) {
      case "high":
        return { text: "High Potential", className: "bg-amber-100 text-amber-700", icon: "⭐" }
      case "medium":
        return { text: "Moderate", className: "bg-gray-200 text-gray-700", icon: "🥈" }
      case "low":
        return { text: "Building", className: "bg-gray-100 text-gray-500", icon: "📈" }
      default:
        return { text: "--", className: "bg-gray-100 text-gray-400", icon: "" }
    }
  }

  const tempBadge = getTemperatureBadge(messageTemperature)
  const refBadge = getReferralBadge(referralPotential)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-600" />
          Relationship Radar
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* 5-tile grid */}
        <div className="grid grid-cols-5 gap-3">
          {/* Engagement Score */}
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <div className="relative inline-flex items-center justify-center">
              <svg className="h-12 w-12" viewBox="0 0 36 36">
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="#e5e7eb"
                  strokeWidth="3"
                />
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth="3"
                  strokeDasharray={`${engagementScore || 0}, 100`}
                />
              </svg>
              <span className="absolute text-sm font-bold">{engagementScore ?? "--"}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Engagement</p>
          </div>

          {/* Days Since Contact */}
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <Calendar className={`h-5 w-5 mx-auto ${getDaysSinceColor(daysSinceContact)}`} />
            <p className={`text-xl font-bold mt-1 ${getDaysSinceColor(daysSinceContact)}`}>
              {daysSinceContact ?? "--"}
            </p>
            <p className="text-xs text-muted-foreground">Days Since</p>
          </div>

          {/* Message Temperature */}
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <Thermometer className="h-5 w-5 mx-auto text-gray-500" />
            <Badge className={`mt-2 ${tempBadge.className}`}>
              {tempBadge.icon} {tempBadge.text}
            </Badge>
            <p className="text-xs text-muted-foreground mt-1">Temperature</p>
          </div>

          {/* Referral Potential */}
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <Star className="h-5 w-5 mx-auto text-amber-500" />
            <Badge className={`mt-2 ${refBadge.className}`}>
              {refBadge.icon} {refBadge.text}
            </Badge>
            <p className="text-xs text-muted-foreground mt-1">Referral</p>
          </div>

          {/* Open Threads */}
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <MessageSquare className="h-5 w-5 mx-auto text-blue-500" />
            <p className="text-xl font-bold mt-1">{openThreadCount}</p>
            <p className="text-xs text-muted-foreground">Open Threads</p>
          </div>
        </div>

        {/* Milestones strip */}
        {upcomingMilestones && upcomingMilestones.length > 0 && (
          <div className="mt-4 pt-3 border-t flex flex-wrap gap-2">
            {upcomingMilestones.map((m, idx) => (
              <Badge key={idx} variant="outline" className="text-xs">
                📅 {m.event} in {m.daysAway} days
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
