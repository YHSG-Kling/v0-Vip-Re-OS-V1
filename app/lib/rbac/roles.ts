import { UserContext } from '@/app/types/roles';
import { ROLE_CONFIGS } from '@/app/types/roles';

export interface RoleInfo {
  id: string;
  name: string;
  description: string;
  permissions: Array<{
    resource: string;
    action: string;
    conditions?: Record<string, any>;
  }>;
}

export class RoleManager {
  private roles: Map<string, RoleInfo> = new Map();

  constructor() {
    // Initialize with ROLE_CONFIGS from system 1.1
    Object.values(ROLE_CONFIGS).forEach((config) => {
      let permissions = [...config.permissions];
      
      // Add closing workflow permissions
      if (['compliance_officer', 'broker', 'admin'].includes(config.name)) {
        permissions.push(
          { resource: 'closing_disclosure', action: 'read' },
          { resource: 'closing_disclosure', action: 'create' },
          { resource: 'closing_disclosure', action: 'update' },
          { resource: 'closing_disclosure_agreement', action: 'read' },
          { resource: 'closing_disclosure_agreement', action: 'create' },
          { resource: 'closing_disclosure_agreement', action: 'update' },
          { resource: 'cda_comparison_results', action: 'read' },
          { resource: 'cda_comparison_results', action: 'create' },
          { resource: 'cda_comparison_results', action: 'update' },
          { resource: 'closing_notifications', action: 'read' },
          { resource: 'closing_notifications', action: 'create' },
          { resource: 'closing_notifications', action: 'update' },
          { resource: 'document_checklist', action: 'read' },
          { resource: 'document_checklist', action: 'create' },
          { resource: 'document_checklist', action: 'update' }
        );
      }

      // Admin gets delete permissions
      if (config.name === 'admin') {
        permissions.push(
          { resource: 'closing_disclosure', action: 'delete' },
          { resource: 'closing_disclosure_agreement', action: 'delete' }
        );
      }

      // Agent closing permissions
      if (config.name === 'agent') {
        permissions.push(
          { resource: 'document_checklist', action: 'read' },
          { resource: 'document_checklist', action: 'update' },
          { resource: 'closing_disclosure_agreement', action: 'create' },
          { resource: 'closing_disclosure_agreement', action: 'read' },
          { resource: 'closing_disclosure_agreement', action: 'update' },
          { resource: 'closing_disclosure', action: 'read' },
          { resource: 'cda_comparison_results', action: 'read' }
        );
      }

      // Title Agent closing permissions
      if (config.name === 'title_agent') {
        permissions.push(
          { resource: 'closing_disclosure', action: 'create' },
          { resource: 'closing_disclosure', action: 'read' },
          { resource: 'closing_disclosure_agreement', action: 'read' },
          { resource: 'cda_comparison_results', action: 'read' }
        );
      }

      this.roles.set(config.name, {
        id: config.id,
        name: config.name,
        description: config.description,
        permissions,
      });
    });
  }

  getRole(roleName: string): RoleInfo | null {
    return this.roles.get(roleName) || null;
  }

  getAllRoles(): RoleInfo[] {
    return Array.from(this.roles.values());
  }

  getUserRole(user: UserContext): RoleInfo | null {
    return this.getRole(user.user_type);
  }

  hasPermission(
    user: UserContext,
    resource: string,
    action: string
  ): boolean {
    const role = this.getUserRole(user);
    if (!role) return false;

    return role.permissions.some(
      (perm) => perm.resource === resource && perm.action === action
    ) || role.permissions.some(
      (perm) => perm.resource === '*' && perm.action === action
    );
  }

  getPermissions(user: UserContext) {
    const role = this.getUserRole(user);
    return role?.permissions || [];
  }
}

export const roleManager = new RoleManager();
