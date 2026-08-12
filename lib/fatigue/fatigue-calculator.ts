"use server"

import { createServiceClient } from "@/lib/supabase/service"
// agents.id → { users.id, users.brokerage_id }. The ONE crossing helper: both
// `fatigue_alerts.agent_user_id` (a users FK) and the tenant this file's
// smart_assistant_suggestions row must carry come from it.
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"
import { BUYER_ACTIVE_STAGES } from "@/lib/contacts/buyer-stage"
import { generateText }        from "ai"
import { KernelEvent }         from "@/lib/kernel/events"

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type RiskLevel = "fresh" | "moderate" | "high" | "critical"

export interface FatigueFactors {
  total_showings:            number
  total_tour_days:           number
  days_searching:            number
  offers_rejected:           number
  engagement_decline_factor: number // 0 | 1 | 2
  engagement_trend:          string
}

export interface FatigueResult {
  score:       number
  risk_level:  RiskLevel
  factors:     FatigueFactors
  contact_id:  string
  brokerage_id: string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function toRiskLevel(score: number): RiskLevel {
  if (score >= 75) return "critical"
  if (score >= 50) return "high"
  if (score >= 25) return "moderate"
  return "fresh"
}

function riskLabel(r: RiskLevel): string {
  return r.charAt(0).toUpperCase() + r.slice(1)
}

// ─── MAIN CALCULATOR ─────────────────────────────────────────────────────────

export async function calculateFatigue(
  contactId:   string,
  brokerageId: string,
): Promise<FatigueResult> {
  const supabase = createServiceClient()

  // ── 1. Load all raw stats ──────────────────────────────────────────────────

  const [showingsRes, toursRes, offersRes, signalsRes] = await Promise.all([
    // Total completed showings for this buyer
    supabase
      .from("showings")
      .select("id, scheduled_at", { count: "exact" })
      .eq("contact_id", contactId)
      .eq("status", "completed"),

    // Distinct tour days
    supabase
      .from("tours")
      .select("tour_date")
      .eq("contact_id", contactId)
      .eq("status", "completed"),

    // Rejected offers
    supabase
      .from("offers")
      .select("id, created_at", { count: "exact" })
      .eq("contact_id", contactId)
      .eq("status", "rejected"),

    // Behavior log signals with timestamps for engagement trend
    supabase
      .from("buyer_behavior_log")
      .select("created_at, signal_value")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  const totalShowings  = showingsRes.count ?? 0
  const tourDates      = new Set((toursRes.data ?? []).map(t => t.tour_date).filter(Boolean))
  const totalTourDays  = tourDates.size
  const offersRejected = offersRes.count ?? 0

  // Days searching = days since earliest showing or first offer attempt
  const allShowings = showingsRes.data ?? []
  let daysSearching = 0
  if (allShowings.length > 0) {
    const earliest = allShowings.reduce((min, s) =>
      s.scheduled_at < min ? s.scheduled_at : min,
      allShowings[0].scheduled_at
    )
    daysSearching = Math.floor(
      (Date.now() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24)
    )
  }

  // Engagement decline factor from behavior log
  const signals = signalsRes.data ?? []
  const now = Date.now()
  const ms14d = 14 * 24 * 60 * 60 * 1000
  const ms7d  =  7 * 24 * 60 * 60 * 1000

  const recent14Sum = signals
    .filter(s => now - new Date(s.created_at).getTime() <= ms14d)
    .reduce((acc, s) => acc + Number(s.signal_value ?? 1), 0)

  const prior14Sum = signals
    .filter(s => {
      const age = now - new Date(s.created_at).getTime()
      return age > ms14d && age <= ms14d * 2
    })
    .reduce((acc, s) => acc + Number(s.signal_value ?? 1), 0)

  const noSignals7d = !signals.some(
    s => now - new Date(s.created_at).getTime() <= ms7d
  )

  let engagementDeclineFactor = 0
  let engagementTrend = "stable"

  if (noSignals7d || (prior14Sum > 0 && recent14Sum / prior14Sum <= 0.4)) {
    engagementDeclineFactor = 2
    engagementTrend = noSignals7d ? "no recent activity" : "sharp decline"
  } else if (prior14Sum > 0 && recent14Sum / prior14Sum <= 0.7) {
    engagementDeclineFactor = 1
    engagementTrend = "declining"
  } else if (recent14Sum >= prior14Sum) {
    engagementTrend = "increasing"
  }

  // ── 2. Apply formula ───────────────────────────────────────────────────────

  const rawScore =
    (totalShowings   * 3) +
    (totalTourDays   * 8) +
    (daysSearching   / 10) +
    (offersRejected  * 15) +
    (engagementDeclineFactor * 20)

  const score     = Math.min(100, Math.round(rawScore))
  const riskLevel = toRiskLevel(score)

  const factors: FatigueFactors = {
    total_showings:            totalShowings,
    total_tour_days:           totalTourDays,
    days_searching:            daysSearching,
    offers_rejected:           offersRejected,
    engagement_decline_factor: engagementDeclineFactor,
    engagement_trend:          engagementTrend,
  }

  // ── 3. Upsert buyer_fatigue_scores ─────────────────────────────────────────

  await supabase
    .from("buyer_fatigue_scores")
    .upsert(
      {
        contact_id:           contactId,
        brokerage_id:         brokerageId,
        fatigue_score:        score,
        risk_level:           riskLevel,
        total_showings:       totalShowings,
        total_tour_days:      totalTourDays,
        days_searching:       daysSearching,
        offers_rejected:      offersRejected,
        engagement_trend:     engagementTrend,
        contributing_factors: factors,
        last_calculated_at:   new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )

  // ── 4. Alert logic for high/critical ──────────────────────────────────────

  if (riskLevel === "high" || riskLevel === "critical") {
    // Check for existing unresolved fatigue alert
    const { data: existingAlert } = await supabase
      .from("fatigue_alerts")
      .select("id")
      .eq("contact_id", contactId)
      .eq("dismissed", false)
      .maybeSingle()

    if (!existingAlert) {
      // Fetch contact for name + agent_id
      const { data: contact } = await supabase
        .from("contacts")
        .select("first_name, last_name, agent_id")
        .eq("id", contactId)
        .single()

      const buyerName = contact
        ? `${contact.first_name} ${contact.last_name}`
        : "This buyer"

      // AI-generated reinvigoration message (non-blocking on failure)
      let alertMessage = `${buyerName} has a fatigue score of ${score} (${riskLabel(riskLevel)}). ` +
        `${totalShowings} showings, ${totalTourDays} tour days, ` +
        `${daysSearching} days searching, ${offersRejected} rejected offers. ` +
        `Engagement trend: ${engagementTrend}.`

      try {
        const { text } = await generateText({
          model: "anthropic/claude-opus-4-5" as any,
          messages: [
            {
              role: "system",
              content:
                "You are a real estate agent coach. Write a single concise action recommendation (2 sentences max) for an agent whose buyer is showing signs of fatigue. Be specific and actionable.",
            },
            {
              role: "user",
              content:
                `Buyer: ${buyerName}. Score: ${score}/100 (${riskLevel}). ` +
                `${totalShowings} showings, ${totalTourDays} tour days, ` +
                `${daysSearching} days searching, ${offersRejected} rejected offers. ` +
                `Engagement: ${engagementTrend}. What should the agent do?`,
            },
          ],
          maxOutputTokens: 120,
        })
        alertMessage = text.trim()
      } catch {
        // Keep fallback message
      }

      // Insert fatigue_alert. pass 13: fatigue_alerts.agent_user_id FKs users(id)
      // but contacts.agent_id is agents.id — the raw stamp FK-threw and every
      // fatigue alert died unnoticed. Resolve to the owning agent's auth user id.
      //
      // ONE RESOLVER, TWO ANSWERS, RESOLVED ONCE. The ad-hoc `agents.select
      // ("user_id")` this replaced destructured no `error`, so a refused lookup
      // arrived as "this agent has no user" and was indistinguishable from it.
      // The shared resolver returns the crossing (`agents.id` → `users.id`) AND
      // that user's `users.brokerage_id`, which is the value the suggestion below
      // has to carry.
      const owningAgent = await resolveAgentRecipient(supabase, contact?.agent_id ?? null)
      const fatigueAgentUserId: string | null = owningAgent.ok ? owningAgent.userId : null
      const { data: alert } = await supabase
        .from("fatigue_alerts")
        .insert({
          contact_id:               contactId,
          brokerage_id:             brokerageId,
          agent_user_id:            fatigueAgentUserId,
          alert_type:               "fatigue_threshold_crossed",
          fatigue_score_at_trigger: score,
          risk_level:               riskLevel,
          message:                  alertMessage,
          dismissed:                false,
        })
        .select("id")
        .single()

      // Insert smart_assistant_suggestion.
      //
      // TENANT: the OWNING AGENT'S `users.brokerage_id` — deliberately not this
      // function's `brokerageId` argument, even though the two agree on every
      // live row today. `getContactCopilotSuggestions` reads this table
      // `.eq("agent_id", ctx.agentId).eq("brokerage_id", ctx.brokerageId)` with
      // both halves from one `getAgentContext()`, and that context's brokerage IS
      // `users.brokerage_id`. Stamping the anchor's brokerage instead would be
      // stamping a value the reader does not compute — wave 23's badge-count
      // lesson, which is that a wrong tenant hides the row exactly as NULL does.
      //
      // NO AGENT (or an unreadable one) → NO ROW. Both readers filter `agent_id`,
      // so an unattributed suggestion is invisible whatever it is stamped with.
      if (!owningAgent.ok) {
        console.error(`[fatigue] suggestion skipped — agent tenant unresolved: ${owningAgent.reason}`)
      } else if (!contact?.agent_id || !owningAgent.brokerageId) {
        console.error(
          `[fatigue] suggestion skipped for contact ${contactId} — ` +
          "the contact has no agent, or that agent has no users.brokerage_id; a suggestion nobody can read was not written",
        )
      } else {
        const { error: suggestionError } = await supabase.from("smart_assistant_suggestions").insert({
          agent_id:           contact.agent_id,
          brokerage_id:       owningAgent.brokerageId,
          title:              `${buyerName} showing signs of search fatigue`,
          description:        alertMessage,
          context_type:       "buyer_fatigue",
          action_type:        "view_buyer",
          action_payload_json: JSON.stringify({ contact_id: contactId }),
          priority:           riskLevel === "critical" ? "high" : "medium",
          status:             "pending",
        })
        if (suggestionError) {
          console.error("[fatigue] smart_assistant_suggestions insert refused:", suggestionError.message)
        }
      }

      // lifecycle_events sub-event
      await supabase.from("lifecycle_events").insert({
        brokerage_id:   brokerageId,
        entity_type:    "buyer_lifecycle",
        entity_id:      contactId,
        event_type:     KernelEvent.BUYER_FATIGUE_DETECTED,
        // lifecycle_events.actor_user_id FKs users(id) — contact.agent_id is an
        // agents.id, so the raw stamp FK-threw and the sub-event was lost even
        // though the alert beside it landed. Reuse the id already resolved above.
        actor_user_id:  fatigueAgentUserId,
        metadata: {
          fatigue_score:   score,
          risk_level:      riskLevel,
          alert_id:        alert?.id ?? null,
        },
      })
    }
  }

  return { score, risk_level: riskLevel, factors, contact_id: contactId, brokerage_id: brokerageId }
}

// ─── BATCH CALCULATOR ────────────────────────────────────────────────────────

// Was ten lowercase stage names — prospect, pre_approval_pending, touring, … —
// and contacts.buyer_stage admits NONE of them (the ladder is BUYER_*). The
// batch sweep below selected on them, so it has never processed a contact. The
// list also lived in this local const, which is why the CHECK-vocabulary guard
// (inline literals only) could not see it; it now comes from the shared ladder.
const ACTIVE_BUYER_STAGES = BUYER_ACTIVE_STAGES

export async function calculateAllBuyerFatigue(
  brokerageId?: string
): Promise<{ processed: number; errors: number }> {
  const supabase = createServiceClient()

  const query = supabase
    .from("contacts")
    .select("id, brokerage_id")
    .in("buyer_stage", ACTIVE_BUYER_STAGES)
    .is("deleted_at", null)

  if (brokerageId) {
    query.eq("brokerage_id", brokerageId)
  }

  const { data: contacts } = await query

  let processed = 0
  let errors    = 0

  for (const contact of contacts ?? []) {
    try {
      await calculateFatigue(contact.id, contact.brokerage_id)
      processed++
    } catch {
      errors++
    }
  }

  return { processed, errors }
}
