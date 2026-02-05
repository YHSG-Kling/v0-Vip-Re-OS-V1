'use client';

import { useAuth } from './use-auth';
import { roleManager } from '@/app/lib/rbac/roles';

export function useRole() {
  const { user } = useAuth();

  const role = user ? roleManager.getUserRole(user) : null;
  const roleName = user?.user_type || null;

  const hasRole = (name: string): boolean => {
    return roleName === name;
  };

  const hasAnyRole = (names: string[]): boolean => {
    return names.includes(roleName || '');
  };

  const getPermissions = () => {
    return user ? roleManager.getPermissions(user) : [];
  };

  return {
    role,
    roleName,
    hasRole,
    hasAnyRole,
    getPermissions,
  };
}
