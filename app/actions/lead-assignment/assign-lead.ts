"use server"

import { createClient } from "@/lib/supabase/server"
import {
  evaluateAndAssignLead,
  claimLead,
} from "@/lib/lead-assignment/assignment-engine"
import { handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"

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

  if (!["admin", "broker", "superadmin"].includes(profile.user_type ?? "")) {
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

  if (!["admin", "broker", "superadmin"].includes(profile?.user_type ?? "")) {
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

  return await claimLead({
    leadId,
    agentUserId: user.id,
    brokerageId: profile.brokerage_id,
  })
}
