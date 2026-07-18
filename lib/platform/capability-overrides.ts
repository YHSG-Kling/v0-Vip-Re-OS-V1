import "server-only"

// lib/platform/capability-overrides.ts
// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY OVERRIDE LAYER (server-only). The PURE code map in
// lib/platform/platform-staff-roster.ts (CAPS) stays the DEFAULT; superadmin can
// GRANT, REVOKE, or downgrade write→read per role×capability through the tiny
// platform_role_capability_overrides table (service-role only). This module owns:
//   • loadCapabilityOverrides() — read ALL rows (the table is a handful of rows
//     at most: 3 roles × 11 capabilities).
//   • mergeCapability() — the ONE pure merge of (code-map default, override row).
// SUPERADMIN IS NEVER OVERRIDABLE — hard rule: the gate short-circuits before
// consulting this layer, setCapabilityOverrideAction rejects role='superadmin',
// AND the table's role CHECK ('admin'|'marketing'|'support') excludes it.

import { createServiceClient } from "@/lib/supabase/service"
import type { CapabilityOverride } from "./platform-staff-roster"

export interface EffectiveCapability {
  allowed: boolean
  access: "read" | "write"
}

/**
 * Load every capability-override row. On a read ERROR the layer fails to the
 * CODE-MAP DEFAULTS (empty list, error logged): a broken override table must
 * never lock staff out of the platform — and because overrides can only be
 * consulted through mergeCapability, "no rows" always means "defaults", never
 * a silent extra grant.
 */
export async function loadCapabilityOverrides(): Promise<CapabilityOverride[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("platform_role_capability_overrides")
    .select("role, capability, allowed, access")
  if (error) {
    console.error("[capability-overrides] load failed — falling back to code-map defaults:", error.message)
    return []
  }
  return (data ?? []) as CapabilityOverride[]
}

/**
 * PURE merge of the code-map default with an override row for ONE role×capability:
 *   • no override row        → the default answer, with full 'write' access
 *   • override.allowed=false → REVOKED (even if the code map grants it)
 *   • override.allowed=true  → GRANTED (even if NOT in the code map — the
 *     superadmin chose to), at the override's access level ('read' downgrades
 *     the default write).
 * Role-agnostic BY DESIGN: superadmin must be short-circuited BEFORE this is
 * called (requirePlatformCapability does) — '*' is never overridable.
 */
export function mergeCapability(
  defaultAllowed: boolean,
  override: Pick<CapabilityOverride, "allowed" | "access"> | undefined,
): EffectiveCapability {
  if (!override) return { allowed: defaultAllowed, access: "write" }
  if (!override.allowed) return { allowed: false, access: "write" }
  return { allowed: true, access: override.access === "read" ? "read" : "write" }
}
