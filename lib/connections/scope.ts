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

import { getTransactionFormProviders, getEsignProviders } from "@/lib/integrations/providers/catalog"

export type ConnectionScope = "platform" | "brokerage" | "team" | "agent" | "vendor" | "contact"

/** Connector domains a scope is permitted to own. Agent/team/brokerage/platform = anything;
 *  vendor + contact are restricted to calendar + social + financial only (their limited app
 *  surface — they bring their own scheduling, social presence, and payout/accounting). */
export type ConnectorDomain =
  | "email" | "phone" | "calendar" | "social" | "crm" | "financial"
  | "listing" | "transaction" | "esign" | "showing" | "documents" | "marketing" | "podcast"
  | "meetings"

const VENDOR_CONTACT_DOMAINS = new Set<ConnectorDomain>(["email", "calendar", "social", "financial"])

/**
 * SINGLE source of truth for which providers a domain may be connected to. Values are the
 * canonical provider ids from lib/integrations/connection-manager.ts (callers normalize UI
 * input via canonicalProvider() before gating). An empty list = the domain is a known surface
 * but has no user-selectable provider yet (NOT a stub — nothing is offered until an adapter
 * exists). The UI selector, write-side gating, and dispatch resolvers all read from here so the
 * allow-lists never drift apart again.
 *
 * CRM is SYNC-OUT ONLY (we push contact updates outward; we never pull a CRM's contacts in).
 */
export const CONNECTOR_PROVIDERS: Record<ConnectorDomain, readonly string[]> = {
  email:       ["gmail", "outlook"],
  phone:       ["twilio", "telnyx", "bandwidth"],
  calendar:    ["gmail", "outlook"],
  social:      ["meta", "linkedin", "twitter", "tiktok", "youtube", "pinterest", "google_business"], // meta = Facebook+Instagram (matches the social OAuth route's platform keys)
  crm:         ["gohighlevel", "followupboss", "lofty", "hubspot"], // all sync-out only
  financial:   ["quickbooks", "stripe"],
  // transaction + esign are DERIVED from the provider catalog (the single source of truth) so the
  // selectable lists can never drift from what's actually implemented (transaction = every
  // implemented transaction-forms provider; esign = every implemented e-sign provider).
  transaction: getTransactionFormProviders(),
  esign:       getEsignProviders(),
  // IDX Broker is per-tier connectable (agent/team/brokerage/platform). RentCast is platform-only
  // (env/platform config) and is intentionally NOT a user connection.
  listing:     ["idxbroker"],
  showing:     ["showingtime"],
  // Podcast distributor (host-agnostic via an API-first host). Transistor publishes one episode and
  // syndicates to Spotify/Apple/etc through its managed RSS — so one per-tier connection covers all
  // channels. Owner-cascade: agent → team → brokerage → platform.
  podcast:     ["transistor"],
  // Video meetings (round 39). Owner-scoped OAuth like QuickBooks — each level
  // connects its OWN Zoom; per-scope offering + storage keys live in
  // lib/connections/zoom.ts (vendor/contact are excluded: they join meetings,
  // they never host them — see VENDOR_CONTACT_DOMAINS above).
  meetings:    ["zoom"],
  documents:   [], // surface reserved; no user-selectable document provider yet
  marketing:   [], // system-managed; not a user-selectable connection
}

/**
 * BUILT BUT NOT OFFERED — the parking bay, so a provider is never "lost".
 *
 * These vendors have REAL code in the repo (OAuth configs, API clients, publish
 * paths) but are deliberately absent from CONNECTOR_PROVIDERS above, so nothing
 * offers them and nothing pretends they work. They live here — in the same file
 * as the decision they are waiting on — rather than in a second allow-list,
 * because a parallel list is exactly how the provider surface drifted before:
 * a vendor got added to a CHECK constraint to make one call site stop failing,
 * and the Connection OS never heard about it.
 *
 * This is the ONLY place to look when a customer asks "can you add X?", and the
 * only place to change to say yes. Turning one on is: move it into
 * CONNECTOR_PROVIDERS under its domain (creating the domain if needed), add a
 * DOMAIN_AUTH entry in lib/connections/field-spec.ts, add a row to
 * lib/providers/tenancy-matrix.ts saying who owns the account, and — for
 * anything stored owner-scoped — admit the key in the platform_credentials
 * CHECK. Nothing else in the app needs to change, because every selector and
 * every write-side gate derives from CONNECTOR_PROVIDERS.
 */
export interface CandidateProvider {
  /** Canonical provider id, as it would appear in CONNECTOR_PROVIDERS. */
  provider: string
  /** The domain it would join (may not exist yet — see `blockedBy`). */
  domain: ConnectorDomain | "cms" | "ads" | "financial"
  /** What already exists, so nobody re-builds it. */
  built: string
  /** What is genuinely missing before it can be offered. */
  blockedBy: string
}

export const CANDIDATE_PROVIDERS: readonly CandidateProvider[] = [
  {
    provider: "xero",
    domain: "financial",
    built:
      "Full OAuth config in app/api/integrations/oauth/[provider]/route.ts (authorize + token URLs, scopes) and an accounting-sync surface that reads a xero connection from integration_credentials.",
    blockedBy:
      "Not in CONNECTOR_PROVIDERS.financial and not an admitted platform_credentials.platform value, so the owner-scoped half of the connection cannot be stored. QuickBooks is the offered accounting provider today.",
  },
  {
    provider: "google_ads",
    domain: "ads",
    built:
      "OAuth config in the same route (stored under the 'google' key) plus ad-campaign plumbing that already understands a google platform.",
    blockedBy:
      "There is no `ads` connector domain at all — ad platforms are currently system-managed, and lib/integrations/ad-campaign-vocabulary.ts lists google under AD_PLATFORMS_WITHOUT_CONNECTIONS precisely because nothing offers the connection.",
  },
  {
    provider: "wordpress",
    domain: "cms",
    built:
      "A complete REST publish path (app/actions/blog.ts publishToWordPress: renders the post, injects the view-tracker and share block, sets rel=canonical for the 'both' target) plus the blog_posts.publish_target ladder and a Publish-to-WordPress button.",
    blockedBy:
      "No `cms` domain, no field spec for its credential shape (site URL + application password), and 'wordpress' is not an admitted platform_credentials.platform value. See lib/blog/wordpress-connection.ts, which answers honestly instead of running a query that cannot match.",
  },
] as const

/** Pure: is this provider a known candidate rather than an unknown name? Lets a
 *  UI answer "we support that, it just isn't switched on" instead of "no". */
export function candidateProvider(providerId: string): CandidateProvider | null {
  return CANDIDATE_PROVIDERS.find((c) => c.provider === providerId) ?? null
}

/** Pure: may this owner scope connect a given connector domain? Vendor/contact are leaf actors
 *  limited to calendar + social + financial; everyone else may connect any domain that has at
 *  least one selectable provider. */
export function isConnectionAllowed(scope: ConnectionScope, domain: ConnectorDomain): boolean {
  if (CONNECTOR_PROVIDERS[domain].length === 0) return false
  if (scope === "vendor" || scope === "contact") return VENDOR_CONTACT_DOMAINS.has(domain)
  return true
}

/** Pure: may this owner scope connect this domain to this (already-canonical) provider? */
export function isProviderAllowedForScope(
  scope: ConnectionScope,
  domain: ConnectorDomain,
  canonicalProviderId: string,
): boolean {
  return isConnectionAllowed(scope, domain) && CONNECTOR_PROVIDERS[domain].includes(canonicalProviderId)
}

/** Pure: the connectable domains for an actor scope (those allowed AND with a provider). Drives
 *  the per-tier connection UI — a solo agent/team/brokerage sees the full set; a vendor/contact
 *  sees only calendar/social/financial. */
export function domainsForScope(scope: ConnectionScope): ConnectorDomain[] {
  return (Object.keys(CONNECTOR_PROVIDERS) as ConnectorDomain[]).filter((d) => isConnectionAllowed(scope, d))
}

/** Pure: the full {domain → selectable providers} map for an actor scope (UI source of truth). */
export function selectableConnectionsForScope(scope: ConnectionScope): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const d of domainsForScope(scope)) out[d] = CONNECTOR_PROVIDERS[d]
  return out
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
