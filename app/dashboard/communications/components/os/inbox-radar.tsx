"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { 
  Inbox, 
  Mail, 
  MessageSquare, 
  Phone, 
  Clock, 
  AlertTriangle,
  TrendingUp,
  TrendingDown
} from "lucide-react"

interface InboxRadarProps {
  totalUnread: number
  emailUnread: number
  smsUnread: number
  voicemailCount: number
  urgentCount: number
  avgResponseTime: number // in minutes
  responseTimeTrend: "up" | "down" | "stable"
  oldestUnreadHours: number
}

export function InboxRadar({
  totalUnread,
  emailUnread,
  smsUnread,
  voicemailCount,
  urgentCount,
  avgResponseTime,
  responseTimeTrend,
  oldestUnreadHours,
}: InboxRadarProps) {
  const getUrgencyColor = (hours: number) => {
    if (hours > 24) return "text-destructive"
    if (hours > 4) return "text-amber-600"
    return "text-muted-foreground"
  }

  const formatResponseTime = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`
    if (minutes < 1440) return `${Math.round(minutes / 60)}h`
    return `${Math.round(minutes / 1440)}d`
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {/* Total Unread */}
      <Card className="border-l-4 border-l-primary">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            Unread
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{totalUnread}</div>
          <p className="text-xs text-muted-foreground mt-1">messages waiting</p>
        </CardContent>
      </Card>

      {/* Email Unread */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Email
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{emailUnread}</div>
          <p className="text-xs text-muted-foreground mt-1">unread emails</p>
        </CardContent>
      </Card>

      {/* SMS Unread */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            SMS
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{smsUnread}</div>
          <p className="text-xs text-muted-foreground mt-1">unread texts</p>
        </CardContent>
      </Card>

      {/* Voicemail */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Voicemail
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{voicemailCount}</div>
          <p className="text-xs text-muted-foreground mt-1">new voicemails</p>
        </CardContent>
      </Card>

      {/* Urgent */}
      <Card className={urgentCount > 0 ? "border-destructive bg-destructive/5" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Urgent
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className={`text-3xl font-bold ${urgentCount > 0 ? "text-destructive" : ""}`}>
            {urgentCount}
          </div>
          <p className="text-xs text-muted-foreground mt-1">need attention</p>
        </CardContent>
      </Card>

      {/* Response Time */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Avg Response
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <span className="text-3xl font-bold">{formatResponseTime(avgResponseTime)}</span>
            {responseTimeTrend === "down" && <TrendingDown className="h-4 w-4 text-green-600" />}
            {responseTimeTrend === "up" && <TrendingUp className="h-4 w-4 text-destructive" />}
          </div>
          {oldestUnreadHours > 0 && (
            <p className={`text-xs mt-1 ${getUrgencyColor(oldestUnreadHours)}`}>
              Oldest: {oldestUnreadHours}h ago
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
