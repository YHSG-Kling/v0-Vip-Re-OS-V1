"use client"

/**
 * app/dashboard/isa/components/qualification-os.tsx
 *
 * Six named exports consumed by app/dashboard/isa/page.tsx:
 *   QualificationRadar        — full-width metric radar
 *   ConversationIntelligencePanel — per-lead conversation insights
 *   PositiveRespondersPanel   — leads that engaged positively
 *   HardStopsPanel            — leads blocked by compliance / DNC
 *   GhostRecoveryPanel        — silent / non-responsive leads
 *   RetrainingSignalsPanel    — coaching signals for model improvement
 *
 * All props are exactly what the ISA page passes — no stubs, no placeholders.
 * UI uses shadcn/ui primitives + Tailwind. No extra deps required.
 */

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Ghost,
  MessageSquare,
  Pause,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  UserCheck,
  Users,
  Zap,
} from "lucide-react"
import { useState } from "react"
import { resumeAIISA } from "@/app/actions/leads"
import { toast } from "sonner"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface RadarMetrics {
  newLeadsUnderAI: number
  activelyNurturing: number
  positiveResponders: number
  qualifiedHandoffReady: number
  stalled: number
  blockedByHardStop: number
  waitingRetry: number
}

interface ConversationRecord {
  id: string
  contactId: string
  contactName: string
  transcriptSummary: string
  topObjections: string[]
  motivationSignals: string[]
  urgencyClues: string[]
  financingClues: string[]
  sentiment: "positive" | "neutral" | "negative"
  confidenceScore: number
  recommendedNextAction: string
  createdAt: string
}

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

interface HardStop {
  id: string
  contactId: string
  contactName: string
  reason: "dnc" | "compliance" | "duplicate" | "blocked" | "cooldown" | "insufficient_qualification"
  reasonDetail: string
  blockedSince: string
  canRetryAt: string | null
}

interface GhostRecord {
  id: string
  contactId?: string
  contactName?: string
  first_name?: string
  last_name?: string
  phone?: string
  email?: string
  lifecycle_state?: string
  last_contacted_at?: string
  reengagement_attempt_count?: number
  lead_id?: string
  brokerage_id?: string
}

interface RetrainingSignal {
  id: string
  signalType: "failed_objection" | "coaching_insight" | "tone_mismatch" | "timing_error"
  title: string
  description: string
  frequency: number
  impactScore: number
  suggestedImprovement: string | null
  createdAt: string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sentimentColor(sentiment: string) {
  if (sentiment === "positive") return "text-green-700 bg-green-50 border-green-200"
  if (sentiment === "negative") return "text-red-700 bg-red-50 border-red-200"
  return "text-slate-600 bg-slate-50 border-slate-200"
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function hardStopLabel(reason: string) {
  const map: Record<string, string> = {
    dnc: "Do Not Contact",
    compliance: "Compliance Block",
    duplicate: "Duplicate Lead",
    blocked: "Blocked",
    cooldown: "Cooldown Period",
    insufficient_qualification: "Did Not Qualify",
  }
  return map[reason] ?? reason.replace(/_/g, " ")
}

// ─── QualificationRadar ───────────────────────────────────────────────────────

export function QualificationRadar(props: RadarMetrics) {
  const metrics = [
    { label: "New Under AI", value: props.newLeadsUnderAI, icon: Sparkles, color: "text-indigo-600", bg: "bg-indigo-50" },
    { label: "Actively Nurturing", value: props.activelyNurturing, icon: Brain, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Positive Responders", value: props.positiveResponders, icon: MessageSquare, color: "text-green-600", bg: "bg-green-50" },
    { label: "Handoff Ready", value: props.qualifiedHandoffReady, icon: UserCheck, color: "text-emerald-600", bg: "bg-emerald-50" },
    { label: "Stalled / No Response", value: props.stalled, icon: Pause, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "Hard Stops", value: props.blockedByHardStop, icon: ShieldAlert, color: "text-red-600", bg: "bg-red-50" },
    { label: "Waiting Retry", value: props.waitingRetry, icon: Clock, color: "text-slate-500", bg: "bg-slate-50" },
  ]

  const total = metrics.reduce((s, m) => s + m.value, 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-500" />
          Qualification Radar
          {total > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">
              {total} leads total
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {metrics.map((m) => (
            <div
              key={m.label}
              className={`rounded-lg border p-3 flex flex-col items-center gap-1.5 ${m.bg}`}
            >
              <m.icon className={`w-5 h-5 ${m.color}`} />
              <p className={`text-2xl font-bold leading-none ${m.color}`}>{m.value}</p>
              <p className="text-[10px] text-center text-muted-foreground leading-tight">{m.label}</p>
            </div>
          ))}
        </div>
        {total > 0 && (
          <div className="mt-3 space-y-1.5">
            {metrics.filter((m) => m.value > 0).map((m) => (
              <div key={m.label} className="flex items-center gap-2">
                <span className="text-[10px] w-36 shrink-0 text-muted-foreground truncate">{m.label}</span>
                <Progress value={Math.round((m.value / total) * 100)} className="h-1.5 flex-1" />
                <span className={`text-[10px] font-medium w-6 text-right ${m.color}`}>{m.value}</span>
              </div>
            ))}
          </div>
        )}
        {total === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-3 py-4">
            No active AI-ISA leads. Campaigns will populate this radar as leads are engaged.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── ConversationIntelligencePanel ───────────────────────────────────────────

export function ConversationIntelligencePanel({
  conversations,
}: {
  conversations: ConversationRecord[]
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (conversations.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No conversation intelligence available yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Signals populate as AI-ISA campaigns complete qualification calls.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {conversations.map((conv) => (
        <Card key={conv.id} className="overflow-hidden">
          <CardHeader className="pb-2 px-4 pt-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <p className="font-semibold text-sm">{conv.contactName}</p>
                <p className="text-xs text-muted-foreground">{relativeTime(conv.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={`text-xs capitalize ${sentimentColor(conv.sentiment)}`}
                >
                  {conv.sentiment}
                </Badge>
                <Badge variant="outline" className="text-xs bg-indigo-50 text-indigo-700 border-indigo-200">
                  {conv.confidenceScore}% confidence
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">{conv.transcriptSummary}</p>

            <div className="grid sm:grid-cols-2 gap-3">
              {conv.topObjections.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-red-500 mb-1">Objections</p>
                  <ul className="space-y-1">
                    {conv.topObjections.map((o, i) => (
                      <li key={i} className="text-xs bg-red-50 text-red-800 rounded px-2 py-0.5">{o}</li>
                    ))}
                  </ul>
                </div>
              )}
              {conv.motivationSignals.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-green-500 mb-1">Motivations</p>
                  <ul className="space-y-1">
                    {conv.motivationSignals.map((s, i) => (
                      <li key={i} className="text-xs bg-green-50 text-green-800 rounded px-2 py-0.5">{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {conv.urgencyClues.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-500 mb-1">Urgency Signals</p>
                  <ul className="space-y-1">
                    {conv.urgencyClues.map((u, i) => (
                      <li key={i} className="text-xs bg-amber-50 text-amber-800 rounded px-2 py-0.5">{u}</li>
                    ))}
                  </ul>
                </div>
              )}
              {conv.financingClues.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-500 mb-1">Financing Clues</p>
                  <ul className="space-y-1">
                    {conv.financingClues.map((f, i) => (
                      <li key={i} className="text-xs bg-blue-50 text-blue-800 rounded px-2 py-0.5">{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500 mb-0.5">Recommended Next Action</p>
              <p className="text-sm font-medium text-indigo-900">{conv.recommendedNextAction}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─── PositiveRespondersPanel ──────────────────────────────────────────────────

export function PositiveRespondersPanel({
  responders,
}: {
  responders: PositiveResponder[]
}) {
  if (responders.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Users className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No positive responders yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Leads that reply, click, or open messages will appear here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {responders.length} lead{responders.length !== 1 ? "s" : ""} with positive engagement signals
      </p>
      {responders.map((r) => (
        <Card key={r.id} className="overflow-hidden">
          <CardContent className="p-3 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{r.contactName}</p>
              {r.phone && <p className="text-xs text-muted-foreground">{r.phone}</p>}
              <p className="text-xs text-muted-foreground mt-0.5">{r.engagementReason}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <div className="text-right">
                <p className={`text-sm font-bold ${r.engagementScore >= 80 ? "text-green-700" : r.engagementScore >= 60 ? "text-amber-700" : "text-slate-600"}`}>
                  {r.engagementScore}%
                </p>
                <p className="text-[10px] text-muted-foreground">score</p>
              </div>
              <Badge
                variant="outline"
                className={r.isReadyForHandoff
                  ? "text-xs bg-green-50 text-green-700 border-green-200"
                  : "text-xs bg-blue-50 text-blue-700 border-blue-200"}
              >
                {r.isReadyForHandoff ? (
                  <><UserCheck className="w-3 h-3 mr-1" />Handoff Ready</>
                ) : (
                  <><Brain className="w-3 h-3 mr-1" />AI Nurturing</>
                )}
              </Badge>
              <p className="text-[10px] text-muted-foreground shrink-0">{relativeTime(r.lastEngagedAt)}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─── GhostRecoveryPanel ───────────────────────────────────────────────────────

export function GhostRecoveryPanel({
  ghosts,
  brokerageId,
}: {
  ghosts: GhostRecord[]
  brokerageId: string
}) {
  const [resumingId, setResumingId] = useState<string | null>(null)

  const handleResume = async (leadId: string) => {
    setResumingId(leadId)
    try {
      const result = await resumeAIISA(leadId)
      if (result.success) {
        toast.success("AI-ISA outreach resumed")
      } else {
        toast.error(result.error ?? "Failed to resume outreach")
      }
    } catch {
      toast.error("Unexpected error resuming outreach")
    } finally {
      setResumingId(null)
    }
  }

  if (ghosts.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Ghost className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No ghost leads in recovery queue.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Leads that stop responding are moved here for re-engagement.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {ghosts.length} silent lead{ghosts.length !== 1 ? "s" : ""} awaiting re-engagement
      </p>
      {ghosts.map((ghost) => {
        const name =
          (ghost.contactName ??
            `${ghost.first_name ?? ""} ${ghost.last_name ?? ""}`.trim()) ||
          "Unknown Lead"
        const leadId = ghost.lead_id ?? ghost.id

        return (
          <Card key={ghost.id} className="overflow-hidden">
            <CardContent className="p-3 flex items-center gap-3 flex-wrap">
              <Ghost className="w-5 h-5 text-slate-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{name}</p>
                {ghost.phone && <p className="text-xs text-muted-foreground">{ghost.phone}</p>}
                <div className="flex items-center gap-2 mt-0.5">
                  {ghost.lifecycle_state && (
                    <Badge variant="outline" className="text-[10px]">
                      {ghost.lifecycle_state.replace(/_/g, " ")}
                    </Badge>
                  )}
                  {ghost.reengagement_attempt_count != null && ghost.reengagement_attempt_count > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {ghost.reengagement_attempt_count} attempt{ghost.reengagement_attempt_count !== 1 ? "s" : ""}
                    </span>
                  )}
                  {ghost.last_contacted_at && (
                    <span className="text-[10px] text-muted-foreground">
                      Last: {relativeTime(ghost.last_contacted_at)}
                    </span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-xs"
                disabled={resumingId === leadId}
                onClick={() => handleResume(leadId)}
              >
                {resumingId === leadId ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <Zap className="w-3.5 h-3.5 mr-1.5" />
                )}
                Re-engage
              </Button>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ─── HardStopsPanel ───────────────────────────────────────────────────────────

export function HardStopsPanel({ hardStops }: { hardStops: HardStop[] }) {
  if (hardStops.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <ShieldAlert className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No hard stops recorded.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Leads blocked by compliance, DNC, or duplicate detection appear here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {hardStops.length} lead{hardStops.length !== 1 ? "s" : ""} blocked — review before re-engagement
      </p>
      {hardStops.map((stop) => (
        <Card key={stop.id} className="overflow-hidden border-red-100">
          <CardContent className="p-3 flex items-start gap-3 flex-wrap">
            <ShieldAlert className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{stop.contactName}</p>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <Badge
                  variant="outline"
                  className="text-[10px] bg-red-50 text-red-700 border-red-200"
                >
                  {hardStopLabel(stop.reason)}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  Since {relativeTime(stop.blockedSince)}
                </span>
                {stop.canRetryAt && (
                  <span className="text-[10px] text-amber-600">
                    Retry: {new Date(stop.canRetryAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              {stop.reasonDetail && (
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{stop.reasonDetail}</p>
              )}
            </div>
            {stop.reason === "cooldown" && stop.canRetryAt && (
              <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 shrink-0 self-center">
                <Clock className="w-3 h-3 mr-1" />
                Cooldown
              </Badge>
            )}
            {stop.reason === "insufficient_qualification" && (
              <Badge variant="outline" className="text-[10px] bg-slate-50 text-slate-600 shrink-0 self-center">
                Not Qualified
              </Badge>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─── RetrainingSignalsPanel ───────────────────────────────────────────────────

export function RetrainingSignalsPanel({ signals }: { signals: RetrainingSignal[] }) {
  if (signals.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No retraining signals yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Patterns that indicate AI coaching improvements will appear here over time.
          </p>
        </CardContent>
      </Card>
    )
  }

  const byType = signals.reduce<Record<string, RetrainingSignal[]>>((acc, s) => {
    ;(acc[s.signalType] = acc[s.signalType] ?? []).push(s)
    return acc
  }, {})

  const typeLabel: Record<string, { label: string; color: string; icon: typeof Brain }> = {
    failed_objection:  { label: "Failed Objections", color: "text-red-600",    icon: AlertTriangle },
    coaching_insight:  { label: "Coaching Insights", color: "text-blue-600",   icon: Brain },
    tone_mismatch:     { label: "Tone Mismatches",   color: "text-amber-600",  icon: Sparkles },
    timing_error:      { label: "Timing Errors",     color: "text-purple-600", icon: Clock },
  }

  return (
    <ScrollArea className="h-[500px]">
      <div className="space-y-4 pr-2">
        {Object.entries(byType).map(([type, items]) => {
          const meta = typeLabel[type] ?? { label: type, color: "text-slate-600", icon: Brain }
          return (
            <div key={type}>
              <p className={`text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5 ${meta.color}`}>
                <meta.icon className="w-3.5 h-3.5" />
                {meta.label} ({items.length})
              </p>
              <div className="space-y-2">
                {items.map((signal) => (
                  <Card key={signal.id} className="overflow-hidden">
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className="text-sm font-medium leading-snug">{signal.title}</p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {signal.frequency > 1 && (
                            <Badge variant="secondary" className="text-[10px]">
                              ×{signal.frequency}
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${signal.impactScore >= 70 ? "text-red-700 bg-red-50 border-red-200" : signal.impactScore >= 40 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-slate-600"}`}
                          >
                            {signal.impactScore}% impact
                          </Badge>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{signal.description}</p>
                      {signal.suggestedImprovement && (
                        <div className="mt-2 rounded bg-green-50 border border-green-200 px-2 py-1.5">
                          <p className="text-[10px] font-semibold text-green-600 uppercase tracking-wide mb-0.5">
                            <CheckCircle2 className="w-3 h-3 inline mr-1" />
                            Suggested Improvement
                          </p>
                          <p className="text-xs text-green-900">{signal.suggestedImprovement}</p>
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1.5">{relativeTime(signal.createdAt)}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
