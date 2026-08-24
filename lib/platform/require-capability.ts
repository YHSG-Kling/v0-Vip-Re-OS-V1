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
import {
  platformStaffCan,
  isPlatformStaffRole,
  resolvePlatformRoleIdentity,
  type PlatformCapability,
} from "./platform-staff-roster"
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

/**
 * Resolve the caller's platform role from a users ROW. This is a row-shaped
 * ADAPTER, not a second definition: the rule itself lives in exactly one place —
 * lib/platform/platform-staff-roster.ts:resolvePlatformRoleIdentity.
 *
 * TOMBSTONE (owner ruling, ruling 1, 2026-08-24). The body used to be:
 *
 *     return profile.platform_role ?? (profile.user_type === "superadmin" ? "superadmin" : null)
 *
 * which is the SAME sentence written out again in eleven other files (the
 * app/actions/superadmin/* gates, app/dashboard/superadmin/*, the social OAuth
 * callback). All of them now call THIS adapter or the roster function it wraps;
 * the survivor is lib/platform/platform-staff-roster.ts:resolvePlatformRoleIdentity.
 *
 * ONE BEHAVIOUR CHANGE, DELIBERATE AND FAIL-CLOSED: the old expression returned
 * `platform_role` VERBATIM, so a service account came back as the string
 * "ai_isa_system" and was then compared against a staff roster that has never
 * heard of it. `ai_isa_system` is a legal users.platform_role and it is NOT a
 * human superadmin — the survivor answers `null` for it, which is the honest
 * answer to "which STAFF role is this?".
 */
export function resolvePlatformRole(profile: { user_type?: string | null; platform_role?: string | null } | null): string | null {
  if (!profile) return null
  return resolvePlatformRoleIdentity(profile.user_type, profile.platform_role)
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
