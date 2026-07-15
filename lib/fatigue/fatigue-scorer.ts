/**
 * System 5.8: Buyer Fatigue Predictor — Fatigue Scorer
 *
 * Calculates a fatigue score (0–100) for a buyer contact from raw DB signals.
 * Writes result to buyer_fatigue_scores (upsert) and fires kernel event
 * BUYER_FATIGUE_DETECTED when score crosses the warning threshold (>= 60).
 *
 * Scoring model (additive, capped at 100):
 *   total_showings      × 1.5   (max 30 pts at 20 showings)
 *   total_tour_days     × 3.0   (max 15 pts at 5 days)
 *   days_searching      × 0.1   (max 10 pts at 100 days)
 *   offers_rejected     × 10    (max 30 pts at 3 rejections)
 *   engagement_decline  + 15    (if last-7-day signals < prior-7-day / 2)
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { transitionLifecycle }  from "@/lib/kernel/lifecycle"
import { KernelEvent }          from "@/lib/kernel/events"

export type RiskLevel = "fresh" | "watch" | "warning" | "critical"

export interface FatigueScore {
  contactId:            string
  brokerageId:          string
  fatigueScore:         number
  riskLevel:            RiskLevel
  totalShowings:        number
  totalTourDays:        number
  daysSearching:        number
  offersRejected:       number
  engagementTrend:      string
  contributingFactors:  Record<string, number>
  lastCalculatedAt:     string
}

function deriveRiskLevel(score: number): RiskLevel {
  if (score >= 80) return "critical"
  if (score >= 60) return "warning"
  if (score >= 35) return "watch"
  return "fresh"
}

export async function calculateBuyerFatigue(
  contactId: string,
  brokerageId: string,
  agentUserId: string
): Promise<{ success: boolean; score?: FatigueScore; error?: string }> {
  const supabase = createServiceClient()

  // ── 1. Pull raw signal counts ──────────────────────────────────────────────
  const now     = new Date()
  const day7ago = new Date(now.getTime() - 7  * 86400_000).toISOString()
  const day14ago= new Date(now.getTime() - 14 * 86400_000).toISOString()

  const [toursRes, offersRes, signalsRes, contactRes] = await Promise.all([
    supabase
      .from("tours")
      .select("id, tour_date, created_at")
      .eq("contact_id", contactId)
      .neq("status", "cancelled"),

    supabase
      .from("offers")
      .select("id, status, submitted_at")
      .eq("contact_id", contactId)
      .in("status", ["rejected", "countered", "withdrawn"]),

    supabase
      .from("buyer_behavior_log")
      .select("created_at")
      .eq("contact_id", contactId)
      .gte("created_at", day14ago),

    supabase
      .from("contacts")
      .select("created_at, buyer_stage")
      .eq("id", contactId)
      .single(),
  ])

  if (contactRes.error || !contactRes.data) {
    return { success: false, error: contactRes.error?.message ?? "Contact not found" }
  }

  const contact        = contactRes.data
  const tours          = toursRes.data  ?? []
  const offers         = offersRes.data ?? []
  const signals        = signalsRes.data ?? []

  // ── 2. Compute raw metrics ─────────────────────────────────────────────────
  const totalShowings  = tours.length
  const totalTourDays  = new Set(tours.map(t => t.tour_date ?? t.created_at?.slice(0, 10))).size
  const offersRejected = offers.length

  const contactCreated = new Date(contact.created_at ?? now)
  const daysSearching  = Math.floor((now.getTime() - contactCreated.getTime()) / 86400_000)

  const recent7  = signals.filter(s => s.created_at >= day7ago).length
  const prior7   = signals.filter(s => s.created_at < day7ago).length
  const engagementDecline = prior7 > 0 && recent7 < prior7 / 2
  const engagementTrend   = engagementDecline
    ? "declining"
    : recent7 >= prior7
    ? "stable"
    : "slowing"

  // ── 3. Score each factor ───────────────────────────────────────────────────
  const factors: Record<string, number> = {
    showings:    Math.min(30, totalShowings   * 1.5),
    tour_days:   Math.min(15, totalTourDays   * 3.0),
    days_active: Math.min(10, daysSearching   * 0.1),
    rejections:  Math.min(30, offersRejected  * 10),
    eng_decline: engagementDecline ? 15 : 0,
  }

  const raw    = Object.values(factors).reduce((a, b) => a + b, 0)
  const score  = Math.min(100, Math.round(raw))
  const risk   = deriveRiskLevel(score)

  // ── 4. Upsert buyer_fatigue_scores ─────────────────────────────────────────
  const { error: upsertErr } = await supabase
    .from("buyer_fatigue_scores")
    .upsert(
      {
        brokerage_id:          brokerageId,
        contact_id:            contactId,
        agent_id:              await resolveAgentId(supabase as any, agentUserId),
        fatigue_score:         score,
        risk_level:            risk,
        total_showings:        totalShowings,
        total_tour_days:       totalTourDays,
        days_searching:        daysSearching,
        offers_rejected:       offersRejected,
        engagement_trend:      engagementTrend,
        contributing_factors:  factors,
        last_calculated_at:    now.toISOString(),
      },
      { onConflict: "brokerage_id,contact_id" }
    )

  if (upsertErr) return { success: false, error: upsertErr.message }

  // ── 5. Fire kernel event when score crosses warning threshold ──────────────
  if (score >= 60) {
    await supabase.from("fatigue_alerts").upsert(
      {
        brokerage_id:            brokerageId,
        contact_id:              contactId,
        agent_user_id:           agentUserId,
        alert_type:              risk === "critical" ? "fatigue_critical" : "fatigue_warning",
        fatigue_score_at_trigger: score,
        risk_level:              risk,
        message:                 `Buyer fatigue score is ${score}/100 (${risk}). ${
          offersRejected > 0
            ? `${offersRejected} rejected offer${offersRejected > 1 ? "s" : ""}. `
            : ""
        }${engagementDecline ? "Engagement has declined significantly." : ""}`,
        dismissed:               false,
      },
      { onConflict: "brokerage_id,contact_id" }
    )

    await transitionLifecycle({
      brokerageId,
      entityType:  "buyer_lifecycle",
      entityId:    contactId,
      fromState:   "",
      toState:     contact.buyer_stage ?? "BUYER_SEARCHING",
      actorUserId: agentUserId,
      actorRole:   "system",
      eventType:   KernelEvent.BUYER_FATIGUE_DETECTED,
      metadata:    { fatigue_score: score, risk_level: risk, factors },
    })
  }

  const result: FatigueScore = {
    contactId,
    brokerageId,
    fatigueScore:        score,
    riskLevel:           risk,
    totalShowings,
    totalTourDays,
    daysSearching,
    offersRejected,
    engagementTrend,
    contributingFactors: factors,
    lastCalculatedAt:    now.toISOString(),
  }

  return { success: true, score: result }
}
