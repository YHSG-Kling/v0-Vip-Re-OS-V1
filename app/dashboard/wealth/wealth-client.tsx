"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import {
  TrendingUp, Send, X, CheckCircle2, Loader2, Sparkles, DollarSign, Percent,
  Home, ArrowDownToLine, Repeat, RefreshCcw, Building2, Trophy, User as UserIcon,
  Mail, Phone,
} from "lucide-react"
import { markWealthActed, dismissWealthOpportunity, pushWealthToPortal, type WealthRow, type WealthLoad } from "./actions"

interface Props {
  data: WealthLoad
}

const dollars = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`
const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${Math.round(n)}%`
const bpsToPct = (bps: number | null | undefined) =>
  bps == null ? "—" : `${(bps / 100).toFixed(2)}%`

const OPP_META: Record<string, { label: string; icon: any; tone: string; description: string }> = {
  refinance_opportunity:    { label: "Refinance",       icon: RefreshCcw,    tone: "indigo",  description: "Rate gap means real monthly savings" },
  cash_out_refi:            { label: "Cash-out refi",   icon: ArrowDownToLine, tone: "emerald", description: "Pull equity out for renovations, debt payoff, or investment" },
  heloc_for_investment:     { label: "HELOC",           icon: Repeat,        tone: "violet",  description: "Tap equity as a flexible credit line" },
  sell_and_1031_exchange:   { label: "Sell + 1031",     icon: Building2,     tone: "amber",   description: "Investor-grade move: trade up tax-deferred" },
  downsize_and_bank_equity: { label: "Downsize",        icon: Home,          tone: "sky",     description: "Sell big home, bank equity, simplify" },
  equity_milestone:         { label: "Equity milestone",icon: Trophy,        tone: "rose",    description: "Crossed a major equity threshold — worth a check-in" },
}

export function WealthClient({ data }: Props) {
  const router = useRouter()
  const types = Object.keys(data.byType)

  return (
    <div className="container max-w-5xl mx-auto py-6 px-4">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 mb-1">
          <TrendingUp className="h-3 w-3" /> Wealth Opportunities
        </p>
        <h1 className="text-2xl font-bold tracking-tight">Equity-driven opportunities in your book</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Past clients whose homes have appreciated to a point where a refi, cash-out, HELOC, 1031, or downsize is worth a conversation. Refreshes daily.
        </p>
      </div>

      {/* Aggregate banner */}
      <Card className="mb-6 border-emerald-200 bg-emerald-50/30">
        <CardContent className="py-4 flex items-center gap-4 flex-wrap">
          <div>
            <p className="text-2xl font-bold leading-none text-emerald-700">{data.total}</p>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">Active opportunities</p>
          </div>
          {types.length > 0 && (
            <>
              <div className="h-8 border-l" />
              <div className="flex gap-3 flex-wrap text-xs">
                {types.map(t => {
                  const meta = OPP_META[t] ?? { label: t, icon: TrendingUp }
                  const Icon = meta.icon
                  return (
                    <span key={t} className="flex items-center gap-1">
                      <Icon className="h-3 w-3" /> {meta.label}: <b>{data.byType[t].length}</b>
                    </span>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {data.total === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center space-y-2">
            <TrendingUp className="h-10 w-10 text-emerald-600 mx-auto" />
            <p className="text-base font-medium">No active wealth opportunities right now.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              The daily scan looks at every past client&apos;s current home value vs. their purchase price + rate. When equity or rate gap crosses a threshold, you&apos;ll see actionable cards here.
            </p>
          </CardContent>
        </Card>
      )}

      {types.map(t => {
        const meta = OPP_META[t] ?? { label: t, icon: TrendingUp, tone: "slate", description: "" }
        const Icon = meta.icon
        return (
          <section key={t} className="mb-8">
            <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Icon className="h-4 w-4 text-indigo-600" /> {meta.label} ({data.byType[t].length})
            </h2>
            {meta.description && <p className="text-xs text-muted-foreground mb-3">{meta.description}</p>}
            <div className="space-y-3">
              {data.byType[t].map(row => (
                <WealthCard key={row.id} row={row} onRefresh={() => router.refresh()} />
              ))}
            </div>
          </section>
        )
      })}

      {data.acted.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2 text-muted-foreground">
            Recent history
          </h2>
          <Card>
            <CardContent className="py-3 divide-y">
              {data.acted.slice(0, 20).map(row => (
                <div key={row.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{row.contactName}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {OPP_META[row.opportunityType]?.label ?? row.opportunityType} · {row.status}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[9px] shrink-0">{row.status}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}

function WealthCard({ row, onRefresh }: { row: WealthRow; onRefresh: () => void }) {
  const [pending, startTransition] = useTransition()
  const [dismissOpen, setDismissOpen] = useState(false)
  const [dismissReason, setDismissReason] = useState("")

  function handleActed() {
    startTransition(async () => {
      const r = await markWealthActed(row.id)
      if (r.success) { toast.success("Marked as acted"); onRefresh() } else toast.error(r.error ?? "Failed")
    })
  }
  function handleDismiss() {
    startTransition(async () => {
      const r = await dismissWealthOpportunity(row.id, dismissReason)
      if (r.success) { toast.success("Dismissed"); onRefresh() } else toast.error(r.error ?? "Failed")
    })
  }
  function handlePush() {
    startTransition(async () => {
      const r = await pushWealthToPortal(row.id)
      if (r.success) { toast.success("Pushed to client portal"); onRefresh() } else toast.error(r.error ?? "Failed")
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2 flex-wrap">
          <UserIcon className="h-4 w-4 text-indigo-600 shrink-0" />
          <span className="truncate">{row.contactName}</span>
          {row.pushedToPortalAt && <Badge className="bg-emerald-600 text-[10px]">Pushed to portal</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
          {row.contactEmail && <span className="flex items-center gap-0.5"><Mail className="h-3 w-3" /> {row.contactEmail}</span>}
          {row.contactPhone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" /> {row.contactPhone}</span>}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Key metrics strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {row.currentAvmValue != null && (
            <Metric label="Home value" value={dollars(row.currentAvmValue)} icon={Home} />
          )}
          {row.estimatedEquity != null && (
            <Metric label="Equity" value={dollars(row.estimatedEquity)} subtext={row.equityPct != null ? `${pct(row.equityPct)} of value` : undefined} icon={DollarSign} />
          )}
          {row.monthlySavingsEstimate != null && (
            <Metric label="Monthly savings" value={dollars(row.monthlySavingsEstimate)} icon={TrendingUp} />
          )}
          {row.oneTimeProceedsEstimate != null && (
            <Metric label="Est. proceeds" value={dollars(row.oneTimeProceedsEstimate)} icon={DollarSign} />
          )}
          {row.rateGapBps != null && row.rateGapBps > 0 && (
            <Metric
              label="Rate gap"
              value={bpsToPct(row.rateGapBps)}
              subtext={
                row.estimatedLockedRateBps != null && row.currentMarketRateBps != null
                  ? `${bpsToPct(row.estimatedLockedRateBps)} → ${bpsToPct(row.currentMarketRateBps)}`
                  : undefined
              }
              icon={Percent}
            />
          )}
        </div>

        {row.aiNarrative && (
          <div className="text-sm leading-relaxed bg-indigo-50/40 border border-indigo-200 rounded p-3">
            <Sparkles className="h-3 w-3 inline mr-1 text-indigo-600" />
            {row.aiNarrative}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleActed} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
            Mark acted
          </Button>
          {!row.pushedToPortalAt && (
            <Button size="sm" variant="outline" onClick={handlePush} disabled={pending}>
              <Send className="h-3 w-3 mr-1" /> Push to client portal
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDismissOpen(v => !v)} disabled={pending}>
            <X className="h-3 w-3 mr-1" /> Dismiss
          </Button>
        </div>

        {dismissOpen && (
          <div className="border rounded p-2 bg-slate-50 space-y-2">
            <p className="text-xs text-muted-foreground">Reason (helps the AI learn — optional)</p>
            <Textarea
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder="e.g. client just refinanced last month, no longer owns property"
              rows={2}
              className="text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleDismiss} disabled={pending}>
                {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null} Confirm dismiss
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDismissOpen(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, subtext, icon: Icon }: { label: string; value: string; subtext?: string; icon: any }) {
  return (
    <div className="border rounded p-2 bg-slate-50/50">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Icon className="h-2.5 w-2.5" /> {label}
      </p>
      <p className="font-bold mt-0.5">{value}</p>
      {subtext && <p className="text-[9px] text-muted-foreground">{subtext}</p>}
    </div>
  )
}
