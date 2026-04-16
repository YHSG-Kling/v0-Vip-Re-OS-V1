"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Mail, Flame, Star, TrendingUp, BarChart3, Loader2, CheckCircle2, Send, MessageSquare } from "lucide-react"
import { getOpenHouseAnalytics } from "@/app/actions/seller-open-house"
import {
  generatePerformanceInsights,
  sendFeedbackRequestToAttendee,
  getOpenHouseVisitors,
} from "@/app/actions/open-house-automation"
import { useToast } from "@/hooks/use-toast"
import { createClient } from "@/lib/supabase/client"

interface Props {
  listingId: string
}

export function AnalyticsTab({ listingId }: Props) {
  const [analytics, setAnalytics] = useState<Awaited<ReturnType<typeof getOpenHouseAnalytics>>>(null)
  const [loading, setLoading] = useState(true)
  const [insights, setInsights] = useState<any>(null)
  const [generatingInsights, setGeneratingInsights] = useState(false)
  const [feedbackSent, setFeedbackSent] = useState<Set<string>>(new Set())
  const [eventAttendees, setEventAttendees] = useState<any[]>([])
  const [feedbackData, setFeedbackData] = useState<any[]>([])
  const { toast } = useToast()

  useEffect(() => {
    getOpenHouseAnalytics(listingId).then((d) => {
      setAnalytics(d)
      setLoading(false)
    })
  }, [listingId])

  // When analytics loads, fetch attendees + feedback for the first completed event
  useEffect(() => {
    if (!analytics?.events) return
    const completedEvent = analytics.events.find((e: any) => e.status === "completed")
    if (!completedEvent?.id) return
    getOpenHouseVisitors(completedEvent.id)
      .then((res) => setEventAttendees((res as any)?.visitors ?? []))
      .then(() => {}, () => null)
    const supabase = createClient()
    supabase
      .from("open_house_feedback")
      .select("rating, price_opinion, liked_most, concerns, interested_in_offer, has_own_agent, contact_id")
      .eq("event_id", completedEvent.id)
      .then(({ data }: { data: any }) => setFeedbackData(data ?? []))
      .then(() => {}, () => null)
  }, [analytics])

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
  const completedEvent = events.find((e: any) => e.status === "completed")
  const completedEventId: string | null = completedEvent?.id ?? null

  const rsvpRate = totals.totalInvitations
    ? Math.round((totals.rsvpYes / totals.totalInvitations) * 100)
    : 0

  async function handleGenerateInsights() {
    if (!completedEventId) {
      toast({ title: "No completed event found", description: "Complete an event first.", variant: "destructive" })
      return
    }
    setGeneratingInsights(true)
    try {
      const result = await generatePerformanceInsights(completedEventId)
      if (result && !result.error) {
        setInsights(result)
        toast({ title: "Performance report generated" })
      } else {
        toast({ title: "Failed to generate report", description: result?.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to generate report", variant: "destructive" })
    } finally {
      setGeneratingInsights(false)
    }
  }

  async function handleSendFeedback(attendeeId: string) {
    try {
      const res = await sendFeedbackRequestToAttendee(attendeeId)
      if (res.success) {
        setFeedbackSent((prev) => new Set(prev).add(attendeeId))
        toast({ title: "Feedback request sent" })
      } else {
        toast({ title: "Failed to send request", description: res.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to send request", variant: "destructive" })
    }
  }

  async function handleSendFeedbackToAll() {
    const pending = eventAttendees.filter((a: any) => !feedbackSent.has(a.id))
    if (!pending.length) {
      toast({ title: "All feedback requests already sent" })
      return
    }
    await Promise.all(pending.map((a: any) => handleSendFeedback(a.id)))
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Event Performance ── */}
      {completedEventId && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Event Performance</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Generate report */}
            {!insights ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  Generate an AI performance report for the most recently completed event.
                </p>
                <Button
                  size="sm"
                  onClick={handleGenerateInsights}
                  disabled={generatingInsights}
                  className="self-start"
                >
                  {generatingInsights ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Generate Performance Report
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-3xl font-bold">{insights.overall_grade}</span>
                  <p className="text-sm text-muted-foreground leading-relaxed">{insights.performance_summary}</p>
                </div>

                {insights.strengths?.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Strengths
                    </span>
                    <ul className="flex flex-col gap-0.5">
                      {insights.strengths.map((s: string, i: number) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {insights.recommendations?.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Recommendations
                    </span>
                    <ul className="flex flex-col gap-0.5">
                      {insights.recommendations.map((r: string, i: number) => (
                        <li key={i} className="text-xs text-muted-foreground leading-relaxed">
                          {i + 1}. {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleGenerateInsights}
                  disabled={generatingInsights}
                  className="self-start text-xs h-7"
                >
                  {generatingInsights ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                  Regenerate
                </Button>
              </div>
            )}

            {/* Feedback requests */}
            {eventAttendees.length > 0 && (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Feedback Requests
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleSendFeedbackToAll}
                  >
                    <Send className="mr-1.5 h-3 w-3" />
                    Send to All
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {eventAttendees.map((attendee: any) => {
                    const sent = feedbackSent.has(attendee.id)
                    const name =
                      attendee.contact_name ??
                      (attendee.contact
                        ? `${attendee.contact.first_name ?? ""} ${attendee.contact.last_name ?? ""}`.trim()
                        : null) ??
                      `Attendee ${attendee.id.slice(0, 6)}`
                    return (
                      <div
                        key={attendee.id}
                        className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                      >
                        <span className="text-sm">{name}</span>
                        {sent ? (
                          <Badge
                            variant="outline"
                            className="text-xs border-green-300 text-green-700 bg-green-50"
                          >
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            Sent
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => handleSendFeedback(attendee.id)}
                          >
                            <Send className="mr-1.5 h-3 w-3" />
                            Send Request
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

      {/* ── Visitor Feedback ── */}
      {completedEventId && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Visitor Feedback</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {feedbackData.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No feedback yet — send feedback requests to attendees above.
              </p>
            ) : (
              <div className="flex flex-col gap-6">
                {/* Summary row */}
                {(() => {
                  const avgRating = feedbackData.reduce((s, f) => s + (f.rating ?? 0), 0) / feedbackData.length
                  const offerCount = feedbackData.filter((f) => f.interested_in_offer).length
                  const agentCount = feedbackData.filter((f) => f.has_own_agent).length
                  const opinionCounts: Record<string, number> = {}
                  feedbackData.forEach((f) => {
                    if (f.price_opinion) opinionCounts[f.price_opinion] = (opinionCounts[f.price_opinion] ?? 0) + 1
                  })
                  const topOpinion = Object.entries(opinionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
                  const opinionLabel: Record<string, string> = {
                    too_high: "Too High",
                    priced_right: "Priced Right",
                    good_value: "Good Value",
                  }
                  return (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                        <span className="text-xs text-muted-foreground">Avg Rating</span>
                        <span className="text-xl font-bold">{avgRating.toFixed(1)} / 5</span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                        <span className="text-xs text-muted-foreground">Offer Interest</span>
                        <span className="text-xl font-bold">
                          {offerCount}/{feedbackData.length}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                        <span className="text-xs text-muted-foreground">Has Own Agent</span>
                        <span className="text-xl font-bold">{agentCount}</span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                        <span className="text-xs text-muted-foreground">Price Opinion</span>
                        {topOpinion ? (
                          <Badge
                            variant="outline"
                            className={`w-fit text-xs mt-0.5 ${
                              topOpinion === "too_high"
                                ? "border-red-200 text-red-700 bg-red-50"
                                : topOpinion === "good_value"
                                  ? "border-green-200 text-green-700 bg-green-50"
                                  : "border-blue-200 text-blue-700 bg-blue-50"
                            }`}
                          >
                            {opinionLabel[topOpinion] ?? topOpinion}
                          </Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Hot prospects */}
                {(() => {
                  const hotProspects = feedbackData.filter((f) => f.interested_in_offer && f.contact_id)
                  if (!hotProspects.length) return null
                  return (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-4 flex flex-col gap-2">
                      <p className="text-sm font-medium text-amber-900">
                        {hotProspects.length} visitor{hotProspects.length !== 1 ? "s" : ""} want to make an offer
                      </p>
                      <div className="flex flex-col gap-1">
                        {hotProspects.map((f, i) => (
                          <Link
                            key={i}
                            href={`/crm?contactId=${f.contact_id}`}
                            className="text-xs text-amber-800 underline underline-offset-2 hover:text-amber-900"
                          >
                            View contact {f.contact_id.slice(0, 8)}...
                          </Link>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                {/* Feedback list */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Recent Responses
                  </span>
                  {feedbackData.slice(0, 8).map((f, i) => (
                    <div key={i} className="rounded-md border border-border p-3 flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-0.5">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <Star
                              key={n}
                              className={`h-3.5 w-3.5 ${n <= (f.rating ?? 0) ? "text-amber-400 fill-amber-400" : "text-muted-foreground/30"}`}
                            />
                          ))}
                        </div>
                        {f.price_opinion && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 ${
                              f.price_opinion === "too_high"
                                ? "border-red-200 text-red-700"
                                : f.price_opinion === "good_value"
                                  ? "border-green-200 text-green-700"
                                  : "border-blue-200 text-blue-700"
                            }`}
                          >
                            {f.price_opinion === "too_high"
                              ? "Too High"
                              : f.price_opinion === "good_value"
                                ? "Good Value"
                                : "Priced Right"}
                          </Badge>
                        )}
                      </div>
                      {f.liked_most && (
                        <p className="text-xs text-green-700 bg-green-50 rounded px-2 py-1 leading-relaxed">
                          Liked: {f.liked_most}
                        </p>
                      )}
                      {f.concerns && (
                        <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 leading-relaxed">
                          Concerns: {f.concerns}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
                <div
                  key={ev.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {new Date(ev.event_date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
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

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
}) {
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
