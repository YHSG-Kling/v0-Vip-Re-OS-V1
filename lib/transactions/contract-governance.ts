import { createServiceClient } from "@/lib/supabase/service"

/**
 * System 7.3 — Contract Date Governance (Phase 2 Light)
 * 
 * Constitutional Rules:
 * 1. contract_date can ONLY be set when compliance_passed_at IS NOT NULL
 * 2. All required signatures must be present
 * 3. Only admin, broker, compliance_officer roles can set it
 * 4. NEVER auto-set on signature completion
 * 
 * This prevents backdating and ensures compliance review happens BEFORE contract is legally binding.
 */

interface ContractDateValidation {
  canSet: boolean
  reason?: string
  missingRequirements?: string[]
}

/**
 * Validate if contract_date can be set for a transaction
 * Returns validation result with detailed reasons for rejection
 */
export async function validateContractDateEligibility(
  transactionId: string
): Promise<ContractDateValidation> {
  const supabase = createServiceClient()

  // Fetch transaction with signature status
  const { data: transaction, error } = await supabase
    .from("transactions")
    .select("compliance_passed_at, buyer_agent_signed, seller_agent_signed, buyer_signed, seller_signed")
    .eq("id", transactionId)
    .single()

  if (error || !transaction) {
    return {
      canSet: false,
      reason: "Transaction not found"
    }
  }

  const missingRequirements: string[] = []

  // RULE 1: Compliance must be passed
  if (!transaction.compliance_passed_at) {
    missingRequirements.push("Compliance review must be completed (compliance_passed_at is NULL)")
  }

  // RULE 2: All required signatures must be present
  if (!transaction.buyer_agent_signed) {
    missingRequirements.push("Buyer agent signature missing")
  }
  if (!transaction.seller_agent_signed) {
    missingRequirements.push("Seller agent signature missing")
  }
  if (!transaction.buyer_signed) {
    missingRequirements.push("Buyer signature missing")
  }
  if (!transaction.seller_signed) {
    missingRequirements.push("Seller signature missing")
  }

  if (missingRequirements.length > 0) {
    return {
      canSet: false,
      reason: "Missing required prerequisites",
      missingRequirements
    }
  }

  return {
    canSet: true
  }
}

/**
 * Validate if user has authority to set contract_date
 * RULE 3: Only admin, broker, compliance_officer roles allowed
 */
export async function validateContractDateAuthority(
  userId: string
): Promise<{ hasAuthority: boolean; reason?: string }> {
  const supabase = createServiceClient()

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single()

  if (!profile) {
    return {
      hasAuthority: false,
      reason: "User profile not found"
    }
  }

  const allowedRoles = ["admin", "broker", "compliance_officer"]
  
  if (!allowedRoles.includes(profile.role)) {
    return {
      hasAuthority: false,
      reason: `Only admin, broker, or compliance_officer can set contract_date. User role: ${profile.role}`
    }
  }

  return {
    hasAuthority: true
  }
}

/**
 * Set contract_date with full governance enforcement
 * This is the ONLY way contract_date should be set
 */
export async function setContractDate(params: {
  transactionId: string
  contractDate: string // ISO date string
  userId: string
}): Promise<{ success: boolean; error?: string }> {
  // Validate authority
  const authorityCheck = await validateContractDateAuthority(params.userId)
  if (!authorityCheck.hasAuthority) {
    return {
      success: false,
      error: authorityCheck.reason
    }
  }

  // Validate eligibility
  const eligibilityCheck = await validateContractDateEligibility(params.transactionId)
  if (!eligibilityCheck.canSet) {
    return {
      success: false,
      error: eligibilityCheck.reason + (eligibilityCheck.missingRequirements ? ": " + eligibilityCheck.missingRequirements.join(", ") : "")
    }
  }

  const supabase = createServiceClient()

  // Set contract_date
  const { error } = await supabase
    .from("transactions")
    .update({
      contract_date: params.contractDate,
      contract_date_set_by: params.userId,
      contract_date_set_at: new Date().toISOString()
    })
    .eq("id", params.transactionId)

  if (error) {
    return {
      success: false,
      error: `Database error: ${error.message}`
    }
  }

  // Emit governance event to activities table
  await supabase.from("activities").insert({
    type: "transaction.contract_date.set",
    transaction_id: params.transactionId,
    user_id: params.userId,
    metadata: {
      contract_date: params.contractDate,
      set_by_role: (await supabase.from("profiles").select("role").eq("id", params.userId).single()).data?.role
    }
  })

  return {
    success: true
  }
}

/**
 * Query if a transaction can have its contract_date set
 * Read-only check for UI display
 */
export async function canSetContractDate(
  transactionId: string,
  userId: string
): Promise<{
  can: boolean
  reason?: string
  blockers?: string[]
}> {
  const [authorityCheck, eligibilityCheck] = await Promise.all([
    validateContractDateAuthority(userId),
    validateContractDateEligibility(transactionId)
  ])

  if (!authorityCheck.hasAuthority) {
    return {
      can: false,
      reason: authorityCheck.reason
    }
  }

  if (!eligibilityCheck.canSet) {
    return {
      can: false,
      reason: eligibilityCheck.reason,
      blockers: eligibilityCheck.missingRequirements
    }
  }

  return {
    can: true
  }
}
