import { createClient } from '@/lib/supabase/server'

/**
 * RBAC — Resource-level access control
 *
 * Provides server-side permission checking for resource-level access
 * (contacts, transactions, documents, listings) via database ACL tables.
 * Role-based permission checks live in AccessControl / RoleManager.
 */

export async function requirePermission(
  action: string,
  resourceType: string,
  resourceId: string
): Promise<void> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userRole } = await supabase
    .from('user_brokerage_roles')
    .select('*, role:roles(name), brokerage:brokerages(id, name)')
    .eq('user_id', user.id)
    .eq('is_primary', true)
    .single()

  if (!userRole) throw new Error('No role found for user')

  const roleName = userRole.role?.name

  // Full access for privileged roles
  if (['BrokerOwner', 'ManagingBroker'].includes(roleName)) return
  if (roleName === 'Compliance' && action === 'read' && ['document', 'contact', 'transaction'].includes(resourceType)) return
  if ((roleName === 'tc' || roleName === 'TC') && resourceType === 'transaction') return

  const hasAccess = await checkSpecificAccess(user.id, resourceType, resourceId)
  if (!hasAccess) {
    throw new Error(`Access denied: You don't have permission to ${action} this ${resourceType}`)
  }
}

async function checkSpecificAccess(
  userId: string,
  resourceType: string,
  resourceId: string
): Promise<boolean> {
  const supabase = await createClient()

  const tables: Record<string, string> = {
    contact: 'contact_access_control',
    transaction: 'transaction_access_control',
    document: 'document_access_control',
    listing: 'listing_access_control',
  }

  const table = tables[resourceType]
  if (!table) return false

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq(`${resourceType}_id`, resourceId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[RBAC] Error checking access:', error)
    return false
  }

  if (data?.expires_at && new Date(data.expires_at) < new Date()) return false

  return !!data
}

export async function autoGrantAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
  userType: string,
  permissions: {
    canEdit?: boolean
    canViewFinancials?: boolean
    canShare?: boolean
    accessLevel?: string
    roleInTransaction?: string
    grantedBy?: string
    expiresAt?: Date
  }
) {
  const supabase = await createClient()

  try {
    if (resourceType === 'transaction') {
      await supabase.from('transaction_access_control').insert({
        transaction_id: resourceId,
        user_id: userId,
        user_type: userType,
        role_in_transaction: permissions.roleInTransaction ?? 'participant',
        can_edit: permissions.canEdit ?? false,
        can_view_financials: permissions.canViewFinancials ?? false,
        granted_by: permissions.grantedBy ?? null,
        expires_at: permissions.expiresAt ?? null,
      })
    } else if (resourceType === 'contact') {
      await supabase.from('contact_access_control').insert({
        contact_id: resourceId,
        user_id: userId,
        user_type: userType,
        access_type: 'assigned',
        can_edit: permissions.canEdit ?? false,
        can_share: permissions.canShare ?? false,
        granted_by: permissions.grantedBy ?? null,
        expires_at: permissions.expiresAt ?? null,
      })
    } else if (resourceType === 'document') {
      await supabase.from('document_access_control').insert({
        document_id: resourceId,
        user_id: userId,
        user_type: userType,
        access_level: permissions.accessLevel ?? 'view',
        can_share: permissions.canShare ?? false,
        granted_by: permissions.grantedBy ?? null,
        expires_at: permissions.expiresAt ?? null,
      })
    } else if (resourceType === 'listing') {
      await supabase.from('listing_access_control').insert({
        listing_id: resourceId,
        user_id: userId,
        user_type: userType,
        role: permissions.roleInTransaction ?? 'viewer',
        can_edit: permissions.canEdit ?? false,
        granted_by: permissions.grantedBy ?? null,
      })
    }
  } catch (error) {
    console.error('[RBAC] Error auto-granting access:', error)
    throw error
  }
}

export async function revokeAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
  revokedBy: string,
  reason?: string
) {
  const supabase = await createClient()

  const tables: Record<string, string> = {
    contact: 'contact_access_control',
    transaction: 'transaction_access_control',
    document: 'document_access_control',
    listing: 'listing_access_control',
  }

  const table = tables[resourceType]
  if (!table) throw new Error('Invalid resource type')

  await supabase.from(table).delete().eq(`${resourceType}_id`, resourceId).eq('user_id', userId)

  await supabase.from('access_audit_log').insert({
    resource_type: resourceType,
    resource_id: resourceId,
    user_id: userId,
    action: 'revoke',
    performed_by: revokedBy,
    reason: reason ?? 'Access revoked',
  })
}

export async function batchGrantAccess(
  resourceType: string,
  resourceId: string,
  userIds: string[],
  userType: string,
  permissions: {
    canEdit?: boolean
    canViewFinancials?: boolean
    accessLevel?: string
    roleInTransaction?: string
    grantedBy?: string
  }
) {
  for (const userId of userIds) {
    await autoGrantAccess(resourceType, resourceId, userId, userType, permissions)
  }
}

export async function getResourceAccessList(resourceType: string, resourceId: string) {
  const supabase = await createClient()

  const tables: Record<string, string> = {
    contact: 'contact_access_control',
    transaction: 'transaction_access_control',
    document: 'document_access_control',
    listing: 'listing_access_control',
  }

  const table = tables[resourceType]
  if (!table) return []

  const { data, error } = await supabase
    .from(table)
    .select('*, user:users(id, first_name, last_name, email, user_type)')
    .eq(`${resourceType}_id`, resourceId)

  if (error) {
    console.error('[RBAC] Error fetching access list:', error)
    return []
  }

  return data ?? []
}
