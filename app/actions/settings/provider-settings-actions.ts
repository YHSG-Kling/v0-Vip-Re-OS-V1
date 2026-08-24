'use server'

import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerageAdmin } from "@/lib/auth/require-brokerage-admin"
// ★ ACT-AS WRITE SEAM ★ — every export resolves the EFFECTIVE identity through
// the seam (the impersonated seat when platform staff act as the tenant), so
// requireBrokerAdmin below evaluates the IMPERSONATED user's row instead of the
// raw staff row (NULL brokerage → refused). Writers refuse read_only grants and
// write through the acting db; readers ride resolveActingContext.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type ProviderOverrideRow = {
  id: string
  provider_type: string
  provider_key: string
  scope_type: string
  scope_id: string
  config: Record<string, unknown>
  enabled: boolean
}

export type ProviderSettingsPayload = {
  provider_type: string
  provider_key: string
  config?: Record<string, unknown>
  enabled: boolean
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Returns the caller's tenant + BOTH identity columns. `platformRole` is carried
// alongside `userType` because "is superadmin" is not answerable from user_type:
// the platform's only superadmin is (user_type='admin', platform_role='superadmin'),
// so a user_type-only test graded the platform owner as an ordinary tenant admin.
// See app/actions/vendor-budget.ts:136-147 for the canonical explanation, and
// public.is_platform_admin() for the RLS shape this mirrors.
/**
 * DELETED — the THIRD copy of the brokerage-admin gate. It had already learned
 * half the lesson (it reads platform_role and documents why), but its two role
 * arrays still omitted `broker_owner`, so it locked a brokerage OWNER out of
 * their own provider credentials.
 *
 * Survivor: lib/auth/require-brokerage-admin.ts:requireBrokerageAdmin, which
 * carries this copy's platformRole return value and its user_role_assignments
 * fallback (including the note that the fallback path is tenant-only by
 * construction, so platformRole is null there).
 */
async function requireBrokerAdmin(userId: string): Promise<{ brokerageId: string; userType: string; platformRole: string | null }> {
  // Service client: this module reads and writes credential rows the caller
  // cannot see directly, so it deliberately bypasses RLS. Unchanged.
  return requireBrokerageAdmin(createServiceClient(), userId)
}

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — the local isSuperadminIdentity(userType, platformRole)
// ═══════════════════════════════════════════════════════════════════════════
// DELETED (owner ruling 1, 2026-08-24). Its body was
//     return userType === "superadmin" || platformRole === "superadmin"
// — a local FIFTH copy of the discriminator, under a doc comment ("BOTH columns,
// never user_type alone") that was correct and still could not stop the rule from
// drifting away from the four other copies.
//
// SURVIVOR, AT file:line:
//     lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
// Same both-columns rule, plus an explicit refusal of the ai_isa_system service
// accounts. Its two call sites below now name it directly, so the rule is legible
// at the gate rather than behind a local alias.
//
// WHAT THE DOC COMMENT SAID, KEPT BECAUSE IT IS STILL THE REASON THIS IS THE
// SUPERADMIN TEST AND NOT THE STAFF ROSTER: it governs the system-only provider
// types the whole platform shares, so it stays narrower than platform staff
// (superadmin/admin/marketing/support).

// SYSTEM_ONLY_TYPES mirror kernel/providers.ts — brokerage cannot override these.
const SYSTEM_ONLY_TYPES = new Set(["direct_mail", "video"])

const SYSTEM_DEFAULTS: Record<string, string> = {
  email:       "sendgrid",
  sms:         "twilio",
  phone:       "twilio",
  social:      "buffer",
  calendar:    "google",
  payment:     "stripe",
  esign:       "dotloop",
  transaction: "dotloop",
  ai:          "anthropic",
  direct_mail: "lob",
  video:       "did",
}

// ─── READ ─────────────────────────────────────────────────────────────────────

export async function getProviderSettings(): Promise<{
  overrides: ProviderOverrideRow[]
  isSuperadmin: boolean
  brokerageId: string
}> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) throw new Error(ctx.error)
  const supabase = ctx.db

  const { brokerageId, userType, platformRole } = await requireBrokerAdmin(ctx.userId)
  const isSuperadmin = isPlatformSuperadminIdentity(userType, platformRole)

  const { data: rows, error } = await supabase
    .from("provider_overrides")
    .select("id, provider_type, provider_key, scope_type, scope_id, config, enabled")
    .eq("scope_type", "brokerage")
    .eq("scope_id", brokerageId)

  if (error) throw new Error(`Failed to load provider settings: ${error.message}`)

  return {
    overrides: (rows ?? []) as ProviderOverrideRow[],
    isSuperadmin,
    brokerageId,
  }
}

export async function getSystemProviderStatus(): Promise<{
  directMailEnabled: boolean
  videoEnabled: boolean
}> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) throw new Error(ctx.error)
  const supabase = ctx.db

  // Check if superadmin has enabled direct_mail / video overrides
  const { data: rows } = await supabase
    .from("provider_overrides")
    .select("provider_type, enabled")
    .eq("scope_type", "superadmin")
    .in("provider_type", ["direct_mail", "video"])

  const directMailRow = rows?.find((r: { provider_type: string }) => r.provider_type === "direct_mail")
  const videoRow = rows?.find((r: { provider_type: string }) => r.provider_type === "video")

  return {
    directMailEnabled: directMailRow?.enabled ?? false,
    videoEnabled: videoRow?.enabled ?? false,
  }
}

// ─── WRITE ────────────────────────────────────────────────────────────────────

export async function saveProviderOverride(
  payload: ProviderSettingsPayload
): Promise<void> {
  // ACT-AS WRITE SEAM — read_only impersonation refused before any write; the
  // upsert below rides the acting db (cookie normally, service under a FULL
  // grant re-validated on this call).
  const ctx = await resolveWriteContext()
  if (!ctx.ok) throw new Error(ctx.error)
  const supabase = ctx.db

  const { brokerageId, userType, platformRole } = await requireBrokerAdmin(ctx.userId)

  // Brokerages cannot override system-only types
  if (SYSTEM_ONLY_TYPES.has(payload.provider_type) && !isPlatformSuperadminIdentity(userType, platformRole)) {
    throw new Error(`Provider type "${payload.provider_type}" is superadmin-controlled and cannot be overridden by brokerage`)
  }

  const fallback = SYSTEM_DEFAULTS[payload.provider_type] ?? payload.provider_type

  // Upsert on (scope_type, scope_id, provider_type)
  const { error } = await supabase
    .from("provider_overrides")
    .upsert(
      {
        scope_type:    "brokerage",
        scope_id:      brokerageId,
        provider_type: payload.provider_type,
        provider_key:  payload.provider_key || fallback,
        config:        payload.config ?? {},
        enabled:       payload.enabled,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: "scope_type,scope_id,provider_type" }
    )

  if (error) throw new Error(`Failed to save provider override: ${error.message}`)
}
