import { UserContext } from '@/app/types/roles';
import { roleManager } from './roles';

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export class PermissionChecker {
  canAccess(
    user: UserContext,
    resource: string,
    action: string
  ): PermissionCheckResult {
    if (!user) {
      return { allowed: false, reason: 'User not authenticated' };
    }

    const hasPermission = roleManager.hasPermission(user, resource, action);

    if (!hasPermission) {
      return {
        allowed: false,
        reason: `${user.user_type} role cannot ${action} ${resource}`,
      };
    }

    return { allowed: true };
  }

  canAccessAll(
    user: UserContext,
    checks: Array<{ resource: string; action: string }>
  ): PermissionCheckResult {
    for (const check of checks) {
      const result = this.canAccess(user, check.resource, check.action);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  }

  canAccessAny(
    user: UserContext,
    checks: Array<{ resource: string; action: string }>
  ): PermissionCheckResult {
    const reasons: string[] = [];

    for (const check of checks) {
      const result = this.canAccess(user, check.resource, check.action);
      if (result.allowed) {
        return { allowed: true };
      }
      if (result.reason) {
        reasons.push(result.reason);
      }
    }

    return {
      allowed: false,
      reason: `User cannot perform any of: ${reasons.join(', ')}`,
    };
  }

  getResourceActions(user: UserContext, resource: string): string[] {
    const permissions = roleManager.getPermissions(user);
    return permissions
      .filter(
        (perm) => perm.resource === resource || perm.resource === '*'
      )
      .map((perm) => perm.action)
      .filter((action, idx, arr) => arr.indexOf(action) === idx);
  }

  canAccessRecord(
    user: UserContext,
    resource: string,
    action: string,
    recordOwnerId?: string
  ): PermissionCheckResult {
    const baseCheck = this.canAccess(user, resource, action);
    if (!baseCheck.allowed) {
      return baseCheck;
    }

    if (recordOwnerId && user.id !== recordOwnerId) {
      const role = roleManager.getUserRole(user);
      
      if (['broker', 'admin', 'compliance_officer'].includes(user.user_type)) {
        return { allowed: true };
      }

      return {
        allowed: false,
        reason: 'User does not own this record',
      };
    }

    return { allowed: true };
  }
}

export const permissionChecker = new PermissionChecker();
