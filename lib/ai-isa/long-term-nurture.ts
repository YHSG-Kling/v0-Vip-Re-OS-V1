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

import { createServiceClient } from "@/lib/supabase/service"

const REACTIVATION_SCORE_THRESHOLD = 65

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

  // 1. Fetch leads currently in long-term nurture
  const { data: leads, error } = await supabase
    .from("leads")
    .select(
      "id, brokerage_id, contact_id, long_term_nurture_until, long_term_nurture_started_at, lead_score, motivation_type"
    )
    .eq("lifecycle_state", "long_term_nurture")
    .eq("is_active", true)
    .limit(limit)

  if (error || !leads) {
    return { total: 0, enrolledMonthly: 0, reactivated: 0, expired: 0 }
  }

  let enrolledMonthly = 0
  let reactivated = 0
  let expired = 0

  for (const lead of leads) {
    // 2. Expire window — push them out of nurture if window passed
    if (lead.long_term_nurture_until && new Date(lead.long_term_nurture_until) < new Date()) {
      await supabase
        .from("leads")
        .update({
          lifecycle_state: "unconsented",
          long_term_nurture_until: null,
          ai_outreach_paused: false,
          updated_at: nowIso,
        })
        .eq("id", lead.id)
      expired++
      continue
    }

    // 3. Reactivation check — has any new signal pushed score above threshold?
    const { count: recentSignals } = await supabase
      .from("signal_reactivations")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", lead.id)
      .eq("isa_reactivated", false)
      .gte("triggered_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

    const score = lead.lead_score ?? 0

    if ((recentSignals ?? 0) > 0 && score >= REACTIVATION_SCORE_THRESHOLD) {
      await supabase
        .from("leads")
        .update({
          lifecycle_state: "unconsented",
          long_term_nurture_until: null,
          ai_outreach_paused: false,
          ai_isa_owner: true,
          updated_at: nowIso,
        })
        .eq("id", lead.id)

      // Mark all unprocessed signals as reactivated
      await supabase
        .from("signal_reactivations")
        .update({ isa_reactivated: true, isa_reactivated_at: nowIso })
        .eq("lead_id", lead.id)
        .eq("isa_reactivated", false)

      reactivated++
      continue
    }

    // 4. Monthly enrollment — only enroll if this lead has not had a touch
    //    in the last 25 days (prevent over-sending if the cron runs more
    //    than monthly). Resolve a per-brokerage sequence by name pattern;
    //    if no matching sequence exists, log only (cadence still tracked
    //    by long_term_nurture_until).
    const { data: recentEnrollment } = await supabase
      .from("sequence_enrollments")
      .select("id, enrolled_at")
      .eq("lead_id", lead.id)
      .gte("enrolled_at", new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle()

    if (!recentEnrollment) {
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
        await supabase.from("sequence_enrollments").insert({
          sequence_id: sequenceRow.id,
          lead_id: lead.id,
          contact_id: lead.contact_id,
          brokerage_id: lead.brokerage_id,
          enrolled_at: nowIso,
          status: "active",
          current_step: 0,
        })
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
