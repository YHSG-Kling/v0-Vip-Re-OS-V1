"use client"

import { useState, useTransition, useCallback } from "react"
import { cn }                                    from "@/lib/utils"
import {
  getBuyerFatigueScore,
  getBuyerFatigueAlerts,
  dismissFatigueAlert,
  triggerFatigueCalculation,
  getReinvigorationSuggestions,
} from "@/app/actions/buyer-fatigue"

// ─── TYPES ───────────────────────────────────────────────────────────────────

type RiskLevel = "fresh" | "moderate" | "high" | "critical"

interface FatigueScore {
  fatigue_score:        number
  risk_level:           RiskLevel
  total_showings:       number
  total_tour_days:      number
  days_searching:       number
  offers_rejected:      number
  engagement_trend:     string | null
  last_calculated_at:   string | null
}

interface FatigueAlert {
  id:                       string
  alert_type:               string | null
  fatigue_score_at_trigger: number | null
  risk_level:               string | null
  message:                  string | null
  created_at:               string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const RISK_COLOR: Record<RiskLevel, string> = {
  fresh:    "text-emerald-600",
  moderate: "text-amber-500",
  high:     "text-orange-500",
  critical: "text-red-600",
}

const RISK_BG: Record<RiskLevel, string> = {
  fresh:    "bg-emerald-50 border-emerald-200",
  moderate: "bg-amber-50 border-amber-200",
  high:     "bg-orange-50 border-orange-200",
  critical: "bg-red-50 border-red-200",
}

const RING_COLOR: Record<RiskLevel, string> = {
  fresh:    "#10b981",
  moderate: "#f59e0b",
  high:     "#f97316",
  critical: "#ef4444",
}

function formatAlertType(t: string | null): string {
  if (!t) return "Alert"
  return t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1)  return "just now"
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

// ─── SCORE GAUGE ─────────────────────────────────────────────────────────────

function ScoreGauge({ score, risk }: { score: number; risk: RiskLevel }) {
  const r       = 52
  const circ    = 2 * Math.PI * r
  const pct     = Math.min(score, 100) / 100
  const dash    = pct * circ
  const color   = RING_COLOR[risk]

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width="136" height="136" viewBox="0 0 136 136" aria-label={`Fatigue score ${score} out of 100`}>
        {/* Track */}
        <circle cx="68" cy="68" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
        {/* Progress */}
        <circle
          cx="68" cy="68" r={r}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          strokeDashoffset={circ / 4}
          transform="rotate(-90 68 68)"
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
        <text x="68" y="63" textAnchor="middle" className="fill-foreground" style={{ fontSize: 28, fontWeight: 700 }}>
          {score}
        </text>
        <text x="68" y="80" textAnchor="middle" style={{ fontSize: 11, fill: "#6b7280" }}>
          / 100
        </text>
      </svg>
      <span className={cn("text-sm font-semibold uppercase tracking-wide", RISK_COLOR[risk])}>
        {risk}
      </span>
    </div>
  )
}

// ─── MAIN PANEL ───────────────────────────────────────────────────────────────

interface FatiguePanelProps {
  contactId:   string
  brokerageId: string
}

export function FatiguePanel({ contactId, brokerageId }: FatiguePanelProps) {
  const [score,       setScore]       = useState<FatigueScore | null>(null)
  const [alerts,      setAlerts]      = useState<FatigueAlert[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loaded,      setLoaded]      = useState(false)
  const [loadError,   setLoadError]   = useState<string | null>(null)
  const [isPending,   startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      const [scoreRes, alertsRes] = await Promise.all([
        getBuyerFatigueScore(contactId),
        getBuyerFatigueAlerts(contactId),
      ])
      if (scoreRes.success)  setScore(scoreRes.data ?? null)
      else                   setLoadError(scoreRes.error)
      if (alertsRes.success) setAlerts(alertsRes.data)
      setLoaded(true)
    })
  }, [contactId])

  // Load on first render
  if (!loaded && !isPending) load()

  function handleDismiss(alertId: string) {
    startTransition(async () => {
      await dismissFatigueAlert(alertId)
      setAlerts(prev => prev.filter(a => a.id !== alertId))
    })
  }

  function handleCalculate() {
    startTransition(async () => {
      const res = await triggerFatigueCalculation(contactId, brokerageId)
      if (res.success && res.data) {
        // Re-load fresh data
        load()
      }
    })
  }

  function handleLoadSuggestions() {
    startTransition(async () => {
      const res = await getReinvigorationSuggestions(contactId, brokerageId)
      if (res.success) setSuggestions(res.suggestions)
    })
  }

  // ── Skeleton ────────────────────────────────────────────────────────────────
  if (!loaded) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 space-y-4 animate-pulse">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="flex justify-center">
          <div className="h-36 w-36 rounded-full bg-muted" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-3/4 rounded bg-muted" />
        </div>
      </div>
    )
  }

  // ── Error / no data ──────────────────────────────────────────────────────────
  if (loadError || !score) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold">Buyer Fatigue</h3>
        <p className="text-sm text-muted-foreground">
          {loadError ?? "No fatigue score calculated yet."}
        </p>
        <button
          onClick={handleCalculate}
          disabled={isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Calculating..." : "Calculate Now"}
        </button>
      </div>
    )
  }

  const risk = score.risk_level
  const showReinvigoration = risk === "high" || risk === "critical"

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Buyer Fatigue</h3>
        <button
          onClick={handleCalculate}
          disabled={isPending}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {isPending ? "Calculating..." : "Recalculate"}
        </button>
      </div>

      {/* Gauge */}
      <div className="flex justify-center">
        <ScoreGauge score={score.fatigue_score} risk={risk} />
      </div>

      {/* Contributing factors */}
      <div className={cn("rounded-md border px-4 py-3 space-y-1.5 text-sm", RISK_BG[risk])}>
        <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Contributing Factors
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">Showings</span>
          <span className="font-medium">{score.total_showings}</span>
          <span className="text-muted-foreground">Tour days</span>
          <span className="font-medium">{score.total_tour_days}</span>
          <span className="text-muted-foreground">Days searching</span>
          <span className="font-medium">{score.days_searching}</span>
          <span className="text-muted-foreground">Rejected offers</span>
          <span className="font-medium">{score.offers_rejected}</span>
          <span className="text-muted-foreground">Engagement</span>
          <span className="font-medium capitalize">{score.engagement_trend ?? "—"}</span>
        </div>
        {score.last_calculated_at && (
          <p className="text-xs text-muted-foreground pt-1">
            Last calculated {timeAgo(score.last_calculated_at)}
          </p>
        )}
      </div>

      {/* Active alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Active Alerts
          </p>
          {alerts.map(alert => (
            <div
              key={alert.id}
              className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2.5 space-y-1"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-medium text-orange-700">
                  {formatAlertType(alert.alert_type)}
                  {alert.fatigue_score_at_trigger != null && (
                    <span className="ml-1 text-orange-500 font-normal">
                      (score {alert.fatigue_score_at_trigger})
                    </span>
                  )}
                </p>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {timeAgo(alert.created_at)}
                </span>
              </div>
              {alert.message && (
                <p className="text-xs text-orange-800 leading-relaxed">{alert.message}</p>
              )}
              <button
                onClick={() => handleDismiss(alert.id)}
                disabled={isPending}
                className="text-xs text-orange-600 hover:text-orange-800 transition-colors disabled:opacity-50 font-medium"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Re-invigoration panel */}
      {showReinvigoration && (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Re-invigoration Suggestions
          </p>
          {suggestions.length === 0 ? (
            <button
              onClick={handleLoadSuggestions}
              disabled={isPending}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              {isPending ? "Generating..." : "Generate AI Suggestions"}
            </button>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
