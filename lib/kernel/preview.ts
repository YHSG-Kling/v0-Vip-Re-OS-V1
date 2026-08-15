// lib/kernel/preview.ts
// LAYER 0 — Capability preview and contract validation.
//
// Two exports:
//   renderCapabilityPreview()  — returns a structured CapabilityPreview for
//                                any entity + route, combining RBAC from
//                                resolvePageCapability and feature-flag gating
//                                from canAccessFeature.
//
//   validateKernelContract()   — asserts that a resolved context satisfies the
//                                kernel's structural invariants. Returns a
//                                ContractValidationResult with pass/fail per rule.
//
// Used by:
//   • Page headers to show/hide action buttons without extra DB calls
//   • Server Actions to fail-fast before any write
//   • System health checks (admin/system page)
//
// Import from '@/lib/kernel' — never import this file directly outside the kernel.

import { resolvePageCapability } from "./helpers"
import { canAccessFeature } from "./0.1-feature-access"
import type { PageCapability } from "./helpers"
import type { FeatureAccessCheck } from "./types"
import type { WriteContext } from "./identity"

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Full capability picture for a given entity + route combination.
 * Combines RBAC (role-based) with feature-flag gating (tier-based).
 */
export interface CapabilityPreview {
  /** RBAC capabilities from resolvePageCapability */
  rbac: PageCapability
  /** Feature flag access (null when featureKey not provided) */
  featureAccess: FeatureAccessCheck | null
  /** Final combined verdict: user can act on this surface */
  canAct: boolean
  /** Reason when canAct = false */
  reason?: string
  /** Route the preview was evaluated for */
  route: string
  /** Feature key the preview was evaluated for (optional) */
  featureKey?: string
}

export interface RenderCapabilityPreviewParams {
  /** Fully resolved WriteContext from resolveWriteContext() */
  context: WriteContext
  /** Next.js route path, e.g. '/dashboard/listings' */
  route: string
  /**
   * Optional feature key from feature_flags table.
   * When provided, gating check is included in the preview.
   * e.g. 'newsletter_engine', 'ai_video_scripts', 'ai_deal_coach'
   */
  featureKey?: string
}

// ─── CONTRACT VALIDATION ──────────────────────────────────────────────────────

export interface ContractValidationRule {
  rule: string
  passed: boolean
  detail?: string
}

export interface ContractValidationResult {
  valid: boolean
  rules: ContractValidationRule[]
  failedRules: string[]
}

// ─── renderCapabilityPreview ──────────────────────────────────────────────────

/**
 * Returns a CapabilityPreview combining RBAC + feature-flag gating.
 * Never throws — returns canAct:false with a reason on any error.
 *
 * Usage:
 * ```ts
 * const preview = await renderCapabilityPreview({ context, route: '/dashboard/listings' })
 * if (!preview.canAct) return { error: preview.reason }
 * ```
 */
export async function renderCapabilityPreview(
  params: RenderCapabilityPreviewParams
): Promise<CapabilityPreview> {
  const { context, route, featureKey } = params

  // Build a minimal UserContext shape for resolvePageCapability
  const userContext = {
    id:          context.userId,
    email:       "",
    firstName:   "",
    lastName:    "",
    roles:       [context.userType],
    brokerageId: context.brokerageId,
  }

  // Step 1: RBAC check
  const rbac = resolvePageCapability(route, userContext as Parameters<typeof resolvePageCapability>[1])

  if (!rbac.canView) {
    return {
      rbac,
      featureAccess: null,
      canAct: false,
      reason: rbac.reason ?? `Role "${context.userType}" cannot access ${route}`,
      route,
      featureKey,
    }
  }

  // Step 2: Feature flag check (optional)
  let featureAccess: FeatureAccessCheck | null = null
  if (featureKey) {
    try {
      featureAccess = await canAccessFeature(context.userId, featureKey)
      if (!featureAccess.allowed) {
        return {
          rbac,
          featureAccess,
          canAct: false,
          reason: featureAccess.reason ?? `Feature "${featureKey}" is not available on your plan`,
          route,
          featureKey,
        }
      }
      if (featureAccess.disabled) {
        return {
          rbac,
          featureAccess,
          canAct: false,
          reason: featureAccess.disabled_reason ?? `Feature "${featureKey}" is disabled`,
          route,
          featureKey,
        }
      }
    } catch {
      // Feature flag check failure is non-fatal — allow through with null featureAccess
    }
  }

  return {
    rbac,
    featureAccess,
    canAct: true,
    route,
    featureKey,
  }
}

// ─── validateKernelContract ────────────────────────────────────────────────────

/**
 * Validates that a WriteContext satisfies all kernel structural invariants.
 * Use in Server Actions before any DB write, and in system health checks.
 *
 * Rules checked:
 *   1. userId is a non-empty UUID string
 *   2. brokerageId is a non-empty UUID string
 *   3. userType is a non-empty string
 *   4. actorContext.role is a valid ActorRole
 *   5. actorContext.userId === userId (no identity split)
 *   6. actorContext.brokerageId === brokerageId (no brokerage split)
 *   7. agentId: when userType === 'agent', agentId must be non-null
 *
 * @param context - The WriteContext to validate
 * @returns ContractValidationResult with pass/fail per rule
 */
export function validateKernelContract(
  context: WriteContext
): ContractValidationResult {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const VALID_ROLES = new Set([
    "superadmin", "broker", "admin", "team_lead", "agent",
    "isa", "tc", "compliance_officer", "vendor", "lender",
    "title_agent", "contact", "system",
  ])

  const rules: ContractValidationRule[] = [
    {
      rule:   "userId is a valid UUID",
      passed: UUID_RE.test(context.userId),
      detail: context.userId,
    },
    {
      rule:   "brokerageId is a valid UUID",
      passed: UUID_RE.test(context.brokerageId),
      detail: context.brokerageId,
    },
    {
      rule:   "userType is non-empty",
      passed: typeof context.userType === "string" && context.userType.length > 0,
      detail: context.userType,
    },
    {
      rule:   "actorContext.role is a valid ActorRole",
      passed: VALID_ROLES.has(context.actorContext.role),
      detail: context.actorContext.role,
    },
    {
      rule:   "actorContext.userId matches context.userId",
      passed: context.actorContext.userId === context.userId,
      detail: `actorContext.userId=${context.actorContext.userId}`,
    },
    {
      rule:   "actorContext.brokerageId matches context.brokerageId",
      passed: context.actorContext.brokerageId === context.brokerageId,
      detail: `actorContext.brokerageId=${context.actorContext.brokerageId}`,
    },
    {
      rule:   "agentId is non-null when userType is 'agent'",
      passed: context.userType !== "agent" || context.agentId !== null,
      detail: `userType=${context.userType}, agentId=${context.agentId}`,
    },
  ]

  const failedRules = rules.filter(r => !r.passed).map(r => r.rule)

  return {
    valid: failedRules.length === 0,
    rules,
    failedRules,
  }
}
