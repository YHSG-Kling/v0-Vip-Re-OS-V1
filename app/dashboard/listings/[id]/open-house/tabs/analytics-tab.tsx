"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Users, Mail, Flame, Star, TrendingUp } from "lucide-react"
import { getOpenHouseAnalytics } from "@/app/actions/seller-open-house"

interface Props {
  listingId: string
}

export function AnalyticsTab({ listingId }: Props) {
  const [analytics, setAnalytics] = useState<Awaited<ReturnType<typeof getOpenHouseAnalytics>>>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getOpenHouseAnalytics(listingId).then((d) => {
      setAnalytics(d)
      setLoading(false)
    })
  }, [listingId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Loading analytics...
      </div>
    )
  }

  if (!analytics || !analytics.totals) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No analytics yet. Complete an open house event to see results.
        </CardContent>
      </Card>
    )
  }

  const { totals, events } = analytics

  const rsvpRate = totals.totalInvitations
    ? Math.round((totals.rsvpYes / totals.totalInvitations) * 100)
    : 0

  return (
    <div className="flex flex-col gap-6">
      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          icon={<Mail className="h-4 w-4 text-muted-foreground" />}
          label="Total Invitations"
          value={totals.totalInvitations}
        />
        <MetricCard
          icon={<Users className="h-4 w-4 text-muted-foreground" />}
          label="Total Attendees"
          value={totals.totalAttendees}
        />
        <MetricCard
          icon={<Flame className="h-4 w-4 text-amber-500" />}
          label="Hot Leads"
          value={totals.hotLeads}
        />
        <MetricCard
          icon={<Star className="h-4 w-4 text-muted-foreground" />}
          label="Avg Lead Score"
          value={`${totals.avgLeadScore}/100`}
        />
      </div>

      {/* RSVP breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">RSVP Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col items-center gap-1 min-w-16">
              <span className="text-2xl font-bold text-foreground">{totals.rsvpYes}</span>
              <span className="text-xs text-muted-foreground">Yes</span>
            </div>
            <div className="flex flex-col items-center gap-1 min-w-16">
              <span className="text-2xl font-bold text-foreground">{totals.rsvpMaybe}</span>
              <span className="text-xs text-muted-foreground">Maybe</span>
            </div>
            <div className="flex flex-col items-center gap-1 min-w-16">
              <span className="text-2xl font-bold text-foreground">{totals.rsvpNo}</span>
              <span className="text-xs text-muted-foreground">No</span>
            </div>
            <div className="flex flex-col items-center gap-1 min-w-16">
              <span className="text-2xl font-bold text-foreground">{rsvpRate}%</span>
              <span className="text-xs text-muted-foreground">RSVP Rate</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-event comparison */}
      {events.length > 1 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Prior Open House Comparison</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {events.map((ev: any) => (
                <div key={ev.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {new Date(ev.event_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                    <Badge
                      variant="outline"
                      className={`w-fit text-xs ${ev.status === "completed" ? "border-green-200 text-green-700" : ""}`}
                    >
                      {ev.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="text-right">
                      <div className="font-medium">{ev.invitations}</div>
                      <div className="text-xs text-muted-foreground">Invited</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{ev.rsvpYes}</div>
                      <div className="text-xs text-muted-foreground">RSVPs</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{ev.attendees}</div>
                      <div className="text-xs text-muted-foreground">Attended</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-amber-600">{ev.hotLeads}</div>
                      <div className="text-xs text-muted-foreground">Hot Leads</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-4">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <span className="text-2xl font-bold text-foreground">{value}</span>
      </CardContent>
    </Card>
  )
}
