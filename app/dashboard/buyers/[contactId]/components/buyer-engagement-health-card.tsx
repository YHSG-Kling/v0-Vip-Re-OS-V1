"use client"

import { useState, useEffect, useTransition } from "react"
import Link                                    from "next/link"
import { cn }                                  from "@/lib/utils"
import {
  getBuyerFatigueScore,
  getReinvigorationSuggestions,
} from "@/app/actions/buyer-fatigue"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type RiskLevel = "fresh" | "moderate" | "high" | "critical"

interface FatigueScore {
  fatigue_score:      number
  risk_level:         RiskLevel
  total_showings:     number
  total_tour_days:    number
  days_searching:     number
  offers_rejected:    number
  engagement_trend:   string | null
  last_calculated_at: string | null
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

// Maps DB risk_level values to spec display labels and styling
const LEVEL_CONFIG: Record<RiskLevel, {
  label:       string
  headline:    string
  description: string
  border:      string
  bg:          string
  badge:       string
  dot:         string
}> = {
  fresh: {
    label:       "FRESH",
    headline:    "Actively Engaged",
    description: "Buyer is actively engaged and motivated",
    border:      "border-emerald-200",
    bg:          "bg-emerald-50",
    badge:       "bg-emerald-100 text-emerald-800 border-emerald-200",
    dot:         "bg-emerald-500",
  },
  moderate: {
    label:       "WARMING",
    headline:    "Early Fatigue Signs",
    description: "Some signs of search fatigue — consider a break",
    border:      "border-amber-200",
    bg:          "bg-amber-50",
    badge:       "bg-amber-100 text-amber-800 border-amber-200",
    dot:         "bg-amber-500",
  },
  high: {
    label:       "FATIGUED",
    headline:    "High Fatigue",
    description: "High fatigue — recommend resetting search criteria",
    border:      "border-orange-200",
    bg:          "bg-orange-50",
    badge:       "bg-orange-100 text-orange-800 border-orange-200",
    dot:         "bg-orange-500",
  },
  critical: {
    label:       "CRITICAL",
    headline:    "Intervention Needed",
    description: "Buyer may be close to giving up — intervention needed",
    border:      "border-red-200",
    bg:          "bg-red-50",
    badge:       "bg-red-100 text-red-800 border-red-200",
    dot:         "bg-red-500",
  },
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Derive human-readable indicator strings from the raw score row */
function buildIndicators(score: FatigueScore): string[] {
  const indicators: string[] = []
  if (score.total_showings > 0)
    indicators.push(`Viewed ${score.total_showings} propert${score.total_showings === 1 ? "y" : "ies"}`)
  if (score.total_tour_days > 0)
    indicators.push(`${score.total_tour_days} tour day${score.total_tour_days === 1 ? "" : "s"} completed`)
  if (score.days_searching > 0)
    indicators.push(`Searching for ${score.days_searching} day${score.days_searching === 1 ? "" : "s"}`)
  if (score.offers_rejected > 0)
    indicators.push(`${score.offers_rejected} offer${score.offers_rejected === 1 ? "" : "s"} rejected`)
  if (score.engagement_trend && score.engagement_trend !== "stable")
    indicators.push(`Engagement trend: ${score.engagement_trend}`)
  return indicators
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

interface Props {
  buyerId:     string
  brokerageId: string
}

export function BuyerEngagementHealthCard({ buyerId, brokerageId }: Props) {
  const [score,         setScore]       = useState<FatigueScore | null>(null)
  const [suggestions,   setSuggestions] = useState<string[]>([])
  const [loading,       setLoading]     = useState(true)
  const [loadError,     setLoadError]   = useState<string | null>(null)
  const [isPending,     startTransition] = useTransition()
  const [suggestLoaded, setSuggestLoaded] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const res = await getBuyerFatigueScore(buyerId)
      if (res.success) setScore(res.data as FatigueScore | null)
      else             setLoadError(res.error)
      setLoading(false)
    }
    load()
  }, [buyerId])

  function handleLoadSuggestions() {
    startTransition(async () => {
      const res = await getReinvigorationSuggestions(buyerId, brokerageId)
      if (res.success) {
        setSuggestions(res.suggestions.slice(0, 3))
        setSuggestLoaded(true)
      }
    })
  }

  // ── Skeleton ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 space-y-3 animate-pulse">
        <div className="h-4 w-44 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-3/4 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
    )
  }

  // ── No data ───────────────────────────────────────────────────────────────────
  if (loadError || !score) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <h3 className="text-sm font-semibold">Buyer Engagement Health</h3>
        <p className="text-sm text-muted-foreground">
          {loadError ?? "No engagement data yet — fatigue score will be calculated automatically."}
        </p>
      </div>
    )
  }

  const risk   = score.risk_level
  const cfg    = LEVEL_CONFIG[risk]
  const indics = buildIndicators(score)
  const showActions = risk === "moderate" || risk === "high" || risk === "critical"

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden", cfg.border)}>
      {/* Header */}
      <div className={cn("flex items-center justify-between px-4 py-3 border-b", cfg.bg, cfg.border)}>
        <div className="flex items-center gap-2">
          <span
            className={cn("inline-block h-2 w-2 rounded-full flex-shrink-0", cfg.dot)}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-foreground">Buyer Engagement Health</span>
        </div>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide",
            cfg.badge,
          )}
        >
          {cfg.label}
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* Level description */}
        <p className="text-sm text-muted-foreground leading-relaxed">{cfg.description}</p>

        {/* Score strip */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", cfg.dot)}
              style={{ width: `${score.fatigue_score}%` }}
            />
          </div>
          <span className="text-xs tabular-nums font-medium text-muted-foreground w-12 text-right">
            {score.fatigue_score}/100
          </span>
        </div>

        {/* Indicators */}
        {indics.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Key Indicators
            </p>
            <ul className="space-y-1.5">
              {indics.map((ind, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn("mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0", cfg.dot)}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">{ind}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* AI Recommendations */}
        {(risk === "high" || risk === "critical" || risk === "moderate") && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              AI Recommendations
            </p>
            {!suggestLoaded ? (
              <button
                onClick={handleLoadSuggestions}
                disabled={isPending}
                className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-50 text-left"
              >
                {isPending ? "Generating recommendations..." : "Generate AI Recommendations"}
              </button>
            ) : (
              <ul className="space-y-2">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span
                      className={cn("mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0", cfg.dot)}
                      aria-hidden="true"
                    />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Action buttons — shown when fatigue is elevated */}
        {showActions && (
          <div className="pt-1 flex flex-wrap gap-2">
            <Link
              href={`/dashboard/buyers/${buyerId}/search`}
              className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              Send Curated List
            </Link>
            <Link
              href="/dashboard/calendar"
              className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              Schedule Call
            </Link>
            <Link
              href={`/dashboard/buyers/${buyerId}/alerts`}
              className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              Adjust Search Criteria
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
