'use client'

import { useCallback } from 'react'
import { useAuth } from '@/lib/auth/useAuth'
import { RoleManager } from '@/lib/security'

export function useCanAccess() {
  const { userContext } = useAuth()

  const canCreate = useCallback(
    (resourceType: string): boolean => {
      if (!userContext || !userContext.roles[0]) return false
      return RoleManager.hasPermission(
        userContext.roles[0],
        `${resourceType}:create` as any
      )
    },
    [userContext]
  )

  const canEdit = useCallback(
    (resourceType: string): boolean => {
      if (!userContext || !userContext.roles[0]) return false
      return RoleManager.hasPermission(
        userContext.roles[0],
        `${resourceType}:edit` as any
      )
    },
    [userContext]
  )

  const canDelete = useCallback(
    (resourceType: string): boolean => {
      if (!userContext || !userContext.roles[0]) return false
      return RoleManager.hasPermission(
        userContext.roles[0],
        `${resourceType}:delete` as any
      )
    },
    [userContext]
  )

  const canView = useCallback(
    (resourceType: string, scope: 'own' | 'team' | 'all' = 'own'): boolean => {
      if (!userContext || !userContext.roles[0]) return false

      const userRole = userContext.roles[0]
      const permission =
        scope === 'own'
          ? `${resourceType}:view`
          : scope === 'team'
          ? `${resourceType}:view_team`
          : `${resourceType}:view_all`

      return RoleManager.hasPermission(userRole, permission as any)
    },
    [userContext]
  )

  return {
    canCreate,
    canEdit,
    canDelete,
    canView,
  }
}
