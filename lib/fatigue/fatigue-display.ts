/**
 * System 5.8: Buyer Fatigue Predictor — Reach-out Guard (pure display logic)
 *
 * Pure, I/O-free mapping from a stored buyer_fatigue_scores row (+ optional active
 * fatigue_alert) into the compact "is it safe to reach out to this contact?" verdict
 * the agent sees on the contact detail surface. NO Supabase, NO React — so it can be
 * unit-simulated and reused by any rendering surface.
 *
 * This deliberately mirrors the warning thresholds the scorer writes (watch>=35,
 * warning>=60, critical>=80) rather than re-deriving them, so the badge an agent sees
 * never disagrees with the alert the scorer fired.
 */

export type FatigueRiskLevel = "fresh" | "watch" | "warning" | "critical"

/** Minimal shape this module needs from a buyer_fatigue_scores row. */
export interface FatigueScoreInput {
  fatigue_score:     number | null
  risk_level:        string | null
  offers_rejected:   number | null
  engagement_trend:  string | null
}

/** Minimal shape this module needs from a fatigue_alerts row. */
export interface FatigueAlertInput {
  alert_type: string | null
  message:    string | null
}

export interface ReachoutGuard {
  /** Normalized risk level (falls back to score thresholds if the stored level is junk). */
  level:        FatigueRiskLevel
  /** Whether an agent should feel free to reach out now. False at warning / critical. */
  safeToReachOut: boolean
  /** One-line human reason the agent reads next to the send action. */
  reason:       string
  /** Short badge label. */
  label:        string
  /** Whether we have any score at all (vs. "not scored yet"). */
  hasScore:     boolean
}

const LABELS: Record<FatigueRiskLevel, string> = {
  fresh:    "Fresh",
  watch:    "Watch",
  warning:  "Over-contacted",
  critical: "Critical fatigue",
}

/**
 * Derive a risk level from a numeric score using the SAME cut points the scorer uses
 * (critical>=80, warning>=60, watch>=35, else fresh). Exported so the simulator and any
 * caller that only has a raw number can agree with the badge.
 */
export function deriveRiskLevel(score: number): FatigueRiskLevel {
  if (score >= 80) return "critical"
  if (score >= 60) return "warning"
  if (score >= 35) return "watch"
  return "fresh"
}

function normalizeLevel(stored: string | null, score: number): FatigueRiskLevel {
  if (stored === "fresh" || stored === "watch" || stored === "warning" || stored === "critical") {
    return stored
  }
  // Stored level missing/unknown → trust the number.
  return deriveRiskLevel(score)
}

/**
 * Build the reach-out guard verdict shown next to a contact's send/outreach actions.
 * Pure: same inputs → same output. `null` score means "never scored".
 */
export function buildReachoutGuard(
  score: FatigueScoreInput | null,
  alert: FatigueAlertInput | null,
): ReachoutGuard {
  if (!score || score.fatigue_score == null) {
    return {
      level:          "fresh",
      safeToReachOut: true,
      reason:         "No fatigue score yet — safe to reach out.",
      label:          "Not scored",
      hasScore:       false,
    }
  }

  const numeric = Math.max(0, Math.min(100, score.fatigue_score))
  const level   = normalizeLevel(score.risk_level, numeric)
  const safe    = level === "fresh" || level === "watch"

  // Prefer the alert's own message when an alert is active — it's the most specific
  // signal the scorer chose to surface. Otherwise build a reason from the score factors.
  let reason: string
  if (alert?.message && alert.message.trim() !== "") {
    reason = alert.message.trim()
  } else {
    const parts: string[] = [`Fatigue ${numeric}/100 (${level}).`]
    if ((score.offers_rejected ?? 0) > 0) {
      const n = score.offers_rejected as number
      parts.push(`${n} rejected offer${n > 1 ? "s" : ""}.`)
    }
    if (score.engagement_trend === "declining") {
      parts.push("Engagement is declining.")
    }
    if (safe) {
      parts.push("OK to reach out.")
    } else {
      parts.push("Consider pausing outreach.")
    }
    reason = parts.join(" ")
  }

  return {
    level,
    safeToReachOut: safe,
    reason,
    label:          LABELS[level],
    hasScore:       true,
  }
}
