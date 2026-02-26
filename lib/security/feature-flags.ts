'use strict'

import type { UserRole } from '@/app/types/roles'
import { FEATURE_FLAGS } from './permission-matrix'
import { RoleManager } from './role-manager'

export class FeatureFlags {
  static isEnabled(feature: string, role: UserRole): boolean {
    const allowedRoles = FEATURE_FLAGS[feature] ?? []
    return allowedRoles.includes(role) || RoleManager.hasFeature(role, feature)
  }

  static isEnabledForAny(feature: string, roles: UserRole[]): boolean {
    return roles.some((role) => this.isEnabled(feature, role))
  }

  static getEnabledFeatures(role: UserRole): string[] {
    const roleFeatures = RoleManager.getFeatures(role)
    const flagFeatures = Object.keys(FEATURE_FLAGS).filter((f) =>
      FEATURE_FLAGS[f].includes(role)
    )
    return Array.from(new Set([...roleFeatures, ...flagFeatures]))
  }

  static getDisabledFeatures(role: UserRole): string[] {
    const enabled = new Set(this.getEnabledFeatures(role))
    return Object.keys(FEATURE_FLAGS).filter((f) => !enabled.has(f))
  }

  static getSummary(role: UserRole) {
    const enabled = this.getEnabledFeatures(role)
    const disabled = this.getDisabledFeatures(role)
    return { role, enabled, disabled, count: { enabled: enabled.length, disabled: disabled.length } }
  }
}
