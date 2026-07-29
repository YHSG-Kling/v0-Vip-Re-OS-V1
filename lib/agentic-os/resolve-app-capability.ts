// lib/agentic-os/resolve-app-capability.ts
// ─────────────────────────────────────────────────────────────────────────────
// IS THIS CAPABILITY OPERABLE FOR THIS TENANT, RIGHT NOW?
//
// The action manifest already answered "who is AUTHORIZED" (scope). It never
// answered "can it actually run", and those are different questions: a caller can
// hold `finance:write` while the tenant has no QuickBooks at all.
//
// That mattered because buildFullActionManifest powers /api/agentic-os/actions
// AND the MCP `tools/list`. So every connected agent — including the voice admin
// — was advertised all 27 app capabilities as available, and could only discover
// otherwise by CALLING ONE AND WATCHING IT FAIL. An autonomous agent that learns
// its own limits by breaking things is the opposite of what a broker needs.
//
// This is the app-capability analogue of resolve-connected-capability.ts and
// resolve-vendor-capability.ts, deliberately the same shape and using the SAME
// machinery (resolveConnection, platform credential presence). No new probing
// path — a second way to ask "is this provider live?" is how provider state
// drifted before.

import { resolveConnection } from "@/lib/integrations/connection-manager"
import { createServiceClient } from "@/lib/supabase/service"
import {
  APP_CAPABILITY_REGISTRY,
  UNDECLARED_REQUIREMENTS,
  type AppCapability,
  type AppCapabilityDef,
} from "./app-capability-registry"

/** Why a capability is not operable — in words a broker can act on. */
export type CapabilityBlockReason =
  | "no_connection"          // needs a tenant connection; none of the accepted ones is live
  | "no_platform_credential" // needs a platform-owned credential the platform has not configured
  | "requirement_not_modelled" // it plainly needs something external, and we have not asserted what

export interface AppCapabilityResolution {
  capability: AppCapability
  def: AppCapabilityDef
  /** True only when every declared requirement is satisfied. Never optimistic. */
  operable: boolean
  reason: CapabilityBlockReason | null
  /** What would have to be connected/configured. Any-of. */
  missing: string[]
  /** The connection that satisfied the gate, when one did. */
  satisfiedBy: string | null
}

/** Does the PLATFORM hold a credential for this provider? Platform-owned lanes
 *  (m273 idiom) are keyed distinctly in platform_credentials. */
async function platformCredentialPresent(provider: string): Promise<boolean> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("platform_credentials")
      .select("platform")
      .in("platform", [provider, `platform_${provider}`])
      .limit(1)
    return ((data ?? []) as unknown[]).length > 0
  } catch {
    // A lookup failure reads as NOT configured. Failing closed is the point:
    // reporting a capability ready when we could not verify it is exactly the
    // optimism that made these failures invisible.
    return false
  }
}

/**
 * Resolve whether an app capability can actually run for a brokerage.
 *
 * Never throws — a probe failure reads as "not operable" with an honest reason,
 * so a discovery endpoint degrades into truthful caution rather than a 500.
 */
export async function resolveAppCapability(
  capability: AppCapability,
  ctx: { brokerageId: string; agentId?: string; agentUserId?: string },
): Promise<AppCapabilityResolution> {
  const def = APP_CAPABILITY_REGISTRY[capability]

  // Not-yet-modelled dependencies are reported as such — NOT as ready. An absent
  // contract must never read like a satisfied one.
  if ((UNDECLARED_REQUIREMENTS as readonly string[]).includes(capability)) {
    return {
      capability, def, operable: false,
      reason: "requirement_not_modelled",
      missing: [], satisfiedBy: null,
    }
  }

  const req = def.requires
  // No declared dependency and not on the backlog → it runs on the kernel alone.
  if (!req || (!req.connections?.length && !req.platform?.length)) {
    return { capability, def, operable: true, reason: null, missing: [], satisfiedBy: null }
  }

  // Tenant connections, ANY-of.
  if (req.connections?.length) {
    for (const provider of req.connections) {
      try {
        const conn = await resolveConnection({
          brokerageId: ctx.brokerageId,
          provider,
          agentId: ctx.agentId,
          agentUserId: ctx.agentUserId,
        })
        if (conn) {
          return {
            capability, def, operable: true, reason: null,
            missing: [], satisfiedBy: conn.provider,
          }
        }
      } catch {
        // keep checking the rest — one unreachable provider is not a verdict
      }
    }
    return {
      capability, def, operable: false,
      reason: "no_connection",
      missing: [...req.connections], satisfiedBy: null,
    }
  }

  // Platform-owned credentials, ANY-of. The tenant cannot fix these — only the
  // platform can — so the reason is distinct, and the UI must say so rather than
  // sending a broker hunting for a connect button that does not exist.
  for (const provider of req.platform ?? []) {
    if (await platformCredentialPresent(provider)) {
      return {
        capability, def, operable: true, reason: null,
        missing: [], satisfiedBy: `platform:${provider}`,
      }
    }
  }
  return {
    capability, def, operable: false,
    reason: "no_platform_credential",
    missing: [...(req.platform ?? [])], satisfiedBy: null,
  }
}

/** Resolve every app capability for a brokerage — the readiness board's input. */
export async function resolveAllAppCapabilities(
  ctx: { brokerageId: string; agentId?: string; agentUserId?: string },
): Promise<AppCapabilityResolution[]> {
  const caps = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]
  return Promise.all(caps.map((c) => resolveAppCapability(c, ctx)))
}

/** PURE — a sentence a broker can act on, per block reason. */
export function blockExplanation(r: AppCapabilityResolution): string | null {
  switch (r.reason) {
    case "no_connection":
      return `Connect one of: ${r.missing.join(", ")}.`
    case "no_platform_credential":
      return `Waiting on the platform to configure ${r.missing.join(" or ")} — nothing for you to do.`
    case "requirement_not_modelled":
      return "This needs an external provider that has not been mapped yet, so it is held rather than attempted."
    default:
      return null
  }
}
