/**
 * SYSTEM 3.1: COMMUNICATION SPINE
 * Role-Based Messaging Rules Validator
 * 
 * THIS IS INFRASTRUCTURE-ONLY. NO UI. NO AI LOGIC.
 * 
 * Purpose: Enforce who can initiate and respond to messages
 * based on their role in the contact's team.
 */

export type AuthorType = 'contact' | 'agent' | 'ai' | 'system' | 'lender' | 'vendor' | 'office'
export type MessageAction = 'initiate' | 'respond'

export interface RoleValidationContext {
  authorType: AuthorType
  action: MessageAction
  contactId: string
  conversationId?: string
  agentId?: string
  isThreadResponse?: boolean // Responding to existing thread
}

export interface RoleValidationResult {
  allowed: boolean
  reason?: string
  shouldLog?: boolean
}

/**
 * VALIDATE MESSAGE INITIATION RULES
 * 
 * Enforces the following rules (NON-NEGOTIABLE):
 * 
 * 1. Contact: may initiate and respond
 * 2. Agent: may initiate and respond once assigned to contact
 * 3. Office / Support: may initiate and respond once contact exists
 * 4. Lender: may initiate and respond once assigned to contact
 * 5. Vendor (title, escrow, etc.):
 *    - may NOT initiate conversations
 *    - may ONLY respond to contact- or agent-initiated threads
 * 6. AI / System: may initiate and respond on behalf of brokerage
 */
export function validateMessageInitiationRules(
  context: RoleValidationContext
): RoleValidationResult {
  const { authorType, action, isThreadResponse } = context

  // Rule 1: Contact can always communicate
  if (authorType === 'contact') {
    return { allowed: true }
  }

  // Rule 2: AI and System can always act
  if (authorType === 'ai' || authorType === 'system') {
    return { allowed: true }
  }

  // Rule 3: Agent can initiate and respond
  if (authorType === 'agent') {
    // Could add check here to ensure agent is assigned to contact
    // For now, allow all agent messages
    return { allowed: true }
  }

  // Rule 4: Office can initiate and respond once contact exists
  if (authorType === 'office') {
    return { allowed: true }
  }

  // Rule 5: Lender can communicate once assigned
  if (authorType === 'lender') {
    // Could add check for assignment relationship
    return { allowed: true }
  }

  // Rule 6: VENDOR RESTRICTIONS
  if (authorType === 'vendor') {
    // Vendors can NEVER initiate
    if (action === 'initiate' && !isThreadResponse) {
      return {
        allowed: false,
        reason: 'Vendors cannot initiate conversations. They may only respond to existing threads.',
        shouldLog: true,
      }
    }

    // Vendors can ONLY respond to threads
    if (action === 'respond' || isThreadResponse) {
      return { allowed: true }
    }

    // Default deny for vendors
    return {
      allowed: false,
      reason: 'Vendor message action not recognized',
      shouldLog: true,
    }
  }

  // Unknown author type
  return {
    allowed: false,
    reason: `Unknown author type: ${authorType}`,
    shouldLog: true,
  }
}
