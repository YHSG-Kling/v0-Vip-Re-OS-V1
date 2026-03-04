"use server"

import { createClient } from "@/lib/supabase/server"
import {
  evaluateAndAssignLead,
  claimLead,
} from "@/lib/lead-assignment/assignment-engine"

export async function assignLead(
  leadId: string
): Promise<{ assigned: boolean; agentId?: string; reason: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.id) throw new Error("Unauthorized")

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("brokerage_id, user_type")
    .eq("user_id", user.id)
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

export async function claimLeadAction(
  leadId: string
): Promise<{ success: boolean; reason?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.id) throw new Error("Unauthorized")

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("brokerage_id, user_type")
    .eq("user_id", user.id)
    .single()

  if (!profile?.brokerage_id) throw new Error("No brokerage found for user")

  return await claimLead({
    leadId,
    agentUserId: user.id,
    brokerageId: profile.brokerage_id,
  })
}
