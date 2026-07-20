/**
 * Validates whether a lead is eligible for promotion to contact
 *
 * Business Rule (owner, round 37): "leads are promoted and converted to
 * contacts once qualified" — a lead becomes a contact only after the AI ISA
 * marked it qualified AND an agent is assigned. This represents the formal
 * start of the relationship lifecycle. Enforced server-side here so every
 * caller of promoteLeadToContactService inherits the refusal.
 */

export interface PromotionEligibility {
  isEligible: boolean
  reason: string
}

export async function validatePromotionEligibility(
  lead: any
): Promise<PromotionEligibility> {

  // Rule 0: Lead must be QUALIFIED (AI-ISA qualification or canonical handoff
  // acceptance stamps lead_stage='qualified'). Unqualified leads are refused —
  // the AI ISA is still working them.
  if (lead.lead_stage !== "qualified") {
    return {
      isEligible: false,
      reason: `Lead has not been qualified by the AI ISA — conversion is only available once qualified (lead_stage='${lead.lead_stage ?? "new"}')`
    }
  }

  // Rule 1: Lead must have agent assigned
  if (!lead.agent_id) {
    return {
      isEligible: false,
      reason: "Lead must have an assigned agent to be promoted"
    }
  }

  // Rule 2: Lead must be active
  if (lead.is_active === false) {
    return {
      isEligible: false,
      reason: "Lead is already inactive"
    }
  }

  // Rule 3: Lead must have minimum contact information
  if (!lead.email && !lead.phone) {
    return {
      isEligible: false,
      reason: "Lead must have at least an email or phone number"
    }
  }

  // Rule 4: Lead must have name
  if (!lead.first_name && !lead.last_name) {
    return {
      isEligible: false,
      reason: "Lead must have at least a first or last name"
    }
  }

  return {
    isEligible: true,
    reason: "Lead meets all promotion criteria"
  }
}
