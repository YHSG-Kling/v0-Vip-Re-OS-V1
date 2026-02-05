'use client';

import { useAuth } from './use-auth';
import { permissionChecker } from '@/app/lib/rbac/permissions';
import { permissionCache } from '@/app/lib/rbac/cache';

export function usePermission() {
  const { user } = useAuth();

  const can = (resource: string, action: string): boolean => {
    if (!user) return false;

    const cached = permissionCache.get(user.id, resource, action);
    if (cached !== null) {
      return cached;
    }

    const result = permissionChecker.canAccess(user, resource, action);
    permissionCache.set(user.id, resource, action, result.allowed);
    
    return result.allowed;
  };

  const canAll = (
    checks: Array<{ resource: string; action: string }>
  ): boolean => {
    if (!user) return false;
    const result = permissionChecker.canAccessAll(user, checks);
    return result.allowed;
  };

  const canAny = (
    checks: Array<{ resource: string; action: string }>
  ): boolean => {
    if (!user) return false;
    const result = permissionChecker.canAccessAny(user, checks);
    return result.allowed;
  };

  const getActions = (resource: string): string[] => {
    if (!user) return [];
    return permissionChecker.getResourceActions(user, resource);
  };

  return {
    can,
    canAll,
    canAny,
    getActions,
  };
}
