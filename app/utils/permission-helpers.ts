import { UserContext } from '@/app/types/roles';
import { permissionChecker } from '@/app/lib/rbac/permissions';

export function canAccess(
  user: UserContext | null,
  resource: string,
  action: string
): boolean {
  if (!user) return false;
  const result = permissionChecker.canAccess(user, resource, action);
  return result.allowed;
}

export function canAccessAll(
  user: UserContext | null,
  checks: Array<{ resource: string; action: string }>
): boolean {
  if (!user) return false;
  const result = permissionChecker.canAccessAll(user, checks);
  return result.allowed;
}

export function canAccessAny(
  user: UserContext | null,
  checks: Array<{ resource: string; action: string }>
): boolean {
  if (!user) return false;
  const result = permissionChecker.canAccessAny(user, checks);
  return result.allowed;
}

export function isRole(user: UserContext | null, role: string): boolean {
  if (!user) return false;
  return user.user_type === role;
}

export function isAnyRole(user: UserContext | null, roles: string[]): boolean {
  if (!user) return false;
  return roles.includes(user.user_type);
}

export function isLeadership(user: UserContext | null): boolean {
  return isAnyRole(user, ['broker', 'admin', 'compliance_officer']);
}

export function isAdmin(user: UserContext | null): boolean {
  return isRole(user, 'admin');
}

export function isComplianceOfficer(user: UserContext | null): boolean {
  return isRole(user, 'compliance_officer');
}

export function getRoleName(user: UserContext | null): string {
  return user?.user_type || 'unknown';
}

// Closing workflow helpers
export function canManageClosing(user: UserContext | null): boolean {
  return isAnyRole(user, ['compliance_officer', 'broker', 'admin']);
}

export function canFillOutCDA(user: UserContext | null): boolean {
  return isAnyRole(user, ['agent', 'compliance_officer', 'broker', 'admin']);
}

export function canApproveCDA(user: UserContext | null): boolean {
  return isAnyRole(user, ['broker', 'admin']);
}
