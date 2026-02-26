'use client'

import { useCallback, useMemo } from 'react'
import { useAuth } from '@/lib/auth/useAuth'
import type { Permission } from '@/lib/security'
import { RoleManager } from '@/lib/security'
import { FeatureFlags } from '@/lib/security'

export function usePermissions() {
  const { userContext } = useAuth()

  const permissions = useMemo(() => {
    if (!userContext || !userContext.roles[0]) return []
    return RoleManager.getPermissions(userContext.roles[0])
  }, [userContext])

  const features = useMemo(() => {
    if (!userContext || !userContext.roles[0]) return []
    return FeatureFlags.getEnabledFeatures(userContext.roles[0])
  }, [userContext])

  const can = useCallback(
    (permission: Permission): boolean => {
      if (!userContext || !userContext.roles[0]) return false
      return RoleManager.hasPermission(userContext.roles[0], permission)
    },
    [userContext]
  )

  const hasFeature = useCallback(
    (feature: string): boolean => {
      if (!userContext || !userContext.roles[0]) return false
      return FeatureFlags.isEnabled(feature, userContext.roles[0])
    },
    [userContext]
  )

  const role = userContext?.roles[0]

  return {
    role,
    permissions,
    features,
    can,
    hasFeature,
  }
}
