// lib/connections/scope.ts
// SINGLE source of truth for connection OWNERSHIP scope. Replaces the ad-hoc per-resolver
// scoping (agent_user_id vs brokerage_id vs provider_overrides scope_type) with one model:
//
//   owner_type ∈ platform | brokerage | team | agent | vendor | contact   (+ owner_id)
//
// Resolution cascades most-specific → least so an agent's own connection beats the team's,
// which beats the brokerage's, which beats the platform's. Vendors and contacts are leaf
// actors (in the app only for documents / transaction / listing / offer / education access),
// so they may connect ONLY social + calendar — never email/phone/CRM/financial/etc.
//
// Pure — no I/O — so cascade + gating are unit-tested. The live read lives in resolve-scoped.ts.

export type ConnectionScope = "platform" | "brokerage" | "team" | "agent" | "vendor" | "contact"

/** Connector domains a scope is permitted to own. Agent/team/brokerage/platform = anything;
 *  vendor + contact are restricted to social + calendar only (their limited app surface). */
export type ConnectorDomain =
  | "email" | "phone" | "calendar" | "social" | "crm" | "financial"
  | "listing" | "transaction" | "esign" | "showing" | "marketing"

const VENDOR_CONTACT_DOMAINS = new Set<ConnectorDomain>(["social", "calendar"])

/** Pure: may this owner scope connect a given connector domain? */
export function isConnectionAllowed(scope: ConnectionScope, domain: ConnectorDomain): boolean {
  if (scope === "vendor" || scope === "contact") return VENDOR_CONTACT_DOMAINS.has(domain)
  return true
}

export interface ScopeContext {
  agentUserId?: string | null
  teamId?: string | null
  brokerageId?: string | null
  vendorId?: string | null
  contactId?: string | null
}

export interface ScopeOwner {
  ownerType: ConnectionScope
  ownerId: string
}

/**
 * Pure: ordered owners to try for a connection, most-specific first. For an internal actor
 * (agent within a team/brokerage) the cascade is agent → team → brokerage → platform. For a
 * leaf actor (vendor/contact) it is just that actor → platform (they are not part of a
 * brokerage's credential cascade — they bring their own social/calendar only).
 */
export function scopeCascade(ctx: ScopeContext): ScopeOwner[] {
  const owners: ScopeOwner[] = []
  if (ctx.vendorId) {
    owners.push({ ownerType: "vendor", ownerId: ctx.vendorId })
  } else if (ctx.contactId) {
    owners.push({ ownerType: "contact", ownerId: ctx.contactId })
  } else {
    if (ctx.agentUserId) owners.push({ ownerType: "agent", ownerId: ctx.agentUserId })
    if (ctx.teamId) owners.push({ ownerType: "team", ownerId: ctx.teamId })
    if (ctx.brokerageId) owners.push({ ownerType: "brokerage", ownerId: ctx.brokerageId })
  }
  owners.push({ ownerType: "platform", ownerId: "platform" })
  return owners
}

/**
 * Pure: resolve the owner scope a Settings → connect action should WRITE, honoring the
 * user's REQUESTED scope. A manager may write either their own (agent) or the whole
 * brokerage; a non-manager is always forced to agent (their own), regardless of request.
 */
export function resolveConnectWriteScope(params: {
  requested: "agent" | "brokerage"
  isManager: boolean
  userId: string
  brokerageId: string
}): ScopeOwner {
  const ownerType: ConnectionScope =
    params.requested === "brokerage" && params.isManager ? "brokerage" : "agent"
  return { ownerType, ownerId: ownerType === "brokerage" ? params.brokerageId : params.userId }
}

/** The owner scope a connect action should WRITE for a given actor (the most specific
 *  non-platform owner). Vendor/contact write to themselves; an agent writes agent scope,
 *  a broker/admin writes brokerage scope. */
export function writeScopeFor(ctx: ScopeContext & { isBrokerageManager?: boolean }): ScopeOwner | null {
  if (ctx.vendorId) return { ownerType: "vendor", ownerId: ctx.vendorId }
  if (ctx.contactId) return { ownerType: "contact", ownerId: ctx.contactId }
  if (ctx.isBrokerageManager && ctx.brokerageId) return { ownerType: "brokerage", ownerId: ctx.brokerageId }
  if (ctx.agentUserId) return { ownerType: "agent", ownerId: ctx.agentUserId }
  if (ctx.brokerageId) return { ownerType: "brokerage", ownerId: ctx.brokerageId }
  return null
}
