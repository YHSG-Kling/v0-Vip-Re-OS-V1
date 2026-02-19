import { createServiceClient } from "@/lib/supabase/service"

export type UserRole = "agent" | "TC" | "compliance_officer" | "broker" | "admin" | "lender" | "title" | "client"

export interface RoleContext {
  userId: string
  role: UserRole
  brokerageId: string
  transactionId?: string
}

/**
 * Check if user can transition transaction stage
 */
export async function canTransitionStage(context: RoleContext): Promise<{ allowed: boolean; reason?: string }> {
  const { role } = context
  
  // Admin and broker can always transition
  if (role === "admin" || role === "broker") {
    return { allowed: true }
  }
  
  // TC can transition any stage
  if (role === "TC") {
    return { allowed: true }
  }
  
  // Agent can transition their own transactions up to certain stages
  if (role === "agent") {
    if (!context.transactionId) {
      return { allowed: false, reason: "Transaction ID required" }
    }
    
    const supabase = createServiceClient()
    const { data: transaction } = await supabase
      .from("transactions")
      .select("agent_id")
      .eq("id", context.transactionId)
      .eq("brokerage_id", context.brokerageId)
      .single()
    
    if (transaction?.agent_id === context.userId) {
      return { allowed: true }
    }
    
    return { allowed: false, reason: "Not assigned to this transaction" }
  }
  
  return { allowed: false, reason: "Insufficient permissions" }
}

/**
 * Check if user can override milestone with reason
 */
export async function canOverrideMilestone(context: RoleContext): Promise<{ allowed: boolean; reason?: string }> {
  const { role } = context
  
  // Only broker, admin, and TC can override critical milestones
  if (role === "broker" || role === "admin" || role === "TC") {
    return { allowed: true }
  }
  
  return { allowed: false, reason: "Only broker/admin/TC can override milestones" }
}

/**
 * Check if user can edit milestone dates (critical dates require reason)
 */
export async function canEditMilestoneDate(context: RoleContext): Promise<{ allowed: boolean; reason?: string }> {
  const { role } = context
  
  // Agent, TC, broker, admin can edit
  if (["agent", "TC", "broker", "admin"].includes(role)) {
    return { allowed: true }
  }
  
  return { allowed: false, reason: "Cannot edit milestone dates" }
}

/**
 * Check if user can view financial details (CDA, commissions, etc)
 */
export function canViewFinancials(context: RoleContext): { allowed: boolean; reason?: string } {
  const { role } = context
  
  // Client cannot see internal financials
  if (role === "client") {
    return { allowed: false, reason: "Clients cannot view internal financial details" }
  }
  
  // External parties (lender/title) cannot see commission breakdowns
  if (role === "lender" || role === "title") {
    return { allowed: false, reason: "External parties cannot view commission details" }
  }
  
  return { allowed: true }
}

/**
 * Check if user can act as external party (lender/title updating specific milestones)
 */
export async function canActAsExternalParty(
  context: RoleContext,
  milestoneType: string
): Promise<{ allowed: boolean; reason?: string }> {
  const { role, transactionId, userId, brokerageId } = context
  
  if (!transactionId) {
    return { allowed: false, reason: "Transaction ID required" }
  }
  
  // Lender can only update financing-related milestones
  if (role === "lender") {
    const allowedMilestones = ["clear_to_close_received", "financing_deadline", "conditional_approval"]
    if (!allowedMilestones.includes(milestoneType)) {
      return { allowed: false, reason: "Lender can only update financing milestones" }
    }
    
    // Verify lender is assigned to this transaction
    const supabase = createServiceClient()
    const { data: member } = await supabase
      .from("deal_team_members")
      .select("id")
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", brokerageId)
      .eq("member_id", userId)
      .eq("member_type", "lender")
      .single()
    
    if (!member) {
      return { allowed: false, reason: "Not assigned as lender for this transaction" }
    }
    
    return { allowed: true }
  }
  
  // Title company can only update closing-related milestones
  if (role === "title") {
    const allowedMilestones = ["funding_confirmed", "cda_delivered", "cd_uploaded"]
    if (!allowedMilestones.includes(milestoneType)) {
      return { allowed: false, reason: "Title can only update closing milestones" }
    }
    
    // Verify title is assigned to this transaction
    const supabase = createServiceClient()
    const { data: member } = await supabase
      .from("deal_team_members")
      .select("id")
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", brokerageId)
      .eq("member_id", userId)
      .eq("member_type", "title")
      .single()
    
    if (!member) {
      return { allowed: false, reason: "Not assigned as title for this transaction" }
    }
    
    return { allowed: true }
  }
  
  return { allowed: false, reason: "Not an external party" }
}

/**
 * Assert user has required role (throws if not)
 */
export async function assertUserHasRole(
  context: RoleContext,
  requiredRoles: UserRole[]
): Promise<void> {
  if (!requiredRoles.includes(context.role)) {
    throw new Error(
      `[role-guard] User role '${context.role}' not authorized. Required: ${requiredRoles.join(', ')}`
    )
  }
}
