// lib/platform/require-capability.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE server-side gate for platform-staff surfaces. Every superadmin page used
// to hand-roll its own user_type/platform_role comparison (three drifted
// patterns, most ignoring platform_role, only one consulting the capability
// map). This consolidates them: load the caller, derive the platform role the
// canonical way, and answer via platformStaffCan — so what each staff role can
// reach is provable from ONE map (lib/platform/platform-staff-roster.ts).
//
// ROUND 20 — OVERRIDE LAYER: the pure code map stays the DEFAULT; the gate now
// also consults platform_role_capability_overrides (superadmin-edited, tiny
// table) via lib/platform/capability-overrides.ts, which can GRANT, REVOKE, or
// downgrade write→read per role×capability. superadmin is NEVER overridable.

import { createClient } from "@/lib/supabase/server"
import { platformStaffCan, isPlatformStaffRole, type PlatformCapability } from "./platform-staff-roster"
import { loadCapabilityOverrides, mergeCapability } from "./capability-overrides"

export interface CapabilityGate {
  ok: boolean
  userId: string | null
  /** The resolved platform role ('superadmin' | 'admin' | 'marketing' | 'support' | null). */
  role: string | null
  /**
   * Effective access level when ok ('write' unless an override downgraded this
   * role×capability to 'read'); undefined when the gate failed.
   *
   * HONESTY NOTE: 'read' is SURFACED here so pages can render read-only
   * banners — it is NOT yet enforced at every write path. Server actions are
   * still gated by their own role checks (mostly superadmin-only), so a
   * read-downgraded role cannot mutate through those; but generic action-layer
   * read-only enforcement is a LATER increment. A page that mutates may opt in
   * today via { requireWrite: true }.
   */
  access?: "read" | "write"
  error?: string
}

/** Resolve the caller's platform role: platform_role wins; legacy
 *  user_type='superadmin' still counts as superadmin. */
export function resolvePlatformRole(profile: { user_type?: string | null; platform_role?: string | null } | null): string | null {
  if (!profile) return null
  return profile.platform_role ?? (profile.user_type === "superadmin" ? "superadmin" : null)
}

/** Server gate: is the current user platform staff with this capability?
 *  Code-map default merged with superadmin overrides (mergeCapability). */
export async function requirePlatformCapability(
  capability: PlatformCapability,
  opts: { requireWrite?: boolean } = {},
): Promise<CapabilityGate> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, userId: null, role: null, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRole(data as any)
  if (!isPlatformStaffRole(role)) {
    return { ok: false, userId: user.id, role, error: `Forbidden — requires platform '${capability}' capability` }
  }
  // HARD RULE: superadmin is '*' and NEVER overridable — short-circuit before
  // the override layer is even consulted (the table's role CHECK excludes it too).
  if (role === "superadmin") return { ok: true, userId: user.id, role, access: "write" }

  const defaultAllowed = platformStaffCan(role, capability)
  const overrides = await loadCapabilityOverrides()
  const merged = mergeCapability(defaultAllowed, overrides.find((o) => o.role === role && o.capability === capability))
  if (!merged.allowed) {
    return { ok: false, userId: user.id, role, error: `Forbidden — requires platform '${capability}' capability` }
  }
  if (opts.requireWrite && merged.access !== "write") {
    return { ok: false, userId: user.id, role, access: merged.access, error: `Forbidden — '${capability}' is read-only for your role` }
  }
  return { ok: true, userId: user.id, role, access: merged.access }
}
