import { createServiceClient } from "@/lib/supabase/service"

export interface EligibilityResult {
  isEligible: boolean
  reason?: string
  qualifiedBy?: string
  qualifiedAt?: string
}

/**
 * Evaluates whether a lead is eligible for agent assignment
 * - Must be AI ISA qualified
 * - Must not already have an agent assigned
 * - Must be within brokerage scope
 */
export async function evaluateAssignmentEligibility(
  leadId: string,
  brokerageId: string
): Promise<EligibilityResult> {
  const supabase = createServiceClient()

  // Fetch lead details
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("agent_id, brokerage_id, lead_stage, lead_score")
    .eq("id", leadId)
    .single()

  if (leadError || !lead) {
    return {
      isEligible: false,
      reason: "Lead not found or inaccessible"
    }
  }

  // Check brokerage scope
  if (lead.brokerage_id?.toString() !== brokerageId) {
    return {
      isEligible: false,
      reason: "Lead is not within brokerage scope"
    }
  }

  // Check if already assigned
  if (lead.agent_id) {
    return {
      isEligible: false,
      reason: "Lead already has an assigned agent"
    }
  }

  // Check AI ISA qualification
  // A lead is qualified if it has moved past "new" stage or has a lead_score
  const isQualified = 
    (lead.lead_stage && lead.lead_stage !== "new") ||
    (lead.lead_score && lead.lead_score > 0)

  if (!isQualified) {
    return {
      isEligible: false,
      reason: "Lead has not been qualified by AI ISA"
    }
  }

  // Check for qualification activity in activities table
  const { data: qualificationActivity } = await supabase
    .from("activities")
    .select("created_at, description")
    .eq("contact_id", leadId)
    .eq("activity_type", "ai_isa_qualification")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  return {
    isEligible: true,
    qualifiedBy: "AI ISA",
    qualifiedAt: qualificationActivity?.created_at || new Date().toISOString()
  }
}
