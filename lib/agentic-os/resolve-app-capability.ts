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
// ─── PHASE 2: ASK THE QUESTION THE APP ALREADY KNEW HOW TO ANSWER ────────────
//
// Phase 1 invented its own platform check: "is there a row in
// platform_credentials for this provider?" That was wrong in the direction that
// matters. The dispatchers gate on ENV KEYS —
//
//   dispatchDirectMail   if (!process.env.LOB_API_KEY) return unconfigured
//   messagingSendEmail   if (!process.env.SENDGRID_API_KEY) return unconfigured
//   getRentcastComps     tenant integration_credentials row, else RENTCAST_API_KEY
//
// — so a platform with LOB_API_KEY set and direct mail sending happily read
// DARK, and the readiness board and the manifest disagreed about the same
// provider.
//
// The app already had ONE resolver for this: resolveBrokerageReadinessState in
// lib/platform/provider-posture.ts, which folds all three signals (the tenant's
// own credential row, the platform env key, keyless lanes) into one state. So
// this module no longer answers the question itself — it ASKS that resolver, via
// getBrokerageProviderReadiness, and the manifest and the readiness board can no
// longer drift. One question, one answer, one place.
//
// Tenant CONNECTIONS still resolve through resolveConnection, because that path
// is agent-scope-correct: an agent sees THEIR own connection, not the brokerage
// pool (the owner's fix, mirrored in resolve-connectivity.ts). The readiness
// resolver is brokerage-wide by construction, so using it for agent-scoped
// connections would over-report.
//
// ─── AND IT REPORTS THE SELF-HEALING STATE, NOT JUST "NOT CONNECTED" ─────────
//
// The OS already recovers connections on its own: connector-probe classifies a
// provider's health, connectivity-agent derives expiry-aware status, and
// connector-healer proposes a repair onto connector_healing_proposals for the
// auto-applier. A capability resolver that says a flat "not connected" while the
// healer is mid-repair tells an agent to give up on something that is being
// fixed. So a resolution also carries:
//
//   attention        operable TODAY but the token lapses inside the warning
//                    window — act before it goes dark, not after
//   healingInFlight  a healing proposal is open for a provider this capability
//                    needs, so "dark" means "being repaired", not "abandoned"

import { resolveConnection } from "@/lib/integrations/connection-manager"
import { createServiceClient } from "@/lib/supabase/service"
import {
  getBrokerageProviderReadiness,
  type BrokerageProviderReadiness,
} from "@/lib/platform/provider-posture"
import {
  deriveConnectivityStatus,
  needsAttention,
  transportFor,
  type ConnectivityStatus,
} from "./connectivity-agent"
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
  /**
   * Live connectivity status of the connection that satisfied the gate. Null for
   * platform lanes (nothing expires) and for capabilities with no requirement.
   */
  connectivity: ConnectivityStatus | null
  /** Operable now, but the satisfying credential is expired/expiring — act early. */
  attention: boolean
  /** A healing proposal is open for a provider this capability needs. */
  healingInFlight: boolean
}

/**
 * Shared per-request state, so resolving 27 capabilities costs ONE readiness
 * scan and ONE healing-proposal read instead of 27 of each.
 */
export interface CapabilityResolutionContext {
  brokerageId: string
  agentId?: string
  agentUserId?: string
  /** Injected by resolveAllAppCapabilities; built lazily for a single resolve. */
  readiness?: BrokerageProviderReadiness
  /** Canonical providers with an open healing proposal. */
  healing?: ReadonlySet<string>
}

/**
 * Is this provider's PLATFORM lane usable by this brokerage — through the ONE
 * canonical resolver? `ready` there already means "usable by this brokerage right
 * now": their own credential row, or the platform env key, or a keyless lane.
 *
 * Fails CLOSED: a provider absent from the registry, or a readiness scan that
 * could not be built, reads as not usable. Reporting a capability ready when we
 * could not verify it is exactly the optimism that made these failures invisible.
 */
function platformLaneReady(readiness: BrokerageProviderReadiness | undefined, provider: string): boolean {
  if (!readiness) return false
  const row = readiness.rows.find((r) => r.provider === provider)
  return row?.ready === true
}

/** Providers with an OPEN healing proposal — the auto-applier's queue is
 *  status='pending', so that is what "being repaired right now" means. */
async function loadHealingProviders(): Promise<Set<string>> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("connector_healing_proposals")
      .select("connector")
      .eq("status", "pending")
      .limit(500)
    return new Set(((data ?? []) as Array<{ connector: string | null }>)
      .map((r) => (r.connector ?? "").trim().toLowerCase())
      .filter(Boolean))
  } catch {
    // No healing signal is not the same as "nothing is being healed" — but it is
    // the only honest thing to say, and it never upgrades a dark capability.
    return new Set()
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
  ctx: CapabilityResolutionContext,
): Promise<AppCapabilityResolution> {
  const def = APP_CAPABILITY_REGISTRY[capability]
  const base = {
    capability, def,
    missing: [] as string[],
    satisfiedBy: null as string | null,
    connectivity: null as ConnectivityStatus | null,
    attention: false,
    healingInFlight: false,
  }

  // Not-yet-modelled dependencies are reported as such — NOT as ready. An absent
  // contract must never read like a satisfied one.
  if ((UNDECLARED_REQUIREMENTS as readonly string[]).includes(capability)) {
    return { ...base, operable: false, reason: "requirement_not_modelled" }
  }

  const req = def.requires
  // No declared dependency and not on the backlog → it runs on the kernel alone.
  if (!req || (!req.connections?.length && !req.platform?.length)) {
    return { ...base, operable: true, reason: null }
  }

  const needed = [...(req.connections ?? []), ...(req.platform ?? [])]
  const healing = ctx.healing ?? (await loadHealingProviders())
  const healingInFlight = needed.some((p) => healing.has(p.toLowerCase()))

  // ── 1. Tenant connections, ANY-of. Agent-scoped, so this stays on
  //       resolveConnection rather than the brokerage-wide readiness scan.
  for (const provider of req.connections ?? []) {
    try {
      const conn = await resolveConnection({
        brokerageId: ctx.brokerageId,
        provider,
        agentId: ctx.agentId,
        agentUserId: ctx.agentUserId,
      })
      if (conn) {
        // Operable — but say so honestly when the token is about to lapse. The
        // connectivity agent owns this derivation; no second expiry rule here.
        const status = deriveConnectivityStatus({
          connected: true,
          transport: conn.tokenExpiresAt ? "oauth" : transportFor(conn.provider),
          isActive: conn.isActive,
          tokenExpiresAt: conn.tokenExpiresAt,
        })
        return {
          ...base,
          operable: true,
          reason: null,
          satisfiedBy: conn.provider,
          connectivity: status,
          attention: needsAttention(status),
          healingInFlight,
        }
      }
    } catch {
      // keep checking the rest — one unreachable provider is not a verdict
    }
  }

  // ── 2. Platform-owned lanes, ANY-of — through the canonical readiness
  //       resolver, NOT a second implementation. Reached even when
  //       `connections` was declared: several capabilities are servable either
  //       way, and phase 1 returned before ever looking here.
  if (req.platform?.length) {
    const readiness = ctx.readiness ?? (await safeReadiness(ctx.brokerageId))
    for (const provider of req.platform) {
      if (platformLaneReady(readiness, provider)) {
        return {
          ...base,
          operable: true,
          reason: null,
          satisfiedBy: `platform:${provider}`,
          connectivity: "platform_managed",
          healingInFlight,
        }
      }
    }
  }

  // Nothing satisfied it. The reason names what the tenant can act on: if a
  // tenant connection would fix it, say so — a platform lane is not theirs to
  // configure, and sending a broker hunting for a connect button that does not
  // exist is its own failure.
  const tenantActionable = (req.connections?.length ?? 0) > 0
  return {
    ...base,
    operable: false,
    reason: tenantActionable ? "no_connection" : "no_platform_credential",
    missing: needed,
    healingInFlight,
  }
}

/** Readiness scan that never throws — an unbuildable scan fails closed. */
async function safeReadiness(brokerageId: string): Promise<BrokerageProviderReadiness | undefined> {
  try {
    return await getBrokerageProviderReadiness(createServiceClient(), brokerageId)
  } catch {
    return undefined
  }
}

/** Resolve every app capability for a brokerage — the readiness board's input.
 *  One readiness scan and one healing read for the whole set. */
export async function resolveAllAppCapabilities(
  ctx: { brokerageId: string; agentId?: string; agentUserId?: string },
): Promise<AppCapabilityResolution[]> {
  const [readiness, healing] = await Promise.all([
    safeReadiness(ctx.brokerageId),
    loadHealingProviders(),
  ])
  const shared: CapabilityResolutionContext = { ...ctx, readiness, healing }
  const caps = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]
  return Promise.all(caps.map((c) => resolveAppCapability(c, shared)))
}

/** PURE — a sentence a broker can act on, per block reason. */
export function blockExplanation(r: AppCapabilityResolution): string | null {
  // A repair already under way outranks the bare block: the answer to "why can't
  // I use this?" is "it broke and is being fixed", not "connect something".
  if (!r.operable && r.healingInFlight) {
    return `Temporarily unavailable — ${r.missing.join(" / ")} is being repaired automatically. No action needed yet.`
  }
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

/** PURE — the warning for an operable-but-lapsing capability. Null when healthy. */
export function attentionExplanation(r: AppCapabilityResolution): string | null {
  if (!r.attention || !r.satisfiedBy) return null
  if (r.connectivity === "expired") {
    return `${r.satisfiedBy} has expired — reconnect it to keep this working.`
  }
  if (r.connectivity === "expiring_soon") {
    return `${r.satisfiedBy} expires soon — reconnect it before this goes dark.`
  }
  return null
}
