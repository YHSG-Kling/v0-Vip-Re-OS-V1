"use client"

/**
 * System 5.8: Buyer Fatigue Predictor — Fatigue Widget
 *
 * Displays a buyer's fatigue score, risk level, contributing factors,
 * active alert + recovery plan, and a manual re-score trigger.
 * Placed in the right column of buyer-overview-client.tsx below BuyerInsightsPanel.
 */

import React, { useState, useTransition } from "react"
import { useRouter }               from "next/navigation"
import { Badge }                   from "@/components/ui/badge"
import { Button }                  from "@/components/ui/button"
import { Progress }                from "@/components/ui/progress"
import {
  getBuyerFatigueScore,
  getBuyerFatigueAlerts,
  dismissFatigueAlert,
  triggerFatigueCalculation,
} from "@/app/actions/buyer-fatigue"
import { useEffect } from "react"

interface Props {
  contactId:   string
  brokerageId: string
  agentUserId: string
}

// VOCABULARY: the four values the live CHECK on buyer_fatigue_scores.risk_level
// admits — fresh | moderate | high | critical. This file used to filter on
// watch/warning, written by a second scorer whose rows the database rejected
// outright, so these columns and filter tabs were permanently empty.
type RiskLevel = "fresh" | "moderate" | "high" | "critical"

interface FatigueScoreRow {
  fatigue_score:         number
  risk_level:            RiskLevel
  total_showings:        number
  total_tour_days:       number
  days_searching:        number
  offers_rejected:       number
  engagement_trend:      string | null
  contributing_factors:  Record<string, number> | null
  last_calculated_at:    string | null
}

interface FatigueAlertRow {
  id:                       string
  alert_type:               string | null
  fatigue_score_at_trigger: number | null
  risk_level:               string | null
  message:                  string | null
  created_at:               string | null
}

const RISK_CONFIG: Record<RiskLevel, { label: string; bar: string; badge: string }> = {
  fresh:    { label: "Fresh",    bar: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-800" },
  moderate: { label: "Watch",    bar: "bg-amber-400",   badge: "bg-amber-100 text-amber-800" },
  high:     { label: "Warning",  bar: "bg-orange-500",  badge: "bg-orange-100 text-orange-800" },
  critical: { label: "Critical", bar: "bg-red-600",     badge: "bg-red-100 text-red-800" },
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600_000)
  if (h < 1)  return "just now"
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function FatigueWidget({ contactId, brokerageId, agentUserId }: Props) {
  const router                          = useRouter()
  const [isPending, startTransition]    = useTransition()
  const [score, setScore]               = useState<FatigueScoreRow | null>(null)
  const [alert, setAlert]               = useState<FatigueAlertRow | null>(null)
  const [recovery, setRecovery]         = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading]           = useState(true)
  const [dismissing, setDismissing]     = useState(false)

  async function load() {
    setLoading(true)
    const [scoreRes, alertsRes] = await Promise.all([
      getBuyerFatigueScore(contactId),
      getBuyerFatigueAlerts(contactId),
    ])
    if (scoreRes.success) setScore(scoreRes.data as FatigueScoreRow | null)
    if (alertsRes.success && alertsRes.data.length > 0) {
      const a = alertsRes.data[0] as FatigueAlertRow
      setAlert(a)
      if (a.message) {
        try {
          const parsed = JSON.parse(a.message)
          if (parsed?.recovery) setRecovery(parsed.recovery)
        } catch {}
      }
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [contactId])

  async function handleRescore() {
    startTransition(async () => {
      await triggerFatigueCalculation(contactId, brokerageId)
      await load()
    })
  }

  async function handleDismiss() {
    if (!alert) return
    setDismissing(true)
    await dismissFatigueAlert(alert.id)
    setAlert(null)
    setRecovery(null)
    setDismissing(false)
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 space-y-3 animate-pulse">
        <div className="h-4 w-32 bg-muted rounded" />
        <div className="h-2 w-full bg-muted rounded" />
        <div className="h-16 bg-muted rounded" />
      </div>
    )
  }

  const risk    = (score?.risk_level ?? "fresh") as RiskLevel
  const cfg     = RISK_CONFIG[risk] ?? RISK_CONFIG.fresh
  const pctBar  = score?.fatigue_score ?? 0

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Buyer Fatigue</span>
          {score && (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.badge}`}
            >
              {cfg.label}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={handleRescore}
          disabled={isPending}
        >
          {isPending ? "Scoring..." : "Re-score"}
        </Button>
      </div>

      <div className="p-4 space-y-4">
        {!score ? (
          <p className="text-xs text-muted-foreground">
            No fatigue score yet. Scores are calculated automatically every 12 hours, or click Re-score.
          </p>
        ) : (
          <>
            {/* Score bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Score</span>
                <span className="text-lg font-bold tabular-nums text-foreground">
                  {score.fatigue_score}
                  <span className="text-xs font-normal text-muted-foreground">/100</span>
                </span>
              </div>
              <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${cfg.bar}`}
                  style={{ width: `${pctBar}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground text-right">
                Updated {timeAgo(score.last_calculated_at)}
              </p>
            </div>

            {/* Contributing factors */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Contributing Factors</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {[
                  { label: "Showings",        val: score.total_showings },
                  { label: "Tour Days",       val: score.total_tour_days },
                  { label: "Days Searching",  val: score.days_searching },
                  { label: "Rejected Offers", val: score.offers_rejected },
                ].map(row => (
                  <div key={row.label} className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">{row.label}</span>
                    <span className="text-[11px] font-semibold tabular-nums text-foreground">{row.val}</span>
                  </div>
                ))}
              </div>
              {score.engagement_trend && (
                <p className="text-[11px] text-muted-foreground">
                  Engagement: <span className="font-medium text-foreground">{score.engagement_trend}</span>
                </p>
              )}
            </div>
          </>
        )}

        {/* Active alert + recovery plan */}
        {alert && (
          <div className="rounded-md border border-orange-200 bg-orange-50 p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-semibold text-orange-900">
                {/* Severity comes from risk_level. This read alert_type === "fatigue_critical",
                    a value the fatigue_alerts CHECK forbids (the only type ever written is
                    fatigue_threshold_crossed), so a critical alert always rendered as a warning. */}
                {alert.risk_level === "critical" ? "Critical Alert" : "Fatigue Warning"}
              </p>
              <button
                onClick={handleDismiss}
                disabled={dismissing}
                className="text-[10px] text-orange-600 hover:text-orange-800 shrink-0"
              >
                {dismissing ? "..." : "Dismiss"}
              </button>
            </div>

            {recovery && (
              <div className="space-y-1.5 pt-1 border-t border-orange-200">
                <p className="text-[10px] font-semibold text-orange-800 uppercase tracking-wide">
                  Recovery Plan
                </p>
                {(recovery.pause_days as number) > 0 && (
                  <p className="text-xs text-orange-900">
                    Suggest a <strong>{recovery.pause_days as number}-day</strong> pause from active searching.
                  </p>
                )}
                {!!recovery.re_engagement_message && (
                  <p className="text-xs text-orange-800 italic">
                    "{String(recovery.re_engagement_message)}"
                  </p>
                )}
                {!!recovery.search_reset_suggestion && (
                  <p className="text-xs text-orange-900">
                    Search reset: {String(recovery.search_reset_suggestion)}
                  </p>
                )}
                {!!recovery.morale_boost && (
                  <p className="text-xs text-muted-foreground border-t border-orange-200 pt-1.5">
                    {String(recovery.morale_boost)}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
