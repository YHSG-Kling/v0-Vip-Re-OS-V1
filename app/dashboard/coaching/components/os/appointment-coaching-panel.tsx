"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Calendar,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  Clock,
  UserCheck,
} from "lucide-react"
import Link from "next/link"

interface AppointmentMetric {
  label: string
  value: number
  previous: number
  unit: string
}

interface ShowRateIssue {
  contact_id: string
  contact_name: string
  no_shows: number
  last_appointment: string
  coaching_tip: string
}

interface AppointmentCoachingPanelProps {
  metrics: AppointmentMetric[]
  showRateIssues: ShowRateIssue[]
  overallShowRate: number
  appointmentsSet: number
  appointmentsKept: number
}

export function AppointmentCoachingPanel({
  metrics,
  showRateIssues,
  overallShowRate,
  appointmentsSet,
  appointmentsKept,
}: AppointmentCoachingPanelProps) {
  const showRateColor =
    overallShowRate >= 80 ? "text-green-600" : overallShowRate >= 60 ? "text-amber-600" : "text-red-600"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Calendar className="h-5 w-5 text-cyan-500" />
              Appointment Coaching
            </CardTitle>
            <CardDescription>Show rate and readiness coaching</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/calendar">
              View Calendar
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Show Rate Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-lg font-semibold">{appointmentsSet}</p>
            <p className="text-xs text-muted-foreground">Set</p>
          </div>
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-lg font-semibold">{appointmentsKept}</p>
            <p className="text-xs text-muted-foreground">Kept</p>
          </div>
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className={`text-lg font-semibold ${showRateColor}`}>{overallShowRate}%</p>
            <p className="text-xs text-muted-foreground">Show Rate</p>
          </div>
        </div>

        {/* Show Rate Progress */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Show Rate vs Target (85%)</span>
            <span className={`font-medium ${showRateColor}`}>{overallShowRate}%</span>
          </div>
          <Progress
            value={Math.min((overallShowRate / 85) * 100, 100)}
            className="h-2"
          />
        </div>

        {/* Appointment Metrics */}
        <div className="space-y-2">
          {metrics.map((metric, idx) => {
            const change = metric.value - metric.previous
            const isImproving = change >= 0

            return (
              <div key={idx} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{metric.label}</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {metric.value}
                    {metric.unit}
                  </span>
                  <Badge
                    variant="outline"
                    className={isImproving ? "text-green-600" : "text-red-600"}
                  >
                    {isImproving ? (
                      <TrendingUp className="mr-1 h-3 w-3" />
                    ) : (
                      <TrendingDown className="mr-1 h-3 w-3" />
                    )}
                    {Math.abs(change)}
                    {metric.unit}
                  </Badge>
                </div>
              </div>
            )
          })}
        </div>

        {/* Show Rate Issues */}
        {showRateIssues.length > 0 ? (
          <div className="space-y-2">
            <h4 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              No-Show Patterns
            </h4>
            {showRateIssues.slice(0, 3).map((issue, idx) => (
              <div
                key={idx}
                className="flex items-start justify-between rounded-lg border bg-amber-50 p-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/contacts/${issue.contact_id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {issue.contact_name}
                    </Link>
                    <Badge variant="outline" className="bg-amber-100 text-amber-700">
                      {issue.no_shows} no-show{issue.no_shows !== 1 ? "s" : ""}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{issue.coaching_tip}</p>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Last: {new Date(issue.last_appointment).toLocaleDateString()}
                  </div>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/dashboard/contacts/${issue.contact_id}`}>
                    <UserCheck className="mr-1 h-4 w-4" />
                    Confirm
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        ) : (
          overallShowRate >= 80 && (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-sm">Appointment show rate is strong</span>
            </div>
          )
        )}

        {appointmentsSet === 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-muted-foreground">
            <Calendar className="h-4 w-4" />
            <span className="text-sm">No appointments in the past 7 days</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
