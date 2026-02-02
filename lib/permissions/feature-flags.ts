'use strict'

import { UserRole } from '@/app/types/roles'
import { FEATURE_FLAGS } from '@/app/constants/permissions'
import { RoleManager } from './role-manager'

export class FeatureFlags {
  /**
   * Check if feature is available to role
   */
  static isEnabled(feature: string, role: UserRole): boolean {
    // Check role-based feature flags
    const allowedRoles = FEATURE_FLAGS[feature] || []
    return allowedRoles.includes(role) || RoleManager.hasFeature(role, feature)
  }

  /**
   * Check if feature is available to any role in list
   */
  static isEnabledForAny(feature: string, roles: UserRole[]): boolean {
    return roles.some((role) => this.isEnabled(feature, role))
  }

  /**
   * Get all enabled features for a role
   */
  static getEnabledFeatures(role: UserRole): string[] {
    const roleFeatures = RoleManager.getFeatures(role)
    
    // Also include all general features the role has access to
    const allFeatures = Object.keys(FEATURE_FLAGS).filter(
      (feature) => FEATURE_FLAGS[feature].includes(role)
    )

    return Array.from(new Set([...roleFeatures, ...allFeatures]))
  }

  /**
   * Get all disabled features for a role
   */
  static getDisabledFeatures(role: UserRole): string[] {
    const enabledFeatures = this.getEnabledFeatures(role)
    const allFeatures = Object.keys(FEATURE_FLAGS)

    return allFeatures.filter((feature) => !enabledFeatures.includes(feature))
  }

  /**
   * Feature availability summary for debugging
   */
  static getSummary(role: UserRole) {
    return {
      role,
      enabled: this.getEnabledFeatures(role),
      disabled: this.getDisabledFeatures(role),
      count: {
        enabled: this.getEnabledFeatures(role).length,
        disabled: this.getDisabledFeatures(role).length,
      },
    }
  }
}
