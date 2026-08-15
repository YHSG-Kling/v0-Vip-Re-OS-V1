import { createClient } from '@/lib/supabase/server'

/**
 * RBAC — Resource-level access control
 *
 * Uses users.user_type as the canonical role source.
 * Logs permission checks and access changes to the activities table.
 * Does not write to old *_access_control tables (they do not exist).
 * Relies on RLS for real data access enforcement.
 */

export async function requirePermission(
  action: string,
  resourceType: string,
  resourceId: string
): Promise<void> {
  const supabase = await createClient()

  // 1. Get authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // 2. If no user, throw "Not authenticated"
  if (!user) throw new Error('Not authenticated')

  // 3. Query users table for user_type
  const { data: userData } = await supabase
    .from('users')
    .select('user_type')
    .eq('id', user.id)
    .single()

  const userType = userData?.user_type

  // 4. If user_type is 'broker' or 'admin', allow
  if (userType === 'broker' || userType === 'admin') {
    // Log permission check (non-blocking)
    logActivity(supabase, user.id, 'permission_check', {
      action,
      resourceType,
      resourceId,
      user_type: userType,
      result: 'allowed',
    })
    return
  }

  // 5. If user_type is 'compliance_officer' and action is 'read' and resourceType in allowed list, allow
  if (
    userType === 'compliance_officer' &&
    action === 'read' &&
    ['document', 'contact', 'transaction'].includes(resourceType)
  ) {
    logActivity(supabase, user.id, 'permission_check', {
      action,
      resourceType,
      resourceId,
      user_type: userType,
      result: 'allowed',
    })
    return
  }

  // 6. If user_type is 'TC' and resourceType is 'transaction', allow
  if (userType === 'TC' && resourceType === 'transaction') {
    logActivity(supabase, user.id, 'permission_check', {
      action,
      resourceType,
      resourceId,
      user_type: userType,
      result: 'allowed',
    })
    return
  }

  // 7. Otherwise return without throwing and let RLS enforce real data access
  logActivity(supabase, user.id, 'permission_check', {
    action,
    resourceType,
    resourceId,
    user_type: userType,
    result: 'deferred_to_rls',
  })
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

  // Do not write to any access-control tables (they do not exist)
  // Log a non-blocking activities row
  logActivity(supabase, userId, 'access_granted', {
    resourceType,
    resourceId,
    userId,
    userType,
    permissions,
  })
}

export async function revokeAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
  revokedBy: string,
  reason?: string
) {
  const supabase = await createClient()

  // Log a non-blocking activities row
  logActivity(supabase, userId, 'access_revoked', {
    resourceType,
    resourceId,
    userId,
    revokedBy,
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
  // Call autoGrantAccess for each user
  for (const userId of userIds) {
    await autoGrantAccess(resourceType, resourceId, userId, userType, permissions)
  }
}

export async function getResourceAccessList(resourceType: string, resourceId: string) {
  const supabase = await createClient()

  try {
    // Return activities rows where activity_type = 'access_granted'
    // Filter by metadata.resourceType and metadata.resourceId
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('activity_type', 'access_granted')
      .contains('metadata', { resourceType, resourceId })

    if (error) {
      console.error('[RBAC] Error fetching access list:', error)
      return []
    }

    return data ?? []
  } catch {
    // Return empty array on error
    return []
  }
}

/**
 * Log activity to the activities table (non-blocking)
 */
function logActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  activityType: string,
  metadata: Record<string, unknown>
): void {
  supabase
    .from('activities')
    .insert({
      agent_user_id: userId,
      activity_type: activityType,
      metadata,
      created_at: new Date().toISOString(),
    })
}
