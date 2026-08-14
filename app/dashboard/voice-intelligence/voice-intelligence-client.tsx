"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Mic,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Loader2,
  TrendingUp,
  AlertTriangle,
  Mail,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"
import { generateCallSummaryEmail, getAgentCallInsights } from "@/app/actions/ai-voice-transcription"
import { recordingPlaybackPath } from "@/lib/voice/recording-playback-path"

export interface CallRow {
  id: string
  brokerage_id: string
  agent_id: string | null
  contact_id: string | null
  direction: string | null
  status: string | null
  call_type: string | null
  phone_from: string | null
  phone_to: string | null
  duration_seconds: number | null
  recording_url: string | null
  transcription: string | null
  summary: string | null
  sentiment: string | null
  outcome: string | null
  started_at: string | null
  ended_at: string | null
  compliance_passed: boolean | null
  compliance_flags: string[] | null
  contact_name?: string | null
}

interface Props {
  calls: CallRow[]
  agentId: string
  brokerageId: string
}

const SENTIMENT_VARIANT: Record<string, string> = {
  positive: "text-emerald-700 border-emerald-300 bg-emerald-50",
  neutral: "text-slate-700 border-slate-300 bg-slate-50",
  negative: "text-red-700 border-red-300 bg-red-50",
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—"
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function VoiceIntelligenceClient({ calls, agentId, brokerageId }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(calls[0]?.id ?? null)
  const [emailingId, setEmailingId] = useState<string | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(true)
  const [insights, setInsights] = useState<any>(null)
  const [timeframe, setTimeframe] = useState<"week" | "month" | "quarter">("month")
  const [, startTransition] = useTransition()

  const selected = calls.find((c) => c.id === selectedId) ?? null

  useEffect(() => {
    let cancelled = false
    setInsightsLoading(true)
    ;(async () => {
      try {
        const result = await getAgentCallInsights({ agentId, timeframe })
        if (cancelled) return
        if ((result as any).success) setInsights((result as any).insights)
        else setInsights(null)
      } finally {
        if (!cancelled) setInsightsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, timeframe])

  function emailSummary(callId: string) {
    setEmailingId(callId)
    startTransition(async () => {
      try {
        const result = await generateCallSummaryEmail({ callId, agentId } as any)
        if ((result as any).success) toast.success("Summary email drafted.")
        else toast.error((result as any).error ?? "Couldn't draft email.")
      } finally {
        setEmailingId(null)
      }
    })
  }

  // Top stat strip values
  const stats = {
    totalCalls: insights?.totalCalls ?? calls.length,
    avgDuration: insights?.avgCallDuration
      ? Math.round(insights.avgCallDuration)
      : Math.round(
          calls.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) / Math.max(calls.length, 1),
        ),
    positivePct:
      insights?.sentimentDistribution?.positive ??
      Math.round(
        (calls.filter((c) => c.sentiment === "positive").length / Math.max(calls.length, 1)) * 100,
      ),
    complianceScore: insights?.complianceScore ?? null,
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Mic className="h-6 w-6 text-primary" />
            Voice Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Call library, transcripts, and AI-powered coaching insights.
          </p>
        </div>
        <Select value={timeframe} onValueChange={(v) => setTimeframe(v as any)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="week">7 days</SelectItem>
            <SelectItem value="month">30 days</SelectItem>
            <SelectItem value="quarter">90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Top stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg shrink-0">
              <Phone className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{stats.totalCalls}</p>
              <p className="text-xs text-muted-foreground">Total Calls</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg shrink-0">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{stats.positivePct}%</p>
              <p className="text-xs text-muted-foreground">Positive Sentiment</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-amber-100 rounded-lg shrink-0">
              <Sparkles className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{formatDuration(stats.avgDuration)}</p>
              <p className="text-xs text-muted-foreground">Avg Duration</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-violet-100 rounded-lg shrink-0">
              <AlertTriangle className="h-4 w-4 text-violet-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">
                {stats.complianceScore != null ? `${stats.complianceScore}%` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Compliance Score</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Call list */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent calls</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {calls.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">No calls recorded yet.</p>
            ) : (
              <ul className="divide-y max-h-[600px] overflow-y-auto">
                {calls.map((c) => {
                  const isSelected = c.id === selectedId
                  const dirIcon =
                    c.direction === "inbound" ? (
                      <PhoneIncoming className="h-3.5 w-3.5 text-blue-600" />
                    ) : (
                      <PhoneOutgoing className="h-3.5 w-3.5 text-emerald-600" />
                    )
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => setSelectedId(c.id)}
                        className={`w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors ${
                          isSelected ? "bg-primary/5 border-l-2 border-l-primary" : ""
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          {dirIcon}
                          <p className="text-sm font-medium truncate flex-1">
                            {c.contact_name ?? c.phone_from ?? c.phone_to ?? "Unknown caller"}
                          </p>
                          {c.sentiment && (
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${SENTIMENT_VARIANT[c.sentiment] ?? ""}`}
                            >
                              {c.sentiment}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            {c.started_at
                              ? new Date(c.started_at).toLocaleString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </span>
                          <span>{formatDuration(c.duration_seconds)}</span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Selected call details */}
        <div className="lg:col-span-3 space-y-4">
          {!selected ? (
            <Card>
              <CardContent className="p-8 text-sm text-muted-foreground text-center">
                Select a call to view its transcript and insights.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm">
                      {selected.contact_name ?? "Unknown caller"} · {formatDuration(selected.duration_seconds)}
                    </CardTitle>
                    <div className="flex gap-2">
                      {selected.sentiment && (
                        <Badge
                          variant="outline"
                          className={`text-xs ${SENTIMENT_VARIANT[selected.sentiment] ?? ""}`}
                        >
                          {selected.sentiment}
                        </Badge>
                      )}
                      {selected.outcome && (
                        <Badge variant="outline" className="text-xs">
                          {selected.outcome}
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* recording_url holds the api.twilio.com media URL, which is
                      behind HTTP Basic auth — an <audio src> pointed at it is a
                      guaranteed 401. Playback goes through the authenticated,
                      tenant-scoped same-origin proxy, keyed by voice_calls.id. */}
                  {selected.recording_url ? (
                    <audio controls src={recordingPlaybackPath(selected.id)} className="w-full" />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No recording for this call.
                    </p>
                  )}
                  {selected.summary && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground mb-1">Summary</p>
                      <p className="text-sm">{selected.summary}</p>
                    </div>
                  )}
                  {selected.compliance_flags && selected.compliance_flags.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                      <p className="text-xs font-semibold text-amber-900 mb-1 flex items-center gap-1.5">
                        <AlertTriangle className="h-3 w-3" />
                        Compliance flags
                      </p>
                      <ul className="list-disc pl-5 text-xs text-amber-900 space-y-0.5">
                        {selected.compliance_flags.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="flex items-center justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => emailSummary(selected.id)}
                      disabled={emailingId === selected.id}
                    >
                      {emailingId === selected.id ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Drafting…
                        </>
                      ) : (
                        <>
                          <Mail className="h-3.5 w-3.5 mr-1.5" />
                          Email summary
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {selected.transcription && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Transcript</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="text-xs whitespace-pre-wrap leading-relaxed bg-muted/30 rounded p-3 max-h-96 overflow-y-auto">
                      {selected.transcription}
                    </pre>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* AI insights */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Coaching insights ({timeframe})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {insightsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating insights…
                </div>
              ) : !insights ? (
                <p className="text-sm text-muted-foreground">
                  Not enough call data in this timeframe yet.
                </p>
              ) : (
                <div className="space-y-3 text-sm">
                  {insights.topTopics?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground mb-1">Top topics</p>
                      <div className="flex flex-wrap gap-1.5">
                        {insights.topTopics.map((t: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {insights.strengthAreas?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-emerald-700 mb-1">Strengths</p>
                      <ul className="list-disc pl-5 text-xs space-y-0.5">
                        {insights.strengthAreas.map((s: string, i: number) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {insights.improvementAreas?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-amber-700 mb-1">Improvement areas</p>
                      <ul className="list-disc pl-5 text-xs space-y-0.5">
                        {insights.improvementAreas.map((s: string, i: number) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {insights.recommendations?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-primary mb-1">Recommendations</p>
                      <ul className="list-disc pl-5 text-xs space-y-0.5">
                        {insights.recommendations.map((s: string, i: number) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
