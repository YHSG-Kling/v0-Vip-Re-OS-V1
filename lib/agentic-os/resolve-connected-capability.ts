// lib/agentic-os/resolve-connected-capability.ts
// Server resolver for USER-CONNECTED vendor capabilities. The platform budget does NOT
// gate these — the brokerage pays the vendor directly — so the gate is whether the
// account is CONNECTED. We probe connection-manager for each canonical provider the
// capability accepts and return the FIRST live connection (with its credential source),
// or a not-connected result listing what the brokerage would need to connect.
//
// This is the user-connected analogue of resolve-vendor-capability.ts (which is
// budget-aware). Kept here (server) and out of the pure registry so the registry stays
// I/O-free and unit-testable.

import { resolveConnection } from "@/lib/integrations/connection-manager"
import {
  CONNECTED_CAPABILITY_REGISTRY,
  type ConnectedCapability,
  type ConnectedCapabilityDef,
} from "./connected-vendor-registry"

export interface ConnectedCapabilityResolution {
  capability: ConnectedCapability
  def: ConnectedCapabilityDef
  connected: boolean
  /** The canonical provider that satisfied the gate (first live connection), or null. */
  provider: string | null
  /** Where that credential lives, when connected. */
  source: "platform_credentials" | "integration_credentials" | "agent_api_credentials" | null
  /** When not connected: the providers the brokerage could connect to enable this. */
  missing: string[]
}

/**
 * Resolve whether a brokerage can invoke a user-connected capability. Probes each
 * accepted provider via connection-manager (agent → platform → integration precedence)
 * and returns the first that is live. Never throws — a lookup failure reads as "not
 * connected" so the caller surfaces an honest gate, not a 500.
 */
export async function resolveConnectedCapability(
  capability: ConnectedCapability,
  ctx: { brokerageId: string; agentId?: string; agentUserId?: string },
): Promise<ConnectedCapabilityResolution> {
  const def = CONNECTED_CAPABILITY_REGISTRY[capability]
  for (const provider of def.connections) {
    try {
      const conn = await resolveConnection({
        brokerageId: ctx.brokerageId,
        provider,
        agentId: ctx.agentId,
        agentUserId: ctx.agentUserId,
      })
      if (conn) {
        return { capability, def, connected: true, provider: conn.provider, source: conn.source, missing: [] }
      }
    } catch {
      // probe failure → treat this provider as not connected, keep checking the rest
    }
  }
  return { capability, def, connected: false, provider: null, source: null, missing: def.connections }
}

/**
 * THE STATED-ORIGIN PROBE (wave 155, lane 155R25 — the P0 credentials sink rule, directive D 152). When the request is an
 * EXTERNAL AGENT's (an agentic bearer token, not the tenant's own code or a signed-in person), the credential store is read
 * BECAUSE a model asked — so each provider's credential read goes through THE stated-origin door
 * (lib/connections/resolve-scoped.ts resolveScopedConnectionForOrigin): the sink rule decides before a credential row is read
 * and ONE access.credential.read decision row records who asked, for which provider and owner scope (never a value). A
 * separate function on purpose (LESSON 5): the plain probe above stays read-only in the source for session callers. A hold at
 * the sink stops the walk (the same origin would be held for every provider) and reads as not connected — fail closed.
 */
export async function resolveConnectedCapabilityForOrigin(
  capability: ConnectedCapability,
  ctx: { brokerageId: string },
  origin: Parameters<typeof import("@/lib/connections/resolve-scoped").resolveScopedConnectionForOrigin>[2],
): Promise<ConnectedCapabilityResolution> {
  const def = CONNECTED_CAPABILITY_REGISTRY[capability]
  const { resolveScopedConnectionForOrigin } = await import("@/lib/connections/resolve-scoped")
  for (const provider of def.connections) {
    const r = await resolveScopedConnectionForOrigin(provider, { brokerageId: ctx.brokerageId }, origin)
    if (r.status === "connected") return { capability, def, connected: true, provider: r.connection.provider, source: r.connection.source, missing: [] }
    if (r.status === "unreadable" && /^held at the credentials sink|no tenant/.test(r.detail)) break
  }
  return { capability, def, connected: false, provider: null, source: null, missing: def.connections }
}
