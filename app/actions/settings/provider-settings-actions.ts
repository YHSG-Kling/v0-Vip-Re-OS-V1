'use server'

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

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
async function requireBrokerAdmin(userId: string): Promise<{ brokerageId: string; userType: string; platformRole: string | null }> {
  // Use service client to bypass RLS
  const supabase = createServiceClient()

  // Try public.users first
  const { data: user } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", userId)
    .maybeSingle()

  if (user?.brokerage_id) {
    const userType = user.user_type || "admin"
    if (!["admin", "broker", "superadmin"].includes(userType)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return {
      brokerageId: user.brokerage_id as string,
      userType,
      platformRole: (user as any).platform_role ?? null,
    }
  }

  // Fallback: check user_role_assignments. This table carries no platform_role —
  // it is a TENANT role grant — so platformRole is null here by construction, and
  // a caller reaching the platform answer through this path is not platform staff.
  const { data: roleAssignment } = await supabase
    .from("user_role_assignments")
    .select("brokerage_id, role")
    .eq("user_id", userId)
    .maybeSingle()

  if (roleAssignment?.brokerage_id) {
    const role = roleAssignment.role || "admin"
    if (!["admin", "broker", "superadmin"].includes(role)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return { brokerageId: roleAssignment.brokerage_id as string, userType: role, platformRole: null }
  }

  throw new Error("User not found or not associated with a brokerage")
}

/** "is superadmin" — BOTH columns, never user_type alone. Narrower than platform
 *  staff (superadmin/admin/marketing/support); this stays superadmin-only because
 *  it governs the system-only provider types the whole platform shares. */
function isSuperadminIdentity(userType: string, platformRole: string | null): boolean {
  return userType === "superadmin" || platformRole === "superadmin"
}

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { brokerageId, userType, platformRole } = await requireBrokerAdmin(user.id)
  const isSuperadmin = isSuperadminIdentity(userType, platformRole)

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  // Check if superadmin has enabled direct_mail / video overrides
  const { data: rows } = await supabase
    .from("provider_overrides")
    .select("provider_type, enabled")
    .eq("scope_type", "superadmin")
    .in("provider_type", ["direct_mail", "video"])

  const directMailRow = rows?.find((r) => r.provider_type === "direct_mail")
  const videoRow = rows?.find((r) => r.provider_type === "video")

  return {
    directMailEnabled: directMailRow?.enabled ?? false,
    videoEnabled: videoRow?.enabled ?? false,
  }
}

// ─── WRITE ────────────────────────────────────────────────────────────────────

export async function saveProviderOverride(
  payload: ProviderSettingsPayload
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { brokerageId, userType, platformRole } = await requireBrokerAdmin(user.id)

  // Brokerages cannot override system-only types
  if (SYSTEM_ONLY_TYPES.has(payload.provider_type) && !isSuperadminIdentity(userType, platformRole)) {
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
