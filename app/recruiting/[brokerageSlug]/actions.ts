"use server"

/**
 * Public recruiting landing page server actions.
 *
 * Submitters are unauthenticated agents shopping for a new brokerage. Every
 * write goes through the service client + validates the brokerage slug
 * before doing anything sensitive. We do NOT trust caller-supplied
 * brokerage_id.
 *
 * Lead capture: inserts into recruits with referral_source='public_landing'
 * or 'agent_referral' (when ref=<agentId> is in the URL). Stamps
 * recruiter_agent_id for attribution so the referring agent gets credit
 * when the recruit eventually joins.
 *
 * Notification: fires NotificationService to the brokerage's broker(s) so
 * the recruit doesn't sit unanswered in a table. Best-effort.
 */

import { createServiceClient } from "@/lib/supabase/service"

const VALID_STATUS = "prospect" as const

export interface SubmitRecruitInquiryInput {
  brokerageSlug:    string
  firstName:        string
  lastName:         string
  email:            string
  phone?:           string
  licenseState?:    string
  currentBrokerage?:string
  yearsExperience?: number
  annualVolume?:    number
  notes?:           string
  /** Stamped from ?ref=<agentId> in the URL when the lead followed an
   *  agent's personal referral link. agentId is the agents.id value. */
  referringAgentId?: string | null
}

export interface SubmitRecruitInquiryResult {
  success: boolean
  recruitId?: string
  error?: string
}

export async function submitRecruitInquiry(
  input: SubmitRecruitInquiryInput
): Promise<SubmitRecruitInquiryResult> {
  // ── Validate the basics ───────────────────────────────────────────────────
  if (!input.brokerageSlug) return { success: false, error: "Missing brokerage" }
  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    return { success: false, error: "First and last name are required" }
  }
  if (!input.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return { success: false, error: "A valid email is required so the broker can reach you" }
  }

  const svc = createServiceClient()

  // ── Resolve the brokerage from its slug ───────────────────────────────────
  const { data: brokerage } = await svc
    .from("brokerages")
    .select("id, name")
    .eq("slug", input.brokerageSlug)
    .maybeSingle()
  if (!brokerage) {
    return { success: false, error: "Brokerage not found" }
  }

  // ── Validate the referring agent (if any) belongs to this brokerage ──────
  // We don't trust the URL param. If the agent isn't in this brokerage we
  // simply drop the attribution rather than reject the submission.
  let recruiterAgentId: string | null = null
  if (input.referringAgentId) {
    const { data: agentRow } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .eq("id", input.referringAgentId)
      .maybeSingle()
    if (agentRow && agentRow.brokerage_id === brokerage.id) {
      recruiterAgentId = agentRow.id
    }
  }

  // ── Insert the recruit row ────────────────────────────────────────────────
  const { data: recruit, error } = await svc
    .from("recruits")
    .insert({
      brokerage_id:         brokerage.id,
      recruiter_agent_id:   recruiterAgentId,
      first_name:           input.firstName.trim(),
      last_name:            input.lastName.trim(),
      email:                input.email.trim().toLowerCase(),
      phone:                input.phone?.trim() || null,
      license_state:        input.licenseState?.trim().toUpperCase().slice(0, 2) || null,
      current_brokerage:    input.currentBrokerage?.trim() || null,
      years_experience:     input.yearsExperience ?? null,
      annual_volume:        input.annualVolume ?? null,
      status:               VALID_STATUS,
      notes:                input.notes?.trim() || null,
      contact_method:       "public_landing_form",
      referral_source:      recruiterAgentId ? "agent_referral" : "public_landing",
      provisioned:          false,
    })
    .select("id")
    .maybeSingle()

  if (error || !recruit) {
    return { success: false, error: error?.message ?? "Failed to record your interest" }
  }

  // ── Notify the broker (best-effort) ───────────────────────────────────────
  try {
    const { data: brokerUsers } = await svc
      .from("users")
      .select("id")
      .eq("brokerage_id", brokerage.id)
      .in("user_type", ["broker", "admin"])
      .limit(5)
    const recipients = (brokerUsers ?? []).map((u: { id: string }) => u.id)
    if (recipients.length > 0) {
      const rows = recipients.map((userId) => ({
        user_id:       userId,
        brokerage_id:  brokerage.id,
        type:          "recruit_inquiry",
        title:         `New recruit interested in ${brokerage.name}`,
        body:          `${input.firstName} ${input.lastName} (${input.email}) just submitted the public recruiting page${recruiterAgentId ? " — referred by one of your agents" : ""}.`,
        entity_type:   "recruit",
        entity_id:     recruit.id,
        priority:      "high",
        channel:       "in_app",
        is_read:       false,
      }))
      await svc.from("notifications").insert(rows)
    }
  } catch (notifyErr) {
    console.error("[submitRecruitInquiry] Notification failed:", notifyErr)
  }

  // ── Notify the referring agent (best-effort) ─────────────────────────────
  if (recruiterAgentId) {
    try {
      const { data: agentUser } = await svc
        .from("agents")
        .select("user_id")
        .eq("id", recruiterAgentId)
        .maybeSingle()
      if (agentUser?.user_id) {
        await svc.from("notifications").insert({
          user_id:       agentUser.user_id,
          brokerage_id:  brokerage.id,
          type:          "recruit_referral_inquiry",
          title:         "Your referral filled out the recruiting page",
          body:          `${input.firstName} ${input.lastName} just expressed interest after using your referral link. You'll be credited if they join.`,
          entity_type:   "recruit",
          entity_id:     recruit.id,
          priority:      "medium",
          channel:       "in_app",
          is_read:       false,
        })
      }
    } catch (notifyErr) {
      console.error("[submitRecruitInquiry] Referrer notification failed:", notifyErr)
    }
  }

  return { success: true, recruitId: recruit.id }
}
