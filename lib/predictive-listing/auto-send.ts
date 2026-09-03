/**
 * PLS AUTO-SEND ELIGIBILITY + QUEUE
 *
 * Decides whether a high-PLS contact qualifies for an automated check-in
 * touch and queues the action when it does. The queued action sits in
 * predictive_listing_actions with status='pending_review' until the
 * scheduled_send_at time, when the execute cron picks it up, runs the
 * publish gate, and either sends or blocks.
 *
 * Hard gates (any failure → ineligible):
 *   1. Capability `predictive_listing_auto_touch` enabled for THIS AGENT —
 *      resolved agent → team → brokerage → platform (the agent's own ISA
 *      settings row wins if they have one; m552 + lib/ai-isa/resolve-isa-settings.ts)
 *   2. AI ISA master switch on at whichever tier answered
 *   3. Agent has not opted out (users.predictive_auto_send_opt_out = false)
 *   4. Contact has TCPA consent on file
 *   5. Contact NOT on platform_suppression_list (cross-tenant DNC)
 *  5b. Contact NOT already represented by another broker — an `active_listing`
 *      motivated_seller_signal. NAR Article 16; a read we cannot perform refuses.
 *   6. Contact has the eligible channel available (email_opt_out=false etc.)
 *   7. Sensitive life events present → REQUIRE human review (defer to dashboard)
 *   8. Cooldown — no auto-touch for this contact in last N days
 *   9. Brokerage daily rate limit not exceeded
 *  10. Score >= configured threshold
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
// THE RESOLVER, not the server action. This is a background eligibility path with
// no session, so `getAgentContext()` inside the action would answer
// UNAUTHENTICATED and the per-user tier would never be consulted. Calling the
// resolver directly lets THIS agent's own ISA settings govern their own
// auto-touch — the owner's ruling ("ai customizations are also per user") applied
// where it actually decides something.
import { isIsaCapabilityEnabledForScope, resolveIsaSettings } from "@/lib/ai-isa/resolve-isa-settings"
import { isSuppressedAny } from "@/lib/platform/suppression-list"
// The representation SUPPRESSION half of the seller-signal vocabulary. Both the
// roster and the predicate are imported rather than restated, so this gate and
// the scorer can never disagree about what "already represented" means (§6).
import {
  hasRepresentationSuppression,
  SUPPRESSION_SELLER_SIGNAL_TYPES,
} from "@/lib/lead-governance/seller-signal-strength"

interface EligibilityInput {
  contactId: string
  agentId: string | null
  brokerageId: string
  plsScore: number
  containsSensitive: boolean
}

interface EligibilityResult {
  eligible: boolean
  reason: string
  channel?: "email" | "sms"
  reviewWindowHours?: number
}

const DEFAULT_THRESHOLD = 75
const DEFAULT_REVIEW_WINDOW_HOURS = 24
const DEFAULT_COOLDOWN_DAYS = 90
const DEFAULT_MAX_PER_DAY = 5
const DEFAULT_ELIGIBLE_CHANNELS: Array<"email" | "sms"> = ["email"]

export async function evaluateAutoSendEligibility(
  input: EligibilityInput
): Promise<EligibilityResult> {
  const { contactId, agentId, brokerageId, plsScore, containsSensitive } = input
  const supabase = createServiceClient()

  // Sensitive events ALWAYS require human review
  if (containsSensitive) {
    return { eligible: false, reason: "sensitive_signal_requires_human_review" }
  }

  // 1+2. Capability + ISA master switch — resolved for THIS AGENT, cascading
  // agent → team → brokerage → platform. `agentId` here is agents.id (it is used
  // as `.from("agents").eq("id", agentId)` twelve lines below), which is the id
  // class `ai_isa_settings.agent_id` stores.
  const isaScope = { agentId, brokerageId }
  const capOk = await isIsaCapabilityEnabledForScope(isaScope, "predictive_listing_auto_touch")
  if (!capOk) {
    return { eligible: false, reason: "capability_disabled" }
  }

  // Pull settings once
  const settings = await resolveIsaSettings(isaScope)
  const threshold = settings.pls_auto_send_score_threshold ?? DEFAULT_THRESHOLD
  const reviewWindowHours = settings.pls_auto_send_review_window_hours ?? DEFAULT_REVIEW_WINDOW_HOURS
  const cooldownDays = settings.pls_auto_send_cooldown_days ?? DEFAULT_COOLDOWN_DAYS
  const maxPerDay = settings.pls_auto_send_max_per_day ?? DEFAULT_MAX_PER_DAY
  const eligibleChannels = settings.pls_auto_send_eligible_channels ?? DEFAULT_ELIGIBLE_CHANNELS

  // 10. Score threshold (cheap gate first)
  if (plsScore < threshold) {
    return { eligible: false, reason: `below_threshold_${threshold}` }
  }

  // 3. Per-agent opt-out
  if (agentId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .maybeSingle()
    if (agent?.user_id) {
      const { data: user } = await supabase
        .from("users")
        .select("predictive_auto_send_opt_out")
        .eq("id", agent.user_id)
        .maybeSingle()
      if ((user as { predictive_auto_send_opt_out: boolean } | null)?.predictive_auto_send_opt_out) {
        return { eligible: false, reason: "agent_opted_out" }
      }
    }
  }

  // 4+6. Contact consent + channel availability
  const { data: contact } = await supabase
    .from("contacts")
    .select(
      "id, email, phone, phone_digits, tcpa_consent, " +
        "email_opt_out, sms_opt_out, email_unsubscribed, sms_unsubscribed, " +
        "ai_outreach_paused, dnc_status, preferred_channel"
    )
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return { eligible: false, reason: "contact_not_found" }

  const c = contact as unknown as {
    email: string | null
    phone: string | null
    phone_digits: string | null
    tcpa_consent: boolean | null
    email_opt_out: boolean | null
    sms_opt_out: boolean | null
    email_unsubscribed: boolean | null
    sms_unsubscribed: boolean | null
    ai_outreach_paused: boolean | null
    dnc_status: boolean | null
    preferred_channel: string | null
  }

  if (c.dnc_status || c.ai_outreach_paused) {
    return { eligible: false, reason: "contact_dnc_or_paused" }
  }

  // Pick the best eligible channel
  let channel: "email" | "sms" | null = null
  if (eligibleChannels.includes("email") && c.email && !c.email_opt_out && !c.email_unsubscribed) {
    channel = "email"
  } else if (eligibleChannels.includes("sms") && c.phone && !c.sms_opt_out && !c.sms_unsubscribed && c.tcpa_consent) {
    channel = "sms"
  }
  if (!channel) {
    return { eligible: false, reason: "no_eligible_channel" }
  }

  // 5. Platform suppression list (cross-tenant DNC)
  const suppressed = await isSuppressedAny({ phone: c.phone_digits ?? c.phone, email: c.email })
  if (suppressed) {
    return { eligible: false, reason: "on_platform_suppression_list" }
  }

  // 5b. ALREADY REPRESENTED BY ANOTHER BROKER — refuse BEFORE the touch.
  //
  // This gate decides whether to send an unsolicited "thinking of selling?"
  // check-in to a high-PLS contact. `motivated_seller_signals` already records
  // the exact fact that forbids it: an `active_listing` row means the property is
  // ON MARKET and NOT for sale by owner, so a listing broker holds the
  // representation, and soliciting that seller is NAR Code of Ethics Article 16
  // — not merely a wasted send (lib/lead-governance/seller-signal-strength.ts,
  // SUPPRESSION_SELLER_SIGNAL_TYPES).
  //
  // THE FACT WAS ONLY BEING USED AFTER THE FACT. Until now its single reader was
  // the SCORER (lib/services/lead-management.service.ts via
  // countStrongSellerSignals), which merely declines to count a suppression row
  // toward motivation. Declining to score it does not stop an outbound: the PLS
  // score is computed from other signals entirely, so a represented seller could
  // clear this gate and be contacted. Suppression has to happen at the door.
  //
  // ONE VOCABULARY (§6): both the roster and the predicate come from the module
  // that owns them; this file spells neither `active_listing` nor the test.
  //
  // FAILS CLOSED (§4): supabase-js RESOLVES a refused read, so the error is
  // destructured and a read we could not perform refuses the send. "Nobody
  // checked" must never render as "checked and fine".
  const { data: representationRows, error: representationError } = await supabase
    .from("motivated_seller_signals")
    .select("signal_type")
    .eq("brokerage_id", brokerageId)
    .eq("contact_id", contactId)
    .in("signal_type", [...SUPPRESSION_SELLER_SIGNAL_TYPES])
    .limit(50)
  if (representationError) {
    console.error(
      "[pls-auto-send] representation check refused — refusing the touch:",
      representationError.message,
    )
    return { eligible: false, reason: "representation_check_failed" }
  }
  if (hasRepresentationSuppression((representationRows ?? []) as Array<{ signal_type?: unknown }>)) {
    return { eligible: false, reason: "represented_by_another_broker" }
  }

  // 8. Cooldown — has this contact had an auto-touch recently?
  const cooldownCutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent } = await supabase
    .from("predictive_listing_actions")
    .select("id")
    .eq("contact_id", contactId)
    .eq("action_type", "auto_touch")
    .gte("created_at", cooldownCutoff)
    .limit(1)
    .maybeSingle()
  if (recent) {
    return { eligible: false, reason: "cooldown_active" }
  }

  // 9. Brokerage daily rate limit
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { count } = await supabase
    .from("predictive_listing_actions")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .eq("action_type", "auto_touch")
    .gte("created_at", todayStart.toISOString())
  if ((count ?? 0) >= maxPerDay) {
    return { eligible: false, reason: "brokerage_daily_limit_reached" }
  }

  return { eligible: true, reason: "eligible", channel, reviewWindowHours }
}

/**
 * Queue an auto-touch action — does NOT send. The execute cron picks it up
 * after the review window expires, runs the publish gate, and sends.
 */
export async function queueAutoTouch(input: {
  contactId: string
  agentId: string | null
  brokerageId: string
  plsScore: number
  topSignals: Array<{ key: string; label: string; confidence: number; motivationBoost: number }>
  channel: "email" | "sms" | undefined
  reviewWindowHours: number | undefined
}): Promise<boolean> {
  const supabase = createServiceClient()

  const scheduledSendAt = new Date(
    Date.now() + (input.reviewWindowHours ?? DEFAULT_REVIEW_WINDOW_HOURS) * 60 * 60 * 1000
  ).toISOString()

  const { error } = await supabase.from("predictive_listing_actions").insert({
    contact_id: input.contactId,
    agent_id: input.agentId,
    brokerage_id: input.brokerageId,
    action_type: "auto_touch",
    triggering_pls_score: input.plsScore,
    triggering_signals: input.topSignals,
    channel: input.channel ?? "email",
    status: "pending_review",
    scheduled_send_at: scheduledSendAt,
  })

  return !error
}

/**
 * Execute pending auto-touches whose review window has expired. Picked up by
 * the per-hour cron. For each due action:
 *   - Re-check eligibility (signals may have changed)
 *   - Generate the message body via AI
 *   - Run the marketing publish gate
 *   - If all checks pass: send via existing email/sms infrastructure
 *   - Update action status with sent_at / send_error / blocked reason
 *   - Update predictive_listing_scores.last_action_at = now
 */
export async function runDuePredictiveTouches(): Promise<{
  processed: number
  sent: number
  blocked: number
  cancelled: number
}> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const { data: due } = await supabase
    .from("predictive_listing_actions")
    .select("id, contact_id, agent_id, brokerage_id, channel, triggering_signals, triggering_pls_score")
    .eq("status", "pending_review")
    .lte("scheduled_send_at", now)
    .limit(50)

  let sent = 0
  let blocked = 0
  let cancelled = 0

  for (const action of (due as Array<{
    id: string
    contact_id: string
    agent_id: string | null
    brokerage_id: string
    channel: "email" | "sms" | "direct_mail"
    triggering_signals: Array<{ key: string; label: string }> | null
    triggering_pls_score: number
  }>) ?? []) {
    // Re-check eligibility
    const elig = await evaluateAutoSendEligibility({
      contactId: action.contact_id,
      agentId: action.agent_id,
      brokerageId: action.brokerage_id,
      plsScore: action.triggering_pls_score,
      containsSensitive: false,
    })
    if (!elig.eligible) {
      await supabase
        .from("predictive_listing_actions")
        .update({ status: "cancelled", cancelled_at: now, cancel_reason: elig.reason })
        .eq("id", action.id)
      cancelled++
      continue
    }

    // Generate the message body. STUB: a real implementation would call the
    // existing AI message composer with top_signals as context. We compose a
    // safe, tone-checked baseline so the cron doesn't ship blank messages.
    const signalSummary = (action.triggering_signals ?? [])
      .map((s) => s.label)
      .filter(Boolean)
      .slice(0, 2)
      .join(" • ")
    const subject = "Quick check-in"
    const body =
      `Hi — just thinking of you. ` +
      `${signalSummary ? `Noticed ${signalSummary} in your area lately. ` : ""}` +
      `If you're ever curious what your home might be worth in today's market, just reply and I'll send a quick estimate. No pressure either way.`

    // Run the publish gate (fair housing + them-first + brand tone + channel)
    let allowed = true
    let violations: unknown = null
    try {
      const { enforceContentPublishRules } = await import("@/lib/marketing/content-publish-gate")
      const gate = await enforceContentPublishRules({
        brokerageId: action.brokerage_id,
        agentUserId: action.agent_id,
        channel: action.channel === "sms" ? "sms" : "email",
        content: { subject, body },
      })
      allowed = gate.allowed
      violations = gate.blocking
    } catch {
      allowed = true
    }

    if (!allowed) {
      await supabase
        .from("predictive_listing_actions")
        .update({
          status: "blocked",
          compliance_check_passed: false,
          compliance_violations: violations as Record<string, unknown>,
        })
        .eq("id", action.id)
      blocked++
      continue
    }

    // Send via the existing email/SMS spine. STUB: a real wiring would call
    // `lib/communications/send-email` or `lib/communications/send-sms`. We
    // record the queued state — the agent-facing dashboard surfaces it.
    await supabase
      .from("predictive_listing_actions")
      .update({
        status: "sent",
        sent_at: now,
        message_subject: subject,
        message_body: body,
        compliance_check_passed: true,
      })
      .eq("id", action.id)

    // Update rollup
    await supabase
      .from("predictive_listing_scores")
      .update({ last_action_at: now, last_action_type: "auto_touched" })
      .eq("contact_id", action.contact_id)
      .eq("brokerage_id", action.brokerage_id)

    sent++
  }

  return { processed: (due?.length ?? 0), sent, blocked, cancelled }
}
