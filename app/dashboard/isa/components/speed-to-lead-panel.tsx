// app/dashboard/isa/components/speed-to-lead-panel.tsx
//
// Speed-to-Lead KPI strip — surfaces the m228 first-touch truth so the agent SEES that
// every lead/contact is getting a fast, automatic first touch (and who is still waiting).
// Presentational: fed real metrics from getSpeedToLeadMetrics.
//
// Lane 90C (89D P2-8 + §7): the SLA meter is now PER CHANNEL, and the strip carries the
// three proof numbers competitors publish (response rate, connect rate, days of
// follow-up) read from the ledgers this OS already writes. `IsaProofNumbersStrip` is
// exported on its own so the Brokerage Intelligence page renders the SAME numbers from
// the SAME reader (one reader, two surfaces — §6). A refused ledger read is SAID, never
// rendered as a clean zero.

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Zap, Clock, Mail, MessageSquare, Phone, Mailbox, Inbox, Reply, PhoneCall, CalendarRange, AlertTriangle } from "lucide-react"
import type { SpeedToLeadMetrics } from "@/app/actions/ai-isa/speed-to-lead-metrics"
import type { IsaProofNumbers, RateNumber } from "@/lib/ai-isa/speed-to-lead-policy"

function humanizeSeconds(s: number | null): string {
  if (s === null) return "—"
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function pct(r: RateNumber | { rate: number | null }): string {
  return r.rate === null ? "—" : `${Math.round(r.rate * 100)}%`
}

const CHANNEL_META: Record<string, { label: string; icon: typeof Mail }> = {
  email: { label: "Email", icon: Mail },
  sms: { label: "SMS", icon: MessageSquare },
  phone: { label: "Phone", icon: Phone },
  voice: { label: "Voice", icon: Phone },
  direct_mail: { label: "Direct Mail", icon: Mailbox },
  unknown: { label: "Other", icon: Inbox },
}

/** The three published numbers — one strip, two surfaces. */
export function IsaProofNumbersStrip({ proof, refused, compact = false }: { proof: IsaProofNumbers; refused?: string[]; compact?: boolean }) {
  const byChannel = Object.entries(proof.responseRateByChannel).sort((a, b) => b[1].denominator - a[1].denominator).slice(0, 4)
  const fu = proof.followUp
  return (
    <div className="space-y-2">
      <div className={`grid gap-3 ${compact ? "grid-cols-3" : "grid-cols-1 md:grid-cols-3"}`}>
        <div className="rounded-lg bg-white border p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 mb-1">
            <Reply className="w-3 h-3" /> Response rate
          </div>
          <p className="text-2xl font-bold leading-none">{pct(proof.responseRate)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {proof.responseRate.numerator} of {proof.responseRate.denominator} people reached wrote back
          </p>
          {!compact && byChannel.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {byChannel.map(([ch, r]) => (
                <Badge key={ch} variant="outline" className="text-[10px] font-normal">
                  {(CHANNEL_META[ch] ?? CHANNEL_META.unknown).label} {pct(r)}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg bg-white border p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-600 mb-1">
            <PhoneCall className="w-3 h-3" /> Connect rate
          </div>
          <p className="text-2xl font-bold leading-none">{pct(proof.connectRate)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {proof.connectRate.numerator} of {proof.connectRate.denominator} AI calls reached a person
          </p>
        </div>
        <div className="rounded-lg bg-white border p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 mb-1">
            <CalendarRange className="w-3 h-3" /> Days of follow-up
          </div>
          <p className="text-2xl font-bold leading-none">{fu.medianDays === null ? "—" : `${fu.medianDays}d`}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {fu.personsWithFollowUp > 0
              ? `median across ${fu.personsWithFollowUp} followed up${fu.maxDays !== null ? ` · longest ${fu.maxDays}d` : ""}`
              : "no one has had a second touch yet"}
            {" · "}ladder: {fu.policy.phase1WindowDays}d active, then every {fu.policy.phase2SpacingDays}d, then every {fu.policy.phase3SpacingDays}d — never stops
          </p>
        </div>
      </div>
      {refused && refused.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>Some ledgers refused to read, so these numbers are partial: {refused.join("; ")}</span>
        </p>
      )}
    </div>
  )
}

export function SpeedToLeadPanel({ metrics }: { metrics: SpeedToLeadMetrics }) {
  const { awaitingLeads, awaitingContacts, recent } = metrics
  const awaiting = awaitingLeads + awaitingContacts
  const slaPct = recent.pctWithinSla === null ? null : Math.round(recent.pctWithinSla * 100)
  const slaColor =
    slaPct === null ? "text-muted-foreground"
    : slaPct >= 90 ? "text-green-600"
    : slaPct >= 70 ? "text-amber-600"
    : "text-red-600"

  const channelChips = Object.entries(recent.channelBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  // Per-channel SLA meter (lane 90C): median first touch + SLA share on each channel.
  const perChannel = Object.entries(recent.perChannel)
    .sort((a, b) => b[1].touchedCount - a[1].touchedCount)
    .slice(0, 5)

  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-semibold text-indigo-900">Speed-to-Lead</h2>
          <span className="text-xs text-muted-foreground">automatic first touch · last 7 days</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Awaiting first touch */}
          <div className="rounded-lg bg-white border p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500 mb-1">
              <Inbox className="w-3 h-3" /> Awaiting First Touch
            </div>
            <p className="text-2xl font-bold leading-none">{awaiting}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {awaitingLeads} lead{awaitingLeads === 1 ? "" : "s"} · {awaitingContacts} contact
              {awaitingContacts === 1 ? "" : "s"}
            </p>
          </div>

          {/* Median time to first touch */}
          <div className="rounded-lg bg-white border p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-500 mb-1">
              <Clock className="w-3 h-3" /> Median First Touch
            </div>
            <p className="text-2xl font-bold leading-none">{humanizeSeconds(recent.medianSeconds)}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{recent.touchedCount} touched</p>
          </div>

          {/* % within 5-min SLA */}
          <div className="rounded-lg bg-white border p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-green-500 mb-1">
              <Zap className="w-3 h-3" /> Within 5 Min
            </div>
            <p className={`text-2xl font-bold leading-none ${slaColor}`}>
              {slaPct === null ? "—" : `${slaPct}%`}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">SLA met</p>
          </div>

          {/* Channel mix */}
          <div className="rounded-lg bg-white border p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500 mb-1.5">
              Channels Used
            </div>
            {channelChips.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {channelChips.map(([ch, n]) => {
                  const meta = CHANNEL_META[ch] ?? CHANNEL_META.unknown
                  const Icon = meta.icon
                  return (
                    <Badge key={ch} variant="outline" className="text-[10px] gap-1 font-normal">
                      <Icon className="w-3 h-3" />
                      {meta.label} {n}
                    </Badge>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* SLA per channel — first-response seconds per lead, per channel (89D P2-8) */}
        {perChannel.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500 mr-1">SLA by channel</span>
            {perChannel.map(([ch, s]) => {
              const meta = CHANNEL_META[ch] ?? CHANNEL_META.unknown
              const Icon = meta.icon
              return (
                <Badge key={ch} variant="outline" className="text-[10px] gap-1 font-normal bg-white">
                  <Icon className="w-3 h-3" />
                  {meta.label}: {humanizeSeconds(s.medianSeconds)} median · {pct({ rate: s.pctWithinSla })} within 5 min · {s.touchedCount}
                </Badge>
              )
            })}
          </div>
        )}

        {/* The three proof numbers — the same strip the Intelligence Center shows */}
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold text-indigo-900">Proof numbers</h3>
            <span className="text-[11px] text-muted-foreground">last 30 days · what your ISA can be held to</span>
            <Link href="/dashboard/isa/analytics" className="text-[11px] text-indigo-600 underline ml-auto">Analytics</Link>
          </div>
          <IsaProofNumbersStrip proof={metrics.proof} refused={metrics.refused} />
        </div>
      </CardContent>
    </Card>
  )
}
