"use server"

/**
 * app/actions/voice-access.ts — the voice assistant's access policy verbs.
 *
 * VOICE ACCESS POLICY (owner: "voice assistant should be able to expand to
 * staff if management wants, and platform staff"):
 *   • Agents (an agents row exists) and principals (broker/admin family)
 *     always have the voice assistant.
 *   • Platform staff always have it.
 *   • Other tenant staff roles (TC, compliance_officer, …) have it ONLY when
 *     the principal enabled their role via the brokerage-level setting
 *     voice_assistant_expanded_roles (global_settings.additional_settings —
 *     the existing settings jsonb home; no new table).
 *   • Expansion grants SURFACE access only — per-intent permissions remain
 *     each role's existing tool-registry authority gates, never widened.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import {
  EXPANDABLE_VOICE_ROLES,
  getVoiceAssistantExpandedRoles,
} from "@/lib/brokerage/get-brokerage-settings"

const PRINCIPAL_VOICE_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "superadmin"])

// Management seats that may change the expansion setting — mirrors the
// requireBrokerAdmin idiom of lib/kernel/global-settings.
const MANAGEMENT_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "superadmin"])

/**
 * Does the CURRENT user get the voice assistant surface (mic FAB + overlay)?
 * Used by the client shell for honest visibility; the session-mint route
 * re-enforces the same policy server-side.
 */
export async function getVoiceAssistantAccess(): Promise<{ allowed: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { allowed: false }

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const userType = String(profile?.user_type ?? "")

  if (isPlatformStaffIdentity(userType, (profile as any)?.platform_role ?? null)) return { allowed: true }
  if (PRINCIPAL_VOICE_ROLES.has(userType)) return { allowed: true }
  if (userType === "agent") return { allowed: true }

  if (!profile?.brokerage_id) return { allowed: false }
  const expanded = await getVoiceAssistantExpandedRoles(profile.brokerage_id)
  return { allowed: expanded.includes(userType) }
}

export interface VoiceAccessSettingsRead {
  /** roles the principal has enabled */
  expandedRoles: string[]
  /** roles the principal MAY enable (the sanctioned allowlist) */
  expandableRoles: string[]
}

async function requireManagement(): Promise<
  { ok: true; brokerageId: string } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id || !MANAGEMENT_ROLES.has(String(profile.user_type ?? ""))) {
    return { ok: false, error: "Management access required" }
  }
  return { ok: true, brokerageId: profile.brokerage_id }
}

/** Management read for the Settings toggle card. */
export async function getVoiceAccessSettings(): Promise<
  { success: true; settings: VoiceAccessSettingsRead } | { success: false; error: string }
> {
  const gate = await requireManagement()
  if (!gate.ok) return { success: false, error: gate.error }
  const expandedRoles = await getVoiceAssistantExpandedRoles(gate.brokerageId)
  return {
    success: true,
    settings: { expandedRoles, expandableRoles: [...EXPANDABLE_VOICE_ROLES] },
  }
}

/**
 * Management write: set which staff roles the voice assistant is expanded to.
 * Sanitized against EXPANDABLE_VOICE_ROLES; merge-preserving jsonb write into
 * global_settings.additional_settings (same idiom as the other settings
 * toggles — reads always go back through the brokerage-settings resolver).
 */
export async function setVoiceAssistantExpandedRoles(
  roles: string[],
): Promise<{ success: boolean; error?: string; expandedRoles?: string[] }> {
  const gate = await requireManagement()
  if (!gate.ok) return { success: false, error: gate.error }

  const allowed = new Set<string>(EXPANDABLE_VOICE_ROLES)
  const sanitized = [...new Set(roles.map(String))].filter((r) => allowed.has(r))

  const svc = createServiceClient()
  const { data: gs } = await svc
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  const existing = (gs?.additional_settings as Record<string, unknown> | null) ?? {}
  const { error } = await svc
    .from("global_settings")
    .update({ additional_settings: { ...existing, voice_assistant_expanded_roles: sanitized } })
    .eq("brokerage_id", gate.brokerageId)
  if (error) return { success: false, error: "Could not save voice access settings" }
  return { success: true, expandedRoles: sanitized }
}
