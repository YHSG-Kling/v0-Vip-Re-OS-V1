"use server"

// app/actions/admin/domain-coherence.ts
// Server-action wrappers for all 8 domain coherence kernel commands.
// Input:  Validated, typed contract objects
// Output: { success: boolean; data?: T; error?: string }
// Tables: none (registry-only, no DB reads/writes)

import { createClient } from "@/lib/supabase/server"
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
async function requireAdminRole(): Promise<{ userId: string } | { error: string; status: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Unauthorized", status: 401 }

  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile || !["superadmin", "admin", "broker"].includes(profile.user_type ?? "")) {
    return { error: "Forbidden", status: 403 }
  }
  return { userId: user.id }
}

// ─── Action 1: Enumerate Domain Routes ───────────────────────────────────────
export async function actionEnumerateDomainRoutes(input: EnumerateRoutesInput) {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const data = enumerateDomainRoutes(input)
  return { success: true as const, data }
}

// ─── Action 2: Classify Route Ownership ──────────────────────────────────────
export async function actionClassifyRouteOwnership() {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const data = classifyRouteOwnership({ routes })
  return { success: true as const, data }
}

// ─── Action 3: Validate Canonical Manager Usage ───────────────────────────────
export async function actionValidateCanonicalManagerUsage(input: ValidateManagerInput) {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  if (!Array.isArray(input.kernelModules) || input.kernelModules.length === 0) {
    return { success: false as const, error: "kernelModules must be a non-empty array" }
  }

  const data = validateCanonicalManagerUsage(input)
  return { success: true as const, data }
}

// ─── Action 4: Detect Duplicate Manager Surfaces ─────────────────────────────
export async function actionDetectDuplicateManagerSurfaces() {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const data = detectDuplicateManagerSurfaces({ routes })
  return { success: true as const, data }
}

// ─── Action 5: Normalize Navigation Visibility ───────────────────────────────
export async function actionNormalizeNavigationVisibility(input: NormalizeNavInput) {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  if (!input.userType) {
    return { success: false as const, error: "userType is required" }
  }

  const data = normalizeNavigationVisibility(input)
  return { success: true as const, data }
}

// ─── Action 6: Validate Provider-Backed Features ─────────────────────────────
export async function actionValidateProviderBackedFeatures(input: ValidateProvidersInput) {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  if (!Array.isArray(input.domains) || input.domains.length === 0) {
    return { success: false as const, error: "domains must be a non-empty array" }
  }

  const data = validateProviderBackedFeatures(input)
  return { success: true as const, data }
}

// ─── Action 7: Validate Contract Integrity ───────────────────────────────────
export async function actionValidateContractIntegrity() {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const data = validateContractIntegrity({ routes })
  return { success: true as const, data }
}

// ─── Action 8: Generate Domain Coherence Report ───────────────────────────────
export async function actionGenerateDomainCoherenceReport() {
  const auth = await requireAdminRole()
  if ("error" in auth) return { success: false as const, error: auth.error }

  const data = generateDomainCoherenceReport({ includeRecommendations: true })
  return { success: true as const, data }
}
