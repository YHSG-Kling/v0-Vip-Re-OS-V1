"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  BarChart3,
  TrendingUp,
  Users,
  Home,
  AlertTriangle,
  RefreshCw,
  ArrowRight,
  Mic,
  FileText,
  ChevronRight,
  CheckCircle2,
  Target,
  Sparkles,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"

type Period = "month" | "quarter" | "year"

interface ReportingData {
  period: string
  leadFunnel: {
    total: number
    qualified: number
    assigned: number
    converted: number
    topSources: { source: string; count: number }[]
  }
  isaPerformance: {
    outreachSent: number
    qualified: number
    appointmentsSet: number
    channelBreakdown: Record<string, number>
  }
  listingHealth: {
    active: number
    withOffers: number
    closedPeriod: number
    topActive: any[]
  }
  transactionHealth: {
    open: number
    atRisk: any[]
  }
  marketingPerformance: {
    totalSpend: number
    totalLeads: number
    totalConversions: number
    totalRevenue: number
  }
  stuckWork: {
    transactions: any[]
    staleLeads: any[]
    acceptedOffersNoTx: any[]
  }
}

// ── The AI team's read ────────────────────────────────────────────────────────
// Deterministic briefing composed from the SAME numbers the boxes below show —
// the dashboard reads itself to the agent instead of making them scan boxes.
// Pure math over fetched data: no LLM cost, nothing hallucinated, every line
// traces to a number on this page, every line lands on the surface that fixes it.

interface PipelineInsight {
  severity: "urgent" | "warn" | "good" | "info"
  text: string
  cta: string
  href: string
}

function composePipelineBriefing(data: ReportingData, periodLabel: string): PipelineInsight[] {
  const out: PipelineInsight[] = []
  const f = data.leadFunnel
  const isa = data.isaPerformance
  const mkt = data.marketingPerformance
  const stuckTx = data.stuckWork.transactions.length
  const stuckOffers = data.stuckWork.acceptedOffersNoTx.length
  const stuckLeads = data.stuckWork.staleLeads.length
  const stuckTotal = stuckTx + stuckOffers + stuckLeads

  if (stuckTotal > 0) {
    const parts = [
      stuckOffers > 0 ? `${stuckOffers} accepted offer${stuckOffers === 1 ? "" : "s"} with no transaction opened` : null,
      stuckTx > 0 ? `${stuckTx} transaction${stuckTx === 1 ? "" : "s"} gone quiet` : null,
      stuckLeads > 0 ? `${stuckLeads} qualified lead${stuckLeads === 1 ? "" : "s"} still unassigned` : null,
    ].filter(Boolean)
    out.push({
      severity: "urgent",
      text: `Money is sitting still: ${parts.join(", ")}. These are the first things your team would chase today.`,
      cta: "Work the stuck list",
      href: "#stuck-work",
    })
  }

  if (f.total >= 10 && f.qualified / f.total < 0.3) {
    out.push({
      severity: "warn",
      text: `Only ${Math.round((f.qualified / f.total) * 100)}% of ${f.total} leads qualified ${periodLabel.toLowerCase()} — the intake sources are feeding thin. Worth reviewing which sources earn their spot.`,
      cta: "Review lead sources",
      href: "/leads",
    })
  } else if (f.assigned >= 5 && f.converted === 0) {
    out.push({
      severity: "warn",
      text: `${f.assigned} leads assigned ${periodLabel.toLowerCase()} but none converted yet — follow-up is where this period's revenue is hiding.`,
      cta: "Open the funnel",
      href: "/leads",
    })
  }

  if (isa.outreachSent >= 20) {
    const rate = Math.round(((isa.appointmentsSet ?? 0) / isa.outreachSent) * 100)
    if (rate < 5) {
      out.push({
        severity: "warn",
        text: `Your AI ISA sent ${isa.outreachSent} touches for ${isa.appointmentsSet} appointment${isa.appointmentsSet === 1 ? "" : "s"} (${rate}%). The scripts may be stale — a few objection drills sharpen the openers.`,
        cta: "Drill objections",
        href: "/dashboard/coaching/practice",
      })
    } else {
      out.push({
        severity: "good",
        text: `AI ISA is earning its keep: ${isa.outreachSent} touches → ${isa.appointmentsSet} appointments (${rate}%) ${periodLabel.toLowerCase()}.`,
        cta: "See ISA detail",
        href: "/dashboard/voice/isa",
      })
    }
  }

  if (mkt.totalSpend > 0 && mkt.totalLeads === 0) {
    out.push({
      severity: "warn",
      text: `$${Math.round(mkt.totalSpend).toLocaleString()} of marketing spend produced zero leads ${periodLabel.toLowerCase()} — pause or retarget before it compounds.`,
      cta: "Open campaigns",
      href: "/dashboard/marketing",
    })
  } else if (mkt.totalSpend > 0 && mkt.totalRevenue > 0) {
    out.push({
      severity: "good",
      text: `Marketing returned ${(mkt.totalRevenue / mkt.totalSpend).toFixed(1)}x — $${Math.round(mkt.totalSpend).toLocaleString()} in, $${Math.round(mkt.totalRevenue).toLocaleString()} attributed back.`,
      cta: "Campaign ROI",
      href: "/dashboard/reports",
    })
  }

  if (data.listingHealth.withOffers > 0) {
    out.push({
      severity: "info",
      text: `${data.listingHealth.withOffers} active listing${data.listingHealth.withOffers === 1 ? "" : "s"} carrying live offers — momentum to protect this week.`,
      cta: "Open listings",
      href: "/dashboard/listings",
    })
  }

  const rank = { urgent: 0, warn: 1, good: 2, info: 3 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 4)
}

export function ReportingClient() {
  const [period, setPeriod] = useState<Period>("month")
  const [data, setData] = useState<ReportingData | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/dashboard/reporting?period=${period}`)
      if (res.ok) setData(await res.json())
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const periodLabel = { month: "This Month", quarter: "This Quarter", year: "This Year" }[period]

  // Funnel conversion rates
  const f = data?.leadFunnel
  const qualifyRate = f?.total ? Math.round((f.qualified / f.total) * 100) : 0
  const assignRate = f?.total ? Math.round((f.assigned / f.total) * 100) : 0
  const convertRate = f?.total ? Math.round((f.converted / f.total) * 100) : 0

  // ISA appt rate
  const isa = data?.isaPerformance
  const apptRate = isa?.outreachSent ? Math.round(((isa.appointmentsSet ?? 0) / isa.outreachSent) * 100) : 0

  const stuckTotal =
    (data?.stuckWork.transactions.length ?? 0) +
    (data?.stuckWork.staleLeads.length ?? 0) +
    (data?.stuckWork.acceptedOffersNoTx.length ?? 0)

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card px-4 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground text-balance">
              Reporting Command Center
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Full-stack view of acquisition, ISA, listings, transactions, and marketing.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Select
              value={period}
              onValueChange={(v) => setPeriod(v as Period)}
            >
              <SelectTrigger className="w-36 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">This Month</SelectItem>
                <SelectItem value="quarter">This Quarter</SelectItem>
                <SelectItem value="year">This Year</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Top KPI bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {loading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)
          ) : (
            <>
              <KpiTile icon={Users} label="Total Leads" value={data?.leadFunnel.total ?? 0} sub={periodLabel} />
              <KpiTile icon={Target} label="Converted" value={data?.leadFunnel.converted ?? 0} sub={`${convertRate}% rate`} />
              <KpiTile icon={Home} label="Active Listings" value={data?.listingHealth.active ?? 0} sub={`${data?.listingHealth.withOffers ?? 0} with offers`} />
              <KpiTile
                icon={AlertTriangle}
                label="Stuck Work"
                value={stuckTotal}
                sub="cross-domain"
                urgent={stuckTotal > 0}
              />
            </>
          )}
        </div>

        {/* The AI team's read — the numbers below, already read for you */}
        {!loading && data && (() => {
          const insights = composePipelineBriefing(data, periodLabel)
          const SEVERITY_STYLE: Record<string, string> = {
            urgent: "border-red-200 bg-red-50/60",
            warn:   "border-amber-200 bg-amber-50/60",
            good:   "border-emerald-200 bg-emerald-50/60",
            info:   "border-border bg-muted/30",
          }
          const SEVERITY_DOT: Record<string, string> = {
            urgent: "bg-red-500", warn: "bg-amber-500", good: "bg-emerald-500", info: "bg-slate-400",
          }
          return (
            <Card className="border-indigo-200">
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-5 w-5 text-indigo-600" />
                  Your AI team&apos;s read
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    every line traces to a number on this page
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {insights.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not enough activity {periodLabel.toLowerCase()} to brief on yet — as leads, offers,
                    and campaigns flow, your AI team&apos;s read shows up here first.
                  </p>
                ) : (
                  insights.map((ins, i) => (
                    <div key={i} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 ${SEVERITY_STYLE[ins.severity]}`}>
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[ins.severity]}`} />
                        <p className="text-sm text-foreground leading-relaxed">{ins.text}</p>
                      </div>
                      <Link href={ins.href} className="shrink-0">
                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1">
                          {ins.cta}
                          <ArrowRight className="h-3 w-3" />
                        </Button>
                      </Link>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )
        })()}

        {/* Lead Acquisition Funnel */}
        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-5 w-5 text-primary" />
              Lead Acquisition Funnel
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 sm:p-6 space-y-4">
            {loading ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <FunnelStep label="New Leads" count={data?.leadFunnel.total ?? 0} pct={100} color="bg-blue-500" />
                  <FunnelStep label="Qualified" count={data?.leadFunnel.qualified ?? 0} pct={qualifyRate} color="bg-indigo-500" />
                  <FunnelStep label="Assigned" count={data?.leadFunnel.assigned ?? 0} pct={assignRate} color="bg-violet-500" />
                  <FunnelStep label="Converted" count={data?.leadFunnel.converted ?? 0} pct={convertRate} color="bg-emerald-500" />
                </div>
                {data?.leadFunnel.topSources && data.leadFunnel.topSources.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Top Sources
                    </p>
                    <div className="space-y-2">
                      {data.leadFunnel.topSources.map((s) => (
                        <div key={s.source} className="flex items-center gap-3">
                          <span className="text-sm text-foreground w-28 truncate">{s.source}</span>
                          <div className="flex-1">
                            <Progress
                              value={data.leadFunnel.total ? (s.count / data.leadFunnel.total) * 100 : 0}
                              className="h-2"
                            />
                          </div>
                          <span className="text-sm font-medium text-foreground w-8 text-right">{s.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* AI-ISA Performance */}
        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Mic className="h-5 w-5 text-primary" />
                AI-ISA Performance
              </CardTitle>
              <Link href="/dashboard/voice/isa">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  View ISA <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            {loading ? (
              <div className="grid grid-cols-3 gap-3">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 rounded" />)}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <IsaTile label="Outreach Sent" value={data?.isaPerformance.outreachSent ?? 0} />
                  <IsaTile label="Qualified" value={data?.isaPerformance.qualified ?? 0} />
                  <IsaTile label="Appts Set" value={data?.isaPerformance.appointmentsSet ?? 0} highlight />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">Appointment rate</span>
                    <span className="text-xs font-semibold text-foreground">{apptRate}%</span>
                  </div>
                  <Progress value={apptRate} className="h-2" />
                </div>
                {data?.isaPerformance.channelBreakdown &&
                  Object.keys(data.isaPerformance.channelBreakdown).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(data.isaPerformance.channelBreakdown).map(([ch, count]) => (
                        <Badge key={ch} variant="outline" className="text-xs">
                          {ch}: {count}
                        </Badge>
                      ))}
                    </div>
                  )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Listing / Transaction Health side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Listing Health */}
          <Card className="border-border">
            <CardHeader className="border-b border-border pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Home className="h-5 w-5 text-primary" />
                  Listing Health
                </CardTitle>
                <Link href="/dashboard/listings">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    View <ChevronRight className="h-3 w-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {loading ? (
                <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8 rounded" />)}</div>
              ) : (
                <>
                  <div className="grid grid-cols-3 divide-x divide-border text-center">
                    <div className="pr-2">
                      <p className="text-xl font-bold text-foreground">{data?.listingHealth.active ?? 0}</p>
                      <p className="text-xs text-muted-foreground">Active</p>
                    </div>
                    <div className="px-2">
                      <p className="text-xl font-bold text-amber-600">{data?.listingHealth.withOffers ?? 0}</p>
                      <p className="text-xs text-muted-foreground">With Offers</p>
                    </div>
                    <div className="pl-2">
                      <p className="text-xl font-bold text-emerald-600">{data?.listingHealth.closedPeriod ?? 0}</p>
                      <p className="text-xs text-muted-foreground">Closed</p>
                    </div>
                  </div>
                  {data?.listingHealth.topActive.map((l) => (
                    <Link key={l.id} href={`/dashboard/listings/${l.id}`}>
                      <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent transition-colors cursor-pointer">
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate">{l.address}</p>
                          <p className="text-xs text-muted-foreground">
                            ${Number(l.list_price).toLocaleString()} · {l.showing_count ?? 0} showings
                          </p>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      </div>
                    </Link>
                  ))}
                </>
              )}
            </CardContent>
          </Card>

          {/* Transaction Health */}
          <Card className="border-border">
            <CardHeader className="border-b border-border pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-5 w-5 text-primary" />
                  Transaction Health
                </CardTitle>
                <Link href="/dashboard/transactions">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    View <ChevronRight className="h-3 w-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {loading ? (
                <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8 rounded" />)}</div>
              ) : (
                <>
                  <div className="flex items-center gap-4 mb-2">
                    <div>
                      <p className="text-xl font-bold text-foreground">{data?.transactionHealth.open ?? 0}</p>
                      <p className="text-xs text-muted-foreground">Open</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold text-red-600">{data?.transactionHealth.atRisk.length ?? 0}</p>
                      <p className="text-xs text-muted-foreground">At Risk (score &lt; 50)</p>
                    </div>
                  </div>
                  {(data?.transactionHealth.atRisk ?? []).slice(0, 4).map((tx) => (
                    <Link key={tx.id} href={`/dashboard/transactions/${tx.id}`}>
                      <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent transition-colors cursor-pointer">
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate">{tx.deal_name ?? tx.property_address}</p>
                          <p className="text-xs text-muted-foreground">
                            Health: {tx.health_score} · {tx.stage ?? tx.status}
                          </p>
                        </div>
                        <Badge variant="destructive" className="text-xs shrink-0">{tx.health_score}</Badge>
                      </div>
                    </Link>
                  ))}
                  {(data?.transactionHealth.atRisk.length ?? 0) === 0 && (
                    <p className="text-xs text-muted-foreground py-2">No at-risk transactions.</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Marketing Performance */}
        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-5 w-5 text-primary" />
              Marketing Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded" />)}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <MarketingTile
                  label="Total Spend"
                  value={`$${Math.round(data?.marketingPerformance.totalSpend ?? 0).toLocaleString()}`}
                />
                <MarketingTile
                  label="Leads Generated"
                  value={(data?.marketingPerformance.totalLeads ?? 0).toString()}
                />
                <MarketingTile
                  label="Conversions"
                  value={(data?.marketingPerformance.totalConversions ?? 0).toString()}
                />
                <MarketingTile
                  label="Revenue Attributed"
                  value={`$${Math.round(data?.marketingPerformance.totalRevenue ?? 0).toLocaleString()}`}
                  highlight
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cross-domain stuck work */}
        <Card className="border-border scroll-mt-6" id="stuck-work">
          <CardHeader className="border-b border-border pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
                Cross-Domain Stuck Work
              </CardTitle>
              {stuckTotal > 0 && (
                <Badge variant="destructive">{stuckTotal} items</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-3">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}
              </div>
            ) : stuckTotal === 0 ? (
              <div className="py-8 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No cross-domain stuck work.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {(data?.stuckWork.staleLeads ?? []).map((lead) => (
                  <StuckRow
                    key={lead.id}
                    label={`${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "Lead"}
                    sub={`Qualified ${formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })} — unassigned`}
                    href="/leads"
                    category="lead"
                  />
                ))}
                {(data?.stuckWork.acceptedOffersNoTx ?? []).map((offer) => (
                  <StuckRow
                    key={offer.id}
                    label={offer.listing?.address ?? "Accepted Offer"}
                    sub={`$${Number(offer.offer_price).toLocaleString()} — no transaction created`}
                    href="/dashboard/transactions"
                    category="offer"
                  />
                ))}
                {(data?.stuckWork.transactions ?? []).map((tx) => (
                  <StuckRow
                    key={tx.id}
                    label={tx.deal_name ?? tx.property_address ?? "Transaction"}
                    sub={`${tx.stage ?? tx.status} — no update ${formatDistanceToNow(new Date(tx.updated_at), { addSuffix: true })}`}
                    href={`/dashboard/transactions/${tx.id}`}
                    category="transaction"
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiTile({
  icon: Icon,
  label,
  value,
  sub,
  urgent,
}: {
  icon: any
  label: string
  value: number
  sub?: string
  urgent?: boolean
}) {
  return (
    <Card className={`border-border ${urgent && value > 0 ? "ring-1 ring-red-400" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground leading-tight truncate">{label}</p>
            <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <Icon className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        </div>
      </CardContent>
    </Card>
  )
}

function FunnelStep({
  label,
  count,
  pct,
  color,
}: {
  label: string
  count: number
  pct: number
  color: string
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold text-foreground">{count}</p>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{pct}%</p>
    </div>
  )
}

function IsaTile({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className="p-3 rounded-lg border border-border text-center">
      <p className={`text-2xl font-bold ${highlight ? "text-primary" : "text-foreground"}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}

function MarketingTile({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="p-3 sm:p-4 rounded-lg border border-border">
      <p className={`text-xl font-bold ${highlight ? "text-primary" : "text-foreground"}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}

function StuckRow({
  label,
  sub,
  href,
  category,
}: {
  label: string
  sub: string
  href: string
  category: "lead" | "offer" | "transaction"
}) {
  const catColors: Record<string, string> = {
    lead: "bg-blue-50 text-blue-700 border-blue-200",
    offer: "bg-amber-50 text-amber-700 border-amber-200",
    transaction: "bg-red-50 text-red-700 border-red-200",
  }
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{label}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="outline" className={`text-xs ${catColors[category]}`}>
          {category}
        </Badge>
        <Link href={href}>
          <Button size="sm" variant="outline" className="h-8">
            Fix
          </Button>
        </Link>
      </div>
    </div>
  )
}
