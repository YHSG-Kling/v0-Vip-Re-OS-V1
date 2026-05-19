"use client"

/**
 * <LifetimeNpvPanel> — NPV-ranked sphere panel for /lifetime-customers.
 *
 * Replaces the agent's guesswork about who to call this month with a
 * calibrated 5-year referral GCI value per contact, plus the tier, the
 * recommended action, and the next-touchpoint due date.
 *
 * Tier visuals: platinum → 💎, gold → ⭐, silver → ◆, bronze → ◇,
 * dormant → ○ — so the agent can scan the list at a glance.
 */

import { useState, type ReactElement } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Loader2,
  RefreshCw,
  Crown,
  Star,
  Circle,
  TrendingUp,
  TrendingDown,
  ArrowRight,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  rescanLifetimeNpvForecastAction,
  type NpvRow,
  type NpvTier,
} from "@/app/actions/lifetime-npv"

interface Props {
  rows:        NpvRow[]
  agentUserId: string
  brokerageId: string
}

const TIER_STYLE: Record<NpvTier, { label: string; bg: string; text: string; icon: ReactElement }> = {
  platinum: { label: "Platinum", bg: "bg-violet-100", text: "text-violet-800", icon: <Crown className="h-3 w-3" /> },
  gold:     { label: "Gold",     bg: "bg-amber-100",  text: "text-amber-800",  icon: <Star  className="h-3 w-3" /> },
  silver:   { label: "Silver",   bg: "bg-slate-100",  text: "text-slate-700",  icon: <Star  className="h-3 w-3" /> },
  bronze:   { label: "Bronze",   bg: "bg-orange-50",  text: "text-orange-700", icon: <Circle className="h-3 w-3" /> },
  dormant:  { label: "Dormant",  bg: "bg-gray-100",   text: "text-gray-600",   icon: <Circle className="h-3 w-3" /> },
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}

function daysFromIso(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

export function LifetimeNpvPanel({ rows, agentUserId, brokerageId }: Props) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [tierFilter, setTierFilter] = useState<NpvTier | "all">("all")

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const r = await rescanLifetimeNpvForecastAction({ brokerageId, agentId: agentUserId })
      if (r.success) {
        toast.success("NPV scores updated")
        router.refresh()
      } else {
        toast.error(r.error ?? "Refresh failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed")
    } finally {
      setRefreshing(false)
    }
  }

  const filtered = tierFilter === "all" ? rows : rows.filter((r) => r.tier === tierFilter)

  // Tier counts for the filter strip
  const counts = {
    platinum: rows.filter((r) => r.tier === "platinum").length,
    gold:     rows.filter((r) => r.tier === "gold").length,
    silver:   rows.filter((r) => r.tier === "silver").length,
    bronze:   rows.filter((r) => r.tier === "bronze").length,
    dormant:  rows.filter((r) => r.tier === "dormant").length,
  }
  const totalNpvDollars = rows.reduce((s, r) => s + r.npvDollars, 0)
  const dueCount = rows.filter((r) => {
    const d = daysFromIso(r.nextTouchpointDue)
    return d != null && d <= 7
  }).length

  return (
    <Card className="border-violet-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Crown className="h-4 w-4 text-violet-500" />
            Lifetime Customer NPV Ranking
          </CardTitle>
          <Button size="sm" variant="outline" disabled={refreshing} onClick={handleRefresh} className="h-7 text-xs gap-1.5">
            {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-muted-foreground">
            5-year projected referral GCI · {rows.length} contact{rows.length === 1 ? "" : "s"} scored · <strong>{formatUsd(totalNpvDollars)}</strong> total NPV
            {dueCount > 0 && (
              <> · <span className="text-amber-700">{dueCount} due this week</span></>
            )}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Tier filter strip */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={tierFilter === "all" ? "default" : "outline"}
            className="h-6 text-[11px] px-2"
            onClick={() => setTierFilter("all")}
          >
            All ({rows.length})
          </Button>
          {(["platinum","gold","silver","bronze","dormant"] as NpvTier[]).map((t) => {
            const c = counts[t]
            if (c === 0) return null
            return (
              <Button
                key={t}
                size="sm"
                variant={tierFilter === t ? "default" : "outline"}
                className={cn("h-6 text-[11px] px-2 gap-1", tierFilter === t ? "" : `${TIER_STYLE[t].text}`)}
                onClick={() => setTierFilter(t)}
              >
                {TIER_STYLE[t].icon} {TIER_STYLE[t].label} ({c})
              </Button>
            )
          })}
        </div>

        {/* Ranked list */}
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No contacts in this tier yet. Run the scan to populate.
          </p>
        ) : (
          <ul className="divide-y">
            {filtered.slice(0, 50).map((r) => {
              const tier = TIER_STYLE[r.tier]
              const dueDays = daysFromIso(r.nextTouchpointDue)
              return (
                <li key={r.contactId} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className={cn("inline-flex items-center justify-center w-7 h-7 rounded-full font-bold text-xs", tier.bg, tier.text)}>
                      {r.npvScore}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/crm?contact=${r.contactId}`}
                          className="text-sm font-medium hover:underline truncate"
                        >
                          {r.contactName ?? "Unknown contact"}
                        </Link>
                        <Badge className={cn("text-[10px] gap-0.5", tier.bg, tier.text)}>
                          {tier.icon} {tier.label}
                        </Badge>
                        {r.scoreDelta != null && r.scoreDelta !== 0 && (
                          <span className={cn(
                            "inline-flex items-center gap-0.5 text-[10px]",
                            r.scoreDelta > 0 ? "text-emerald-700" : "text-red-700",
                          )}>
                            {r.scoreDelta > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                            {r.scoreDelta > 0 ? "+" : ""}{r.scoreDelta}
                          </span>
                        )}
                      </div>
                      {r.recommendedAction && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{r.recommendedAction}</p>
                      )}
                      {r.signals.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {r.signals.slice(0, 3).map((s, i) => (
                            <span key={i} className="text-[10px] bg-muted/40 text-muted-foreground rounded-full px-1.5 py-0.5">
                              {s.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex flex-col items-end gap-0.5 shrink-0">
                    <p className="text-sm font-bold tabular-nums">{formatUsd(r.npvDollars)}</p>
                    <p className="text-[10px] text-muted-foreground">5-yr NPV</p>
                    {dueDays != null && (
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap",
                        dueDays < 0 ? "bg-red-100 text-red-700" :
                        dueDays <= 7 ? "bg-amber-100 text-amber-700" :
                                       "bg-gray-100 text-gray-600",
                      )}>
                        {dueDays < 0 ? `${Math.abs(dueDays)}d overdue` :
                         dueDays === 0 ? "due today" :
                                         `due in ${dueDays}d`}
                      </span>
                    )}
                  </div>
                  <Link
                    href={`/crm?contact=${r.contactId}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
