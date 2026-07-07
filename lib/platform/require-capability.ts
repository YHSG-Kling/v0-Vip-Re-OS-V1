// lib/platform/require-capability.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE server-side gate for platform-staff surfaces. Every superadmin page used
// to hand-roll its own user_type/platform_role comparison (three drifted
// patterns, most ignoring platform_role, only one consulting the capability
// map). This consolidates them: load the caller, derive the platform role the
// canonical way, and answer via platformStaffCan — so what each staff role can
// reach is provable from ONE map (lib/platform/platform-staff-roster.ts).

import { createClient } from "@/lib/supabase/server"
import { platformStaffCan, type PlatformCapability } from "./platform-staff-roster"

export interface CapabilityGate {
  ok: boolean
  userId: string | null
  /** The resolved platform role ('superadmin' | 'admin' | 'marketing' | 'support' | null). */
  role: string | null
  error?: string
}

/** Resolve the caller's platform role: platform_role wins; legacy
 *  user_type='superadmin' still counts as superadmin. */
export function resolvePlatformRole(profile: { user_type?: string | null; platform_role?: string | null } | null): string | null {
  if (!profile) return null
  return profile.platform_role ?? (profile.user_type === "superadmin" ? "superadmin" : null)
}

/** Server gate: is the current user platform staff with this capability? */
export async function requirePlatformCapability(capability: PlatformCapability): Promise<CapabilityGate> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, userId: null, role: null, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRole(data as any)
  if (!platformStaffCan(role, capability)) {
    return { ok: false, userId: user.id, role, error: `Forbidden — requires platform '${capability}' capability` }
  }
  return { ok: true, userId: user.id, role }
}
