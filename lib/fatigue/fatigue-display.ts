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
  /** The calculator's factor snapshot (buyer_fatigue_scores.contributing_factors jsonb). Optional —
   *  a row written before wave 88 carries only the buyer-search fields. */
  contributing_factors?: unknown
}

// ─── WAVE 88 (lane 88A) — the words for the new inputs ────────────────────────
// Owner: "Calculating fatigue should also take into consideration responses to follow up, Fatigue
// for sellers that haven't signed a listing agreement meaning unresponsive to follow up, missed
// appointments, etc." The calculator (lib/fatigue/fatigue-calculator.ts) scores them; THIS module
// owns the words, so the alert the calculator writes and the card the agent reads say the same thing.

/** Unanswered follow-ups start to count at this many — one unanswered touch is ordinary. The
 *  calculator imports it (score) and the card uses it (words), so they cannot disagree. */
export const UNANSWERED_FOLLOW_UP_FLOOR = 2

// ─── WAVE 89 (lane 89C) — THE WEIGHTS ARE BROKERAGE-TUNABLE ──────────────────
// Lane 88A: "The weights (4 / 8 / 15 / 20) are mine. The owner may want to tune them." Owner ruling:
// keep them as the DEFAULTS and expose them as a brokerage setting, written only through the one
// settings writer (lib/settings/brokerage-settings-merge.ts) by the tenant admin door
// (app/actions/buyer-fatigue.ts setContactFatigueWeights). PURE: the resolver reads the settings
// object and clamps every value, so a malformed or hostile setting can never blow the score up.

/** brokerage_settings.settings key holding the weights. */
export const CONTACT_FATIGUE_WEIGHTS_KEY = "contact_fatigue_weights"

export interface ContactFatigueWeights {
  /** Per unanswered follow-up past the floor (capped by the calculator). */
  unanswered_follow_up: number
  /** Per channel at / over the over-touch cap. */
  saturated_channel: number
  /** Per missed appointment (capped by the calculator). */
  missed_appointment: number
  /** A seller with no signed listing agreement who is not answering. */
  seller_unresponsive: number
}

/** The 88A defaults — unchanged by the owner's wave-89 ruling ("keep weights"). */
export const DEFAULT_CONTACT_FATIGUE_WEIGHTS: ContactFatigueWeights = {
  unanswered_follow_up: 4,
  saturated_channel: 8,
  missed_appointment: 15,
  seller_unresponsive: 20,
}
/** A single weight may not exceed this (a 50-point term alone reaches HIGH fatigue). */
export const MAX_CONTACT_FATIGUE_WEIGHT = 50

/** PURE — the weights a brokerage's settings object resolves to: each key an integer 0..MAX, the
 *  default for anything absent, non-numeric or out of range. Never throws. */
export function resolveContactFatigueWeights(settings: unknown): ContactFatigueWeights {
  const raw = settings && typeof settings === "object"
    ? (settings as Record<string, unknown>)[CONTACT_FATIGUE_WEIGHTS_KEY]
    : undefined
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const pick = (k: keyof ContactFatigueWeights): number => {
    const v = Number(obj[k])
    if (!Number.isFinite(v) || v < 0 || v > MAX_CONTACT_FATIGUE_WEIGHT) return DEFAULT_CONTACT_FATIGUE_WEIGHTS[k]
    return Math.round(v)
  }
  return {
    unanswered_follow_up: pick("unanswered_follow_up"),
    saturated_channel: pick("saturated_channel"),
    missed_appointment: pick("missed_appointment"),
    seller_unresponsive: pick("seller_unresponsive"),
  }
}

/** PURE — validate a proposed weights object from the admin door: every key present, integer, in range. */
export function validateContactFatigueWeights(input: unknown): { ok: true; weights: ContactFatigueWeights } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Fatigue weights must be an object with the four weight keys." }
  const obj = input as Record<string, unknown>
  const out: Partial<ContactFatigueWeights> = {}
  for (const k of Object.keys(DEFAULT_CONTACT_FATIGUE_WEIGHTS) as Array<keyof ContactFatigueWeights>) {
    const v = Number(obj[k])
    if (!Number.isInteger(v) || v < 0 || v > MAX_CONTACT_FATIGUE_WEIGHT) {
      return { ok: false, error: `Fatigue weight "${k}" must be a whole number from 0 to ${MAX_CONTACT_FATIGUE_WEIGHT}.` }
    }
    out[k] = v
  }
  return { ok: true, weights: out as ContactFatigueWeights }
}

/** The factor snapshot, structurally (every field optional — old rows lack the wave-88 ones). */
export interface FatigueFactorsInput {
  total_showings?:        number | null
  total_tour_days?:       number | null
  days_searching?:        number | null
  offers_rejected?:       number | null
  engagement_trend?:      string | null
  engagement_detail?:     string | null
  follow_ups_sent?:       number | null
  replies_received?:      number | null
  unanswered_follow_ups?: number | null
  saturated_channels?:    string[] | null
  missed_appointments?:   number | null
  unsigned_seller?:       boolean | null
  seller_unresponsive?:   boolean | null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** PURE — one sentence naming what is driving a person's fatigue. */
export function describeFatigueFactors(f: FatigueFactorsInput | null | undefined): string {
  if (!f) return "no fatigue signals on file"
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const parts: string[] = []
  const showings = n(f.total_showings), tourDays = n(f.total_tour_days), days = n(f.days_searching), offers = n(f.offers_rejected)
  if (showings || tourDays || offers || days) {
    parts.push(`${plural(showings, "showing")}, ${plural(tourDays, "tour day")}, ${plural(days, "day")} searching, ${plural(offers, "rejected offer")}`)
  }
  const detail = f.engagement_detail ?? f.engagement_trend
  if (detail && detail !== "no buyer search on file" && detail !== "stable") parts.push(`engagement ${detail}`)
  const sent = n(f.follow_ups_sent), unanswered = n(f.unanswered_follow_ups)
  if (unanswered >= UNANSWERED_FOLLOW_UP_FLOOR) {
    parts.push(n(f.replies_received) === 0
      ? `no reply to ${plural(sent, "follow-up")} in the last 30 days`
      : `${unanswered} of ${plural(sent, "follow-up")} unanswered since the last reply`)
  }
  const saturated = (f.saturated_channels ?? []).filter(Boolean)
  if (saturated.length) parts.push(`at the over-touch cap on ${saturated.join(", ")}`)
  const missed = n(f.missed_appointments)
  if (missed > 0) parts.push(`${plural(missed, "missed appointment")}`)
  if (f.seller_unresponsive) parts.push("seller has not signed a listing agreement and is not answering follow-up")
  else if (f.unsigned_seller) parts.push("seller has not signed a listing agreement yet")
  return parts.length ? parts.join("; ") : "no fatigue signals on file"
}

function factorsOf(score: FatigueScoreInput): FatigueFactorsInput | null {
  const f = score.contributing_factors
  return f && typeof f === "object" && !Array.isArray(f) ? (f as FatigueFactorsInput) : null
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
    // Wave 88 — follow-up responsiveness, the over-touch cap, missed appointments, unsigned sellers.
    const f = factorsOf(score)
    if (f) {
      const unanswered = typeof f.unanswered_follow_ups === "number" ? f.unanswered_follow_ups : 0
      if (unanswered >= UNANSWERED_FOLLOW_UP_FLOOR) parts.push(`${unanswered} follow-ups unanswered.`)
      const saturated = (f.saturated_channels ?? []).filter(Boolean)
      if (saturated.length) parts.push(`At the over-touch cap on ${saturated.join(", ")} — the next send there will be held.`)
      const missed = typeof f.missed_appointments === "number" ? f.missed_appointments : 0
      if (missed > 0) parts.push(`${missed} missed appointment${missed > 1 ? "s" : ""}.`)
      if (f.seller_unresponsive) parts.push("Unsigned seller going quiet.")
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
