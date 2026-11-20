/**
 * LONG-TERM NURTURE
 *
 * Leads that the ISA marked as `not_ready_now` (genuinely interested someday
 * but not now) sit in `lifecycle_state = 'long_term_nurture'` with
 * `long_term_nurture_until` set to a future date.
 *
 * This module:
 *   1. Sends monthly market updates while the lead is in nurture
 *   2. Sends an annual home value report (sellers) / market check-in (buyers)
 *   3. Watches for re-activation signals and pulls the lead back to the ISA
 *      if a signal pushes the score above threshold
 *
 * Reactivation triggers (`signal_reactivations` table):
 *   - Equity event (refinance opportunity)
 *   - Neighbor sold high
 *   - FSBO listing pulled
 *   - Divorce filing
 *   - Listing expired
 *   - Search-portal activity resumed
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { excludeConvertedLeads } from "@/lib/contact-promotion/conversion-finality"
import { loadFollowupPolicy, type FollowupPolicy } from "@/lib/ai-isa/followup-policy"
import { arbitrateCadence, countArbiterWaits, recordArbitration, type ArbiterBudget } from "@/lib/ai-isa/followup-arbiter"
import { resolvePolicyRef } from "@/lib/kernel/tenant-policy"

// WAVE 143 (lane 143E; owner: "the follow-up timetable must not depend on code"): REACTIVATION_SCORE_THRESHOLD (65), the 7-day
// signal window and the 25-day "monthly" enrollment spacing were literals here. They are the tenant's versioned followup_policy.nurture
// now (lib/ai-isa/followup-policy.ts — platform defaults 65 / 7 / 25, unchanged), loaded once per tenant per sweep, and the monthly
// enrollment is no longer an automatic "25 days passed ⇒ enroll": a due enrollment goes to the arbiter (lib/ai-isa/followup-arbiter.ts
// arbitrateCadence), which releases it or holds it for a bounded time from the lead's evidence; its rationale is a ledger row.

export async function runMonthlyNurtureCadence(params?: {
  limit?: number
}): Promise<{
  total: number
  enrolledMonthly: number
  reactivated: number
  expired: number
}> {
  const supabase = createServiceClient()
  const limit = params?.limit ?? 500

  const nowIso = new Date().toISOString()

  // 1. Fetch leads currently in long-term nurture.
  //
  // CONVERSION FINALITY: this query already SELECTED `contact_id` — and then
  // used it only to stamp the `sequence_enrollments` row it creates below. It
  // never refused on it. So a converted lead sitting in long-term nurture kept
  // being enrolled into monthly nurture sequences, kept having its
  // `lifecycle_state` and `ai_isa_owner` rewritten, and kept having signal rows
  // flipped — all lead-keyed updates on a person who is already a client. The
  // sweep now cannot see them at all.
  const { data: leads, error } = await excludeConvertedLeads(
    supabase
      .from("leads")
      .select(
        "id, brokerage_id, contact_id, long_term_nurture_until, long_term_nurture_started_at, lead_score, motivation_type"
      )
      .eq("lifecycle_state", "long_term_nurture")
      .eq("is_active", true)
      .limit(limit),
  )

  if (error || !leads) {
    return { total: 0, enrolledMonthly: 0, reactivated: 0, expired: 0 }
  }

  let enrolledMonthly = 0
  let reactivated = 0
  let expired = 0

  // One policy + one decision budget + one policy ref per tenant per sweep (the leads span tenants).
  const tenant = new Map<string, { policy: FollowupPolicy; budget: ArbiterBudget; ref: string }>()
  const tenantFor = async (brokerageId: string) => {
    let t = tenant.get(brokerageId)
    if (!t) {
      const { policy } = await loadFollowupPolicy(supabase, brokerageId)
      t = { policy, budget: { remaining: policy.arbiter.maxDecisionsPerRun }, ref: await resolvePolicyRef(supabase, brokerageId, "followup_policy") }
      tenant.set(brokerageId, t)
    }
    return t
  }

  for (const lead of leads) {
    const { policy: followup, budget: arbiterBudget, ref: followupPolicyRef } = await tenantFor(lead.brokerage_id)
    // 2. Expire window — push them out of nurture if window passed
    if (lead.long_term_nurture_until && new Date(lead.long_term_nurture_until) < new Date()) {
      const { error: expireErr } = await supabase
        .from("leads")
        .update({
          lifecycle_state: "unconsented",
          long_term_nurture_until: null,
          ai_outreach_paused: false,
          updated_at: nowIso,
        })
        .eq("id", lead.id)
      if (expireErr) console.error(`[long-term-nurture] expired nurture window NOT cleared on the lead: ${expireErr.message}`)
      expired++
      continue
    }

    // 3. Reactivation check — has any new signal pushed score above threshold?
    const { count: recentSignals } = await supabase
      .from("signal_reactivations")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", lead.id)
      .eq("isa_reactivated", false)
      .gte("triggered_at", new Date(Date.now() - followup.nurture.signalWindowDays * 24 * 60 * 60 * 1000).toISOString())

    const score = lead.lead_score ?? 0

    if ((recentSignals ?? 0) > 0 && score >= followup.nurture.reactivationScoreThreshold) {
      const { error: reactivateErr } = await supabase
        .from("leads")
        .update({
          lifecycle_state: "unconsented",
          long_term_nurture_until: null,
          ai_outreach_paused: false,
          ai_isa_owner: true,
          updated_at: nowIso,
        })
        .eq("id", lead.id)
      if (reactivateErr) console.error(`[long-term-nurture] lead NOT reactivated to the ISA: ${reactivateErr.message}`)

      // Mark all unprocessed signals as reactivated
      await sentinelWrite(supabase, supabase
        .from("signal_reactivations")
        .update({ isa_reactivated: true, isa_reactivated_at: nowIso })
        .eq("lead_id", lead.id)
        .eq("isa_reactivated", false), { table: "signal_reactivations", flow: "signal_reactivations_write", reason: "marks signals consumed; a lost stamp only re-evaluates them next run" })

      reactivated++
      continue
    }

    // 4. Monthly enrollment — only enroll if this lead has not had a touch
    //    inside the tenant's enrollment spacing (followup_policy.nurture, default
    //    25 days — prevents over-sending if the cron runs more than monthly). Resolve a per-brokerage sequence by name pattern;
    //    if no matching sequence exists, log only (cadence still tracked
    //    by long_term_nurture_until).
    const { data: recentEnrollment } = await supabase
      .from("sequence_enrollments")
      .select("id, enrolled_at")
      .eq("lead_id", lead.id)
      .gte("enrolled_at", new Date(Date.now() - followup.nurture.enrollmentSpacingDays * 24 * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle()

    if (!recentEnrollment) {
      // THE ARBITER (wave 143): the spacing says an enrollment is DUE; whether THIS lead gets it now, or is held for a bounded time,
      // is judged from the evidence (score, how long they have been in nurture, what they said they prefer). Outage / refusal /
      // spent budget / unreadable ledger ⇒ the deterministic enrollment proceeds exactly as before.
      const nowForArbiter = new Date()
      const deferredDays = await countArbiterWaits(supabase, { brokerageId: lead.brokerage_id, subject: { type: "lead", id: lead.id }, now: nowForArbiter, policy: followup })
      const arb = await arbitrateCadence({
        brokerageId: lead.brokerage_id,
        policy: followup,
        cadence: { shouldSend: true, phase: 3, daysSinceStart: lead.long_term_nurture_started_at ? Math.max(0, Math.floor((nowForArbiter.getTime() - new Date(lead.long_term_nurture_started_at).getTime()) / 86_400_000)) : 0, reason: "nurture_enrollment_due" },
        facts: {
          leadTemperature: null, leadScore: typeof lead.lead_score === "number" ? lead.lead_score : null, timeline: null, attempts: 0,
          hoursSinceLastOutreach: null, hoursSinceLastActivity: null,
          daysDeferred: deferredDays ?? followup.arbiter.maxDeferDays, source: (lead.motivation_type as string | null) ?? null, preferences: [],
        },
        budget: arbiterBudget,
      })
      if (arb.decision) {
        const rec = await recordArbitration(supabase, { brokerageId: lead.brokerage_id, subject: { type: "lead", id: lead.id }, decision: arb.decision, now: nowForArbiter, policyRef: followupPolicyRef, systemSource: "long_term_nurture" })
        if (!rec.recorded && rec.error) console.warn(`[long-term-nurture] arbitration not ledgered for lead ${lead.id}: ${rec.error}`)
      }
      if (!arb.sendNow) continue
      const namePattern =
        lead.motivation_type === "seller_motivated"
          ? "%long-term nurture seller%"
          : "%long-term nurture buyer%"

      const { data: sequenceRow } = await supabase
        .from("campaign_sequences")
        .select("id")
        .eq("brokerage_id", lead.brokerage_id)
        .ilike("name", namePattern)
        .limit(1)
        .maybeSingle()

      if (sequenceRow?.id) {
        const { error: nurtureEnrollErr } = await supabase.from("sequence_enrollments").insert({
          sequence_id: sequenceRow.id,
          lead_id: lead.id,
          contact_id: lead.contact_id,
          brokerage_id: lead.brokerage_id,
          enrolled_at: nowIso,
          status: "active",
          current_step: 0,
        })
        if (nurtureEnrollErr) console.error(`[long-term-nurture] lead NOT enrolled in the nurture sequence: ${nurtureEnrollErr.message}`)
        enrolledMonthly++
      }
    }
  }

  return { total: leads.length, enrolledMonthly, reactivated, expired }
}

/**
 * Manually log a re-activation signal for a lead. Called by external
 * pipelines (e.g., listing-expiry watcher, equity watcher) when they detect
 * a new signal worth waking the ISA up for.
 */
export async function recordReactivationSignal(params: {
  leadId?: string
  contactId?: string
  brokerageId?: string
  signalType: string
  signalStrength?: number
  signalData?: Record<string, unknown>
}): Promise<{ id: string | null }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("signal_reactivations")
    .insert({
      lead_id: params.leadId ?? null,
      contact_id: params.contactId ?? null,
      brokerage_id: params.brokerageId ?? null,
      signal_type: params.signalType,
      signal_strength: params.signalStrength ?? null,
      signal_data: params.signalData ?? null,
      triggered_at: new Date().toISOString(),
      isa_reactivated: false,
    })
    .select("id")
    .single()

  if (error) return { id: null }
  return { id: data?.id ?? null }
}
