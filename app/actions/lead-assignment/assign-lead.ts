"use server"

import { createClient } from "@/lib/supabase/server"
import {
  evaluateAndAssignLead,
  claimLead,
} from "@/lib/lead-assignment/assignment-engine"
import { handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function assignLead(
  leadId: string
): Promise<{ assigned: boolean; agentId?: string; reason: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.id) throw new Error("Unauthorized")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) throw new Error("No brokerage found for user")

  if (!isAdminOrBroker({ user_type: profile.user_type ?? "" })) {
    throw new Error("Forbidden: insufficient permissions to assign leads")
  }

  return await evaluateAndAssignLead({
    leadId,
    brokerageId: profile.brokerage_id,
  })
}

/**
 * Manual assignment: admin/broker selects a specific agent for a lead.
 * Role gate enforced — same admin check as assignLead above.
 *
 * Business process (canonical): leads are only assigned AFTER the AI ISA has
 * qualified them, and assignment converts the lead to a contact owned by the
 * assigned agent. Manual assignment therefore enforces the SAME gate as the
 * automated engine and routes through handleLeadAssigned (which stamps
 * agent_id, logs assignment, advances lifecycle, and auto-creates the contact)
 * — it must never be a side door around qualification or contact conversion.
 *
 * (Previous version updated leads directly with phantom columns
 * assigned_agent_id/assigned_at — contacts/leads have agent_id — which
 * PGRST204-failed the whole update: manual assignment was silently broken.)
 */
export async function manualAssignLead(
  leadId: string,
  agentId: string,
): Promise<{ success: boolean; reason?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.id) throw new Error("Unauthorized")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!isAdminOrBroker({ user_type: profile?.user_type ?? "" })) {
    throw new Error("Forbidden: insufficient permissions to assign leads")
  }
  if (!profile?.brokerage_id) throw new Error("No brokerage found for user")

  const { data: lead } = await supabase
    .from("leads")
    .select("id, brokerage_id, lead_stage, lifecycle_state, lead_score, agent_id")
    .eq("id", leadId)
    .single()

  if (!lead) throw new Error("Lead not found")
  if (lead.brokerage_id !== profile.brokerage_id) {
    throw new Error("Lead is outside your brokerage")
  }
  if (lead.agent_id) throw new Error("Lead already has an assigned agent")

  // Same gate as the automated engine: AI-ISA qualification + consent first.
  const isQualified = lead.lead_stage === "qualified"
  const isConsented = ["consented", "qualified", "assigned"].includes(lead.lifecycle_state ?? "")
  if (!isQualified || !isConsented) {
    throw new Error(
      "Lead must be qualified by the AI ISA (and consented) before assignment — " +
        `currently lead_stage='${lead.lead_stage}', lifecycle_state='${lead.lifecycle_state}'.`,
    )
  }

  await handleLeadAssigned({
    leadId,
    brokerageId: profile.brokerage_id,
    agentId,
    method: "manual",
    scoreAtAssignment: lead.lead_score ?? 0,
  })

  return { success: true }
}

/**
 * Close out the ASSIGNMENT-LOG side of a claim.
 *
 * This is NOT the same verb as app/actions/lead-lifecycle.ts:98 `claimLead`,
 * which is what the Available Leads sheet calls to move the lead itself
 * (leads.agent_id + lead_stage='claimed'). This one flips the
 * `assignment_log` row for the lead from claimed=false to claimed=true under
 * an optimistic lock and emits KernelEvent.LEAD_CLAIMED so the claim fans out
 * (staff notification / sequence enrollment / portal update).
 *
 * WHY IT MATTERS THAT IT HAD NO CALLER: `assignment_log.claimed` is inserted
 * false by app/actions/leads.ts:236 and READ by three live surfaces as the
 * "handoff still awaiting first touch" signal —
 * lib/intelligence/daily-briefing-generator.ts, lib/intelligence/isa-overnight.ts
 * (handoffs_unclaimed) and lib/intelligence/user-type-briefs/team-lead.ts.
 * lib/lead-assignment/assignment-engine.ts:claimLead is the ONLY writer that
 * ever sets it true, and this action was its only entry point, so no ISA
 * handoff has ever been marked claimed: the unclaimed counter on the daily
 * briefing and the team-lead brief could only ever go up.
 *
 * TENANT GATE (added). This is a `"use server"` export that takes a bare lead
 * id and acts on it, and the engine behind it runs on the SERVICE client and
 * filters `assignment_log` by lead_id ALONE — no brokerage predicate, RLS
 * bypassed. Any signed-in user of any tenant could therefore close out another
 * brokerage's handoff and emit a LEAD_CLAIMED event attributed to themselves
 * against that tenant. The lead is now proved to be in the caller's brokerage,
 * through the cookie client so RLS applies to the check itself, and it fails
 * CLOSED: a refused read is a refusal, not a pass.
 */
export async function claimLeadAction(
  leadId: string
): Promise<{ success: boolean; reason?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.id) throw new Error("Unauthorized")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) throw new Error("No brokerage found for user")

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, brokerage_id")
    .eq("id", leadId)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  // supabase-js RESOLVES a refused query, so a swallowed error here would be
  // indistinguishable from "no such lead" — and both must refuse.
  if (leadError) return { success: false, reason: "lead_scope_check_failed" }
  if (!lead) return { success: false, reason: "lead_not_in_tenant" }

  return await claimLead({
    leadId,
    agentUserId: user.id,
    brokerageId: profile.brokerage_id,
  })
}
