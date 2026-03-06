"use client"

import { useState, useTransition, useEffect, useCallback } from "react"
import { useRouter }                                         from "next/navigation"
import { cn }                                               from "@/lib/utils"
import { getBrokerageFatigueData }                          from "@/app/actions/buyer-fatigue"

type RiskLevel = "fresh" | "moderate" | "high" | "critical"

interface FatigueRow {
  contact_id:       string
  fatigue_score:    number
  risk_level:       RiskLevel
  total_showings:   number
  total_tour_days:  number
  days_searching:   number
  offers_rejected:  number
  engagement_trend: string | null
  last_calculated_at: string | null
  contacts: {
    id:         string
    first_name: string
    last_name:  string
    agent_id:   string | null
    buyer_stage: string | null
    users: { first_name: string; last_name: string } | null
  } | null
}

type SortKey = "fatigue_score" | "days_searching" | "total_showings" | "contact_name"
type SortDir = "asc" | "desc"

const RISK_BG: Record<RiskLevel, string> = {
  critical: "bg-red-50",
  high:     "bg-orange-50",
  moderate: "bg-amber-50",
  fresh:    "",
}

const RISK_BADGE: Record<RiskLevel, string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high:     "bg-orange-100 text-orange-700 border-orange-200",
  moderate: "bg-amber-100 text-amber-700 border-amber-200",
  fresh:    "bg-emerald-100 text-emerald-700 border-emerald-200",
}

const SUMMARY_COLORS: Record<RiskLevel, { bg: string; text: string; label: string }> = {
  critical: { bg: "bg-red-50 border-red-200",     text: "text-red-700",     label: "Critical" },
  high:     { bg: "bg-orange-50 border-orange-200", text: "text-orange-700", label: "High" },
  moderate: { bg: "bg-amber-50 border-amber-200",  text: "text-amber-700",  label: "Moderate" },
  fresh:    { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", label: "Fresh" },
}

// Hard-coded brokerageId pulled from env (server should pass via props in a real RSC)
// This page is rendered client-side; in production wrap with an RSC to pass brokerageId.
const DEMO_BROKERAGE_ID = process.env.NEXT_PUBLIC_BROKERAGE_ID ?? ""

export default function BrokerageFatiguePage() {
  const router       = useRouter()
  const [rows,       setRows]       = useState<FatigueRow[]>([])
  const [loaded,     setLoaded]     = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [sortKey,    setSortKey]    = useState<SortKey>("fatigue_score")
  const [sortDir,    setSortDir]    = useState<SortDir>("desc")
  const [isPending,  startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await getBrokerageFatigueData(DEMO_BROKERAGE_ID)
      if (res.success) setRows(res.data as FatigueRow[])
      else             setError(res.error)
      setLoaded(true)
    })
  }, [])

  useEffect(() => { load() }, [load])

  // Sort
  const sorted = [...rows].sort((a, b) => {
    let av: string | number = 0
    let bv: string | number = 0
    switch (sortKey) {
      case "fatigue_score":  av = a.fatigue_score;  bv = b.fatigue_score;  break
      case "days_searching": av = a.days_searching; bv = b.days_searching; break
      case "total_showings": av = a.total_showings; bv = b.total_showings; break
      case "contact_name":
        av = a.contacts ? `${a.contacts.first_name} ${a.contacts.last_name}` : ""
        bv = b.contacts ? `${b.contacts.first_name} ${b.contacts.last_name}` : ""
        break
    }
    if (av < bv) return sortDir === "asc" ? -1 : 1
    if (av > bv) return sortDir === "asc" ? 1 : -1
    return 0
  })

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc")
    else { setSortKey(key); setSortDir("desc") }
  }

  function SortIndicator({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className="text-muted-foreground/40 ml-1">↕</span>
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
  }

  // Summary counts
  const counts = { critical: 0, high: 0, moderate: 0, fresh: 0 } as Record<RiskLevel, number>
  for (const r of rows) counts[r.risk_level] = (counts[r.risk_level] ?? 0) + 1

  function handleRecalculate() {
    startTransition(async () => {
      await fetch("/api/fatigue/calculate", {
        method: "POST",
        headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
        body:    JSON.stringify({ brokerageId: DEMO_BROKERAGE_ID }),
      })
      load()
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Buyer Fatigue Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            All active buyers ranked by fatigue risk
          </p>
        </div>
        <button
          onClick={handleRecalculate}
          disabled={isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Recalculating..." : "Recalculate All"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-4">
          {(["critical", "high", "moderate", "fresh"] as RiskLevel[]).map(level => {
            const c = SUMMARY_COLORS[level]
            return (
              <div key={level} className={cn("rounded-lg border p-4 space-y-1", c.bg)}>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {c.label}
                </p>
                <p className={cn("text-3xl font-bold", c.text)}>
                  {counts[level] ?? 0}
                </p>
              </div>
            )
          })}
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-red-600 rounded-md border border-red-200 bg-red-50 px-3 py-2">
            {error}
          </p>
        )}

        {/* Table */}
        {!loaded ? (
          <div className="rounded-lg border border-border bg-card animate-pulse">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex gap-4 px-5 py-3 border-b border-border last:border-0">
                <div className="h-4 w-40 rounded bg-muted" />
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="h-4 w-16 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">No fatigue scores available yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run a calculation or wait for the daily cron (7 AM).
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {[
                    { label: "Buyer Name",     key: "contact_name"  as SortKey },
                    { label: "Agent",          key: null },
                    { label: "Fatigue Score",  key: "fatigue_score" as SortKey },
                    { label: "Risk Level",     key: null },
                    { label: "Days Searching", key: "days_searching" as SortKey },
                    { label: "Showings",       key: "total_showings" as SortKey },
                    { label: "Alerts",         key: null },
                  ].map(col => (
                    <th
                      key={col.label}
                      onClick={() => col.key && toggleSort(col.key)}
                      className={cn(
                        "px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide",
                        col.key && "cursor-pointer hover:text-foreground select-none",
                      )}
                    >
                      {col.label}
                      {col.key && <SortIndicator col={col.key} />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(row => {
                  const name = row.contacts
                    ? `${row.contacts.first_name} ${row.contacts.last_name}`
                    : "—"
                  const agentName = row.contacts?.users
                    ? `${row.contacts.users.first_name} ${row.contacts.users.last_name}`
                    : "—"
                  const contactId = row.contacts?.id ?? row.contact_id

                  return (
                    <tr
                      key={row.contact_id}
                      onClick={() => router.push(`/dashboard/buyers/${contactId}/fatigue`)}
                      className={cn(
                        "border-b border-border last:border-0 cursor-pointer hover:bg-muted/30 transition-colors",
                        RISK_BG[row.risk_level],
                      )}
                    >
                      <td className="px-4 py-3 font-medium">{name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{agentName}</td>
                      <td className="px-4 py-3 font-bold">{row.fatigue_score}</td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                          RISK_BADGE[row.risk_level],
                        )}>
                          {row.risk_level}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.days_searching}</td>
                      <td className="px-4 py-3 text-muted-foreground">{row.total_showings}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {(row.risk_level === "high" || row.risk_level === "critical") ? (
                          <span className="inline-block h-2 w-2 rounded-full bg-orange-400" />
                        ) : "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
