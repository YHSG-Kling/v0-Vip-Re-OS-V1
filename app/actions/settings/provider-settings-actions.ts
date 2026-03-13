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

async function requireBrokerAdmin(userId: string) {
  // Use service client to bypass RLS
  const supabase = createServiceClient()
  
  // Try public.users first
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .maybeSingle()

  if (!userError && user?.brokerage_id) {
    const userType = user.user_type || "admin"
    if (!["admin", "broker", "superadmin"].includes(userType)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return { brokerageId: user.brokerage_id as string, userType }
  }

  // Fallback: check user_role_assignments
  const { data: roleAssignment, error: roleError } = await supabase
    .from("user_role_assignments")
    .select("brokerage_id, role")
    .eq("user_id", userId)
    .maybeSingle()

  if (!roleError && roleAssignment?.brokerage_id) {
    const role = roleAssignment.role || "admin"
    if (!["admin", "broker", "superadmin"].includes(role)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return { brokerageId: roleAssignment.brokerage_id as string, userType: role }
  }

  // If user not found in either table, create a default entry or use a default brokerage
  // For now, we'll try to get a default brokerage from the brokerages table
  const { data: defaultBrokerage } = await supabase
    .from("brokerages")
    .select("id")
    .limit(1)
    .maybeSingle()

  if (defaultBrokerage?.id) {
    return { brokerageId: defaultBrokerage.id as string, userType: "admin" }
  }

  throw new Error("User not found or not associated with a brokerage, and no default brokerage available")
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
  video:       "heygen",
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

  const { brokerageId, userType } = await requireBrokerAdmin(user.id)
  const isSuperadmin = userType === "superadmin"

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

  const { brokerageId, userType } = await requireBrokerAdmin(user.id)

  // Brokerages cannot override system-only types
  if (SYSTEM_ONLY_TYPES.has(payload.provider_type) && userType !== "superadmin") {
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
