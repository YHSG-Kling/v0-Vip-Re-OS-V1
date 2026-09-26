/**
 * System 5.8: Buyer Fatigue Predictor — Reach-out Guard (pure display logic)
 *
 * Pure, I/O-free mapping from a stored buyer_fatigue_scores row (+ optional active
 * fatigue_alert) into the compact "is it safe to reach out to this contact?" verdict
 * the agent sees on the contact detail surface. NO Supabase, NO React — so it can be
 * unit-simulated and reused by any rendering surface.
 *
 * VOCABULARY: fresh | moderate | high | critical — the values the live CHECK on
 * buyer_fatigue_scores.risk_level actually admits. This module previously spoke
 * watch/warning at 35/60/80, mirroring a second scorer whose writes the database
 * rejected outright, so the badge described a row that could never exist. The cut
 * points below are calculateFatigue's own (critical>=75, high>=50, moderate>=25).
 */

export type FatigueRiskLevel = "fresh" | "moderate" | "high" | "critical"

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
  /** Whether an agent should feel free to reach out now. False at high / critical. */
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
  moderate: "Watch",
  high:     "Over-contacted",
  critical: "Critical fatigue",
}

/**
 * Derive a risk level from a numeric score using the SAME cut points calculateFatigue
 * uses (critical>=75, high>=50, moderate>=25, else fresh). Exported so the simulator and
 * any caller that only has a raw number can agree with the badge.
 */
export function deriveRiskLevel(score: number): FatigueRiskLevel {
  if (score >= 75) return "critical"
  if (score >= 50) return "high"
  if (score >= 25) return "moderate"
  return "fresh"
}

function normalizeLevel(stored: string | null, score: number): FatigueRiskLevel {
  if (stored === "fresh" || stored === "moderate" || stored === "high" || stored === "critical") {
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
  const safe    = level === "fresh" || level === "moderate"

  // Prefer the alert's own message when an alert is active — it's the most specific
  // signal the calculator chose to surface. Otherwise build a reason from the factors.
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
