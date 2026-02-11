'use server'

/**
 * SYSTEM 6.1 - Authority Validation
 * Validates user has authority to execute command
 * Enforces role-based access control and entity-level permissions
 */

import { createClient } from '@/lib/supabase/server'
import { VOICE_AUTHORITY_MATRIX } from '../helpers/authority-matrix'

export interface AuthorityValidationResult {
  allowed: boolean
  denial_reason?: string
  required_role?: string
}

interface ValidateAuthorityRequest {
  user_id: string
  user_role: string
  brokerage_id: string
  command: string
  target_system: string
  entities: Record<string, any>
}

/**
 * Validate user authority to execute command
 * Checks:
 * 1. Role has permission for command type
 * 2. User has access to entity (listing, contact, etc.)
 */
export async function validateAuthority(request: ValidateAuthorityRequest): Promise<AuthorityValidationResult> {
  const { user_id, user_role, brokerage_id, command, target_system, entities } = request

  try {
    // Check role-based authority
    const commandRoles = VOICE_AUTHORITY_MATRIX[command as keyof typeof VOICE_AUTHORITY_MATRIX]

    if (!commandRoles) {
      // Command not in matrix - deny by default
      return {
        allowed: false,
        denial_reason: `Command "${command}" is not supported`,
        required_role: 'unknown'
      }
    }

    if (!commandRoles.includes(user_role as any)) {
      return {
        allowed: false,
        denial_reason: `You do not have permission to ${command.replace(/_/g, ' ')}`,
        required_role: commandRoles[0]
      }
    }

    // Check entity-level access
    if (entities.listing_id) {
      const hasListingAccess = await validateListingAccess(entities.listing_id, user_id, brokerage_id)
      if (!hasListingAccess) {
        return {
          allowed: false,
          denial_reason: 'You do not have access to this listing'
        }
      }
    }

    if (entities.buyer_id || entities.contact_id) {
      const contactId = entities.buyer_id || entities.contact_id
      const hasContactAccess = await validateContactAccess(contactId, user_id, brokerage_id)
      if (!hasContactAccess) {
        return {
          allowed: false,
          denial_reason: 'You do not have access to this contact'
        }
      }
    }

    // All checks passed
    return { allowed: true }

  } catch (error) {
    console.error('[validate-authority] Error:', error)
    return {
      allowed: false,
      denial_reason: 'Authority validation failed'
    }
  }
}

/**
 * Validate user has access to listing
 */
async function validateListingAccess(
  listingId: string,
  userId: string,
  brokerageId: string
): Promise<boolean> {
  const supabase = await createClient()

  // Check if listing belongs to brokerage and user has access
  const { data: listing } = await supabase
    .from('listings')
    .select('id, agent_id, brokerage_id')
    .eq('id', listingId)
    .single()

  if (!listing) {
    return false
  }

  // Must be same brokerage
  if (listing.brokerage_id !== brokerageId) {
    return false
  }

  // Agent must be assigned or user must be admin/broker
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!user) {
    return false
  }

  // Admin/broker can access all listings in brokerage
  if (['admin', 'broker', 'team_leader'].includes(user.role)) {
    return true
  }

  // Agent can only access their own listings
  return listing.agent_id === userId
}

/**
 * Validate user has access to contact
 */
async function validateContactAccess(
  contactId: string,
  userId: string,
  brokerageId: string
): Promise<boolean> {
  const supabase = await createClient()

  // Check if contact belongs to brokerage and user has access
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, agent_id, brokerage_id')
    .eq('id', contactId)
    .single()

  if (!contact) {
    return false
  }

  // Must be same brokerage
  if (contact.brokerage_id !== brokerageId) {
    return false
  }

  // Get user role
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!user) {
    return false
  }

  // Admin/broker/team_leader can access all contacts in brokerage
  if (['admin', 'broker', 'team_leader'].includes(user.role)) {
    return true
  }

  // Agent can only access their own contacts
  return contact.agent_id === userId
}
