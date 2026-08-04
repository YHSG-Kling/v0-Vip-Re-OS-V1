"use server"

// app/actions/admin/domain-coherence.ts
// Server-action wrappers for all 8 domain coherence kernel commands.
// Input:  Validated, typed contract objects
// Output: { success: boolean; data?: T; error?: string }
// Tables: none (registry-only, no DB reads/writes)
//
// AUTHORIZATION — this is PLATFORM GOVERNANCE data, not tenant data. The route
// registry enumerates every surface in the product, its kernel owner, its
// access level and every unresolved coherence finding across ALL tenants.
// It carries no brokerage_id and therefore cannot be tenant-filtered.
//
// The previous guard here accepted users.user_type ∈ {superadmin, admin,
// broker} — but 'admin' and 'broker' are TENANT roles in this schema
// (users.user_type CHECK: admin | agent | broker | broker_owner |
// compliance_officer | contact | isa | lender | superadmin | support | system |
// tc | team_lead | vendor). Any brokerage broker could read the platform's
// whole route map and governance backlog. It also ignored users.platform_role
// entirely, so real platform staff whose authority comes from platform_role
// were judged by the wrong column.
//
// Both halves are fixed by delegating to the one canonical platform gate,
// requirePlatformCapability('sentinel') — the same capability the superadmin
// observability surface uses.

import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  enumerateDomainRoutes,
  classifyRouteOwnership,
  validateCanonicalManagerUsage,
  detectDuplicateManagerSurfaces,
  normalizeNavigationVisibility,
  validateProviderBackedFeatures,
  validateContractIntegrity,
  generateDomainCoherenceReport,
  type EnumerateRoutesInput,
  type NormalizeNavInput,
  type ValidateProvidersInput,
  type ValidateManagerInput,
} from "@/lib/kernel/routes"

// ─── Auth guard ───────────────────────────────────────────────────────────────
// Platform staff only. Returns the resolved staff identity or a refusal — no
// third "empty result" branch, because an ungated caller must never receive a
// coherence verdict that looks clean.
async function requirePlatformStaff(): Promise<{ userId: string; role: string } | { error: string }> {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok || !gate.userId) {
    return { error: gate.error ?? "Forbidden — platform staff only" }
  }
  return { userId: gate.userId, role: gate.role ?? "superadmin" }
}

// ─── Action 1: Enumerate Domain Routes ───────────────────────────────────────
export async function actionEnumerateDomainRoutes(input: EnumerateRoutesInput) {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const data = enumerateDomainRoutes(input)
  return { success: true as const, data }
}

// ─── Action 2: Classify Route Ownership ──────────────────────────────────────
export async function actionClassifyRouteOwnership() {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const data = classifyRouteOwnership({ routes })
  return { success: true as const, data }
}

// ─── Action 3: Validate Canonical Manager Usage ───────────────────────────────
export async function actionValidateCanonicalManagerUsage(input: ValidateManagerInput) {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  if (!Array.isArray(input.kernelModules) || input.kernelModules.length === 0) {
    return { success: false as const, error: "kernelModules must be a non-empty array" }
  }

  const data = validateCanonicalManagerUsage(input)
  return { success: true as const, data }
}

// ─── Action 4: Detect Duplicate Manager Surfaces ─────────────────────────────
export async function actionDetectDuplicateManagerSurfaces() {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const data = detectDuplicateManagerSurfaces({ routes })
  return { success: true as const, data }
}

// ─── Action 5: Normalize Navigation Visibility ───────────────────────────────
export async function actionNormalizeNavigationVisibility(input: NormalizeNavInput) {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  if (!input.userType) {
    return { success: false as const, error: "userType is required" }
  }

  const data = normalizeNavigationVisibility(input)
  return { success: true as const, data }
}

// ─── Action 6: Validate Provider-Backed Features ─────────────────────────────
export async function actionValidateProviderBackedFeatures(input: ValidateProvidersInput) {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  if (!Array.isArray(input.domains) || input.domains.length === 0) {
    return { success: false as const, error: "domains must be a non-empty array" }
  }

  const data = validateProviderBackedFeatures(input)
  return { success: true as const, data }
}

// ─── Action 7: Validate Contract Integrity ───────────────────────────────────
export async function actionValidateContractIntegrity() {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const data = validateContractIntegrity({ routes })
  return { success: true as const, data }
}

// ─── Action 8: Generate Domain Coherence Report ───────────────────────────────
export async function actionGenerateDomainCoherenceReport() {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const data = generateDomainCoherenceReport({ includeRecommendations: true })
  return { success: true as const, data }
}
