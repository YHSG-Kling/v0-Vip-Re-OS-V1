"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sparkles,
  TrendingUp,
  Clock,
  Trophy,
  DollarSign,
  ArrowRight,
  Calendar,
  Users,
  Mic2,
} from "lucide-react"
import type { RoiSnapshot } from "./actions"

const dollars = (cents: number) => {
  const d = cents / 100
  if (d >= 1000) return `$${(d / 1000).toFixed(1)}k`
  return `$${d.toFixed(0)}`
}
const hoursOf = (minutes: number) => {
  if (minutes === 0) return "0h"
  if (minutes < 60) return `${minutes}m`
  const h = minutes / 60
  return `${h >= 10 ? h.toFixed(0) : h.toFixed(1)}h`
}
const relative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

interface Props { snapshot: RoiSnapshot }

export function AgentRoiClient({ snapshot }: Props) {
  const router = useRouter()
  const sp     = useSearchParams()
  const period = sp.get("period") ?? snapshot.period
  const setPeriod = (p: string) => {
    const params = new URLSearchParams(sp)
    params.set("period", p)
    router.push(`/dashboard/agent/roi?${params.toString()}`)
  }
  const periodLabel = period === "7d" ? "last 7 days" : period === "30d" ? "last 30 days" : "year to date"

  const isZeroState = snapshot.totalValueDollars === 0 && snapshot.byFeature.length === 0

  return (
    <div className="container max-w-5xl mx-auto py-8 px-4">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {snapshot.agentName ? `${snapshot.agentName}, here's what your AI did for you.` : "Here's what your AI did for you."}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every dollar of revenue and every hour saved — measured, not promised. Showing the {periodLabel}.
        </p>
      </div>

      <Tabs value={period} onValueChange={setPeriod} className="mb-6">
        <TabsList>
          <TabsTrigger value="7d">Last 7 days</TabsTrigger>
          <TabsTrigger value="30d">Last 30 days</TabsTrigger>
          <TabsTrigger value="ytd">Year to date</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ── Hero numbers ─────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <Card className="border-emerald-200 bg-emerald-50/40">
          <CardContent className="py-5">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-4 w-4 text-emerald-600" />
              <span className="text-xs uppercase tracking-wide text-emerald-700 font-medium">
                Revenue attributed
              </span>
            </div>
            <p className="text-3xl font-bold text-emerald-900">{dollars(snapshot.attributedRevenueCents)}</p>
            <p className="text-xs text-emerald-950/70 mt-1">
              From AI-influenced deals across all campaign attribution models (linear).
            </p>
          </CardContent>
        </Card>
        <Card className="border-blue-200 bg-blue-50/40">
          <CardContent className="py-5">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-blue-600" />
              <span className="text-xs uppercase tracking-wide text-blue-700 font-medium">
                Time you got back
              </span>
            </div>
            <p className="text-3xl font-bold text-blue-900">{hoursOf(snapshot.estimatedTimeSavedMinutes)}</p>
            <p className="text-xs text-blue-950/70 mt-1">
              Worth ~{dollars(snapshot.estimatedTimeSavedDollars)} at your effective hourly rate.
            </p>
          </CardContent>
        </Card>
        <Card className="border-indigo-200 bg-indigo-50/40">
          <CardContent className="py-5">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-indigo-600" />
              <span className="text-xs uppercase tracking-wide text-indigo-700 font-medium">
                Total value
              </span>
            </div>
            <p className="text-3xl font-bold text-indigo-900">{dollars(snapshot.totalValueDollars)}</p>
            <p className="text-xs text-indigo-950/70 mt-1">
              Revenue + the dollar value of the hours your AI saved you.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Zero state guidance ──────────────────────────────────────────── */}
      {isZeroState && (
        <Card className="mb-8 border-dashed">
          <CardContent className="py-6 text-center space-y-2">
            <p className="text-sm font-medium">No AI activity in this window yet.</p>
            <p className="text-xs text-muted-foreground">
              Numbers fill in as your AI sets appointments, drafts replies, builds presentations,
              and runs campaigns for you. Start at your <Link href="/dashboard/agent/first-deal" className="text-indigo-700 hover:underline">First Deal</Link> wizard
              or kick off the <Link href="/dashboard/isa" className="text-indigo-700 hover:underline">AI ISA</Link>.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Per-feature breakdown ────────────────────────────────────────── */}
      {snapshot.byFeature.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3">Where the value came from</h2>
          <div className="grid gap-2">
            {snapshot.byFeature.map(f => (
              <Card key={f.featureKey}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{f.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {f.eventCount} event{f.eventCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="text-right">
                      <Badge variant="outline" className="text-xs">
                        {hoursOf(f.timeSavedMinutes)} saved
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── 90-day forecast ─────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-indigo-600" /> What's coming in the next 90 days
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                Pipeline value
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-semibold">{dollars(snapshot.pipeline.pipelineCommissionCents)}</p>
              <p className="text-xs text-muted-foreground">
                across {snapshot.pipeline.activeTransactions} active transaction{snapshot.pipeline.activeTransactions === 1 ? "" : "s"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                Sphere touchpoints
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-semibold">{snapshot.pipeline.upcomingSphereTouchpoints}</p>
              <p className="text-xs text-muted-foreground">
                AI will reach out to your past clients without you lifting a finger.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                ISA appointments this period
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-semibold">{snapshot.pipeline.isaAppointmentsBooked}</p>
              <p className="text-xs text-muted-foreground">
                Booked by your AI ISA — you just show up.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Recent wins timeline ────────────────────────────────────────── */}
      {snapshot.recentWins.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-600" /> Recent wins
          </h2>
          <div className="space-y-2">
            {snapshot.recentWins.map((w, i) => (
              <Card key={i}>
                <CardContent className="py-3 px-4 flex items-center gap-3">
                  <IconFor feature={w.featureKey} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{w.headline}</p>
                    <p className="text-xs text-muted-foreground">{relative(w.happenedAt)}</p>
                  </div>
                  {w.valueCents != null && w.valueCents > 0 && (
                    <Badge className="bg-emerald-600 text-white">{dollars(w.valueCents)}</Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── How attribution works (transparency) ─────────────────────────── */}
      <Card className="bg-muted/30">
        <CardContent className="py-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            <strong>How we calculate this.</strong> Revenue attribution uses the linear model across
            every campaign that touched a closed deal — credit splits evenly across the touchpoints
            in the journey. Time saved is the realistic manual-work equivalent of each AI action
            (e.g. a CMA + presentation deck = 3 hours of agent work; an AI-set appointment = 45
            minutes of call coordination). Your hourly value is derived from your closed-deal
            average, defaulting to the residential agent median when you have no closed deals yet.
            Want to see the same numbers as a brokerage roll-up? Ask your broker about the
            campaign ROI dashboard.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function IconFor({ feature }: { feature: string }) {
  if (feature === "ai_isa_appointment_set") return <Mic2 className="h-4 w-4 text-purple-600 shrink-0" />
  if (feature === "deal_close")             return <DollarSign className="h-4 w-4 text-emerald-600 shrink-0" />
  if (feature === "sphere_touchpoint_sent") return <Users className="h-4 w-4 text-amber-600 shrink-0" />
  return <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
}
