// lib/connections/field-spec.ts
// PURE (no I/O) spec for how each connectable domain is authorized and, for API-key providers,
// exactly which fields the connect UI collects and how they map onto a platform_credentials row.
// This is the bridge between the per-tier UI (selectableConnectionsForScope) and the shapes the
// dispatch RESOLVERS already read — so a credential connected in the UI is immediately usable by
// dispatch with no per-provider glue scattered around. Unit-tested in the simulator.

import type { ConnectionScope, ConnectorDomain } from "./scope"

export type AuthMethod = "oauth" | "api_key"

export interface CredentialField {
  /** Form field key (also the value key callers pass back). */
  key: string
  label: string
  /** Rendered as a password input when true (tokens / secrets). */
  secret?: boolean
  required?: boolean
  placeholder?: string
}

/** How a domain is connected + (for api_key) the fields collected. OAuth domains start a redirect
 *  flow instead of collecting fields. */
export interface DomainAuthSpec {
  method: AuthMethod
  fields: CredentialField[]
  /** OAuth start path template; {provider} is replaced with the canonical provider id. */
  oauthStartPath?: string
}

/**
 * The platform_credentials write payload (column + config-key shape) for an API-key connection.
 * Mirrors what each domain's resolver reads:
 *   - phone (resolve-sms-provider): api_key=SID, config.auth_token, config.from_number
 *   - esign/transaction (resolve-esign / resolve-transaction): api_key, config.profile_id, config.base_uri?
 *   - listing/idx (idxbroker-client): api_key
 *   - financial/stripe: api_key (secret key)
 */
export interface PlatformCredentialWrite {
  api_key: string | null
  account_id: string | null
  config: Record<string, unknown>
}

export const DOMAIN_AUTH: Record<ConnectorDomain, DomainAuthSpec> = {
  email:    { method: "oauth", fields: [], oauthStartPath: "/api/integrations/oauth/{provider}" },
  calendar: { method: "oauth", fields: [], oauthStartPath: "/api/integrations/oauth/{provider}" },
  social:   { method: "oauth", fields: [], oauthStartPath: "/api/social/oauth/{provider}" },
  phone: {
    method: "api_key",
    fields: [
      { key: "accountSid", label: "Account SID", required: true },
      { key: "authToken",  label: "Auth Token",  required: true, secret: true },
      { key: "fromNumber", label: "From Number",  required: true, placeholder: "+15551234567" },
    ],
  },
  crm: {
    method: "api_key",
    fields: [
      { key: "apiKey",    label: "API Key",     required: true, secret: true },
      { key: "accountId", label: "Account / Location ID", required: false },
    ],
  },
  financial: {
    // Stripe = api_key (secret); QuickBooks is OAuth and handled by the integrations OAuth route.
    method: "api_key",
    fields: [{ key: "apiKey", label: "Secret Key", required: true, secret: true, placeholder: "sk_live_…" }],
  },
  listing: {
    method: "api_key",
    fields: [{ key: "apiKey", label: "API Key", required: true, secret: true }],
  },
  transaction: {
    method: "api_key",
    fields: [
      { key: "apiKey",    label: "API Key",    required: true, secret: true },
      { key: "profileId", label: "Profile / Account ID", required: false },
    ],
  },
  esign: {
    method: "api_key",
    fields: [
      { key: "apiKey",    label: "API Key",    required: true, secret: true },
      { key: "profileId", label: "Profile / Account ID", required: false },
    ],
  },
  showing: {
    method: "api_key",
    fields: [{ key: "apiKey", label: "API Key", required: true, secret: true }],
  },
  documents: { method: "api_key", fields: [] },
  marketing: { method: "api_key", fields: [] },
}

/** OAuth (QuickBooks) financial providers handled by the redirect flow rather than an api_key form. */
const FINANCIAL_OAUTH_PROVIDERS = new Set(["quickbooks"])

/** Pure: is this (domain, provider) connected via OAuth redirect rather than an API-key form? */
export function isOAuthConnection(domain: ConnectorDomain, canonicalProviderId: string): boolean {
  if (domain === "financial") return FINANCIAL_OAUTH_PROVIDERS.has(canonicalProviderId)
  return DOMAIN_AUTH[domain].method === "oauth"
}

/** Pure: the OAuth start path for an OAuth provider (email/calendar/social, or QuickBooks). */
export function oauthStartPath(domain: ConnectorDomain, canonicalProviderId: string): string | null {
  if (domain === "financial" && canonicalProviderId === "quickbooks") {
    return "/api/integrations/oauth/quickbooks"
  }
  const tmpl = DOMAIN_AUTH[domain].oauthStartPath
  return tmpl ? tmpl.replace("{provider}", canonicalProviderId) : null
}

/** Pure: collected form fields → the platform_credentials row shape each resolver reads. Returns
 *  null when a required field is missing (caller surfaces the error). */
export function buildCredentialWrite(
  domain: ConnectorDomain,
  fields: Record<string, string>,
): PlatformCredentialWrite | null {
  const trim = (k: string) => (fields[k] ?? "").trim()
  const has = (k: string) => trim(k).length > 0

  switch (domain) {
    case "phone":
      if (!has("accountSid") || !has("authToken") || !has("fromNumber")) return null
      return {
        api_key: trim("accountSid"),
        account_id: null,
        config: { auth_token: trim("authToken"), from_number: trim("fromNumber") },
      }
    case "crm":
      if (!has("apiKey")) return null
      return { api_key: trim("apiKey"), account_id: has("accountId") ? trim("accountId") : null, config: {} }
    case "financial":
    case "listing":
    case "showing":
      if (!has("apiKey")) return null
      return { api_key: trim("apiKey"), account_id: null, config: {} }
    case "transaction":
    case "esign":
      if (!has("apiKey")) return null
      return {
        api_key: trim("apiKey"),
        account_id: has("profileId") ? trim("profileId") : null,
        config: has("profileId") ? { profile_id: trim("profileId") } : {},
      }
    default:
      return null
  }
}

/** Actor capabilities that determine whether a connect FLOW is wired for the current scope. */
export interface ConnectCaps {
  /** We can persist an owner-scoped credential (owner id resolves). */
  canOwn: boolean
  /** The actor has an agents.id — required for personal email/calendar OAuth (agent_api_credentials). */
  hasAgentId: boolean
  /** The actor manages brokerage-level connections (broker/admin) — required for brokerage OAuth. */
  isBrokerageManager: boolean
  /** The actor has a brokerage anchor — platform_credentials.brokerage_id is NOT NULL, so an
   *  api-key write is impossible without it (e.g. a superadmin/platform actor with no brokerage). */
  hasBrokerage: boolean
}

/**
 * Pure: is the CONNECT flow for a (domain, provider) actually wired for an actor with these caps?
 * Keeps the UI honest — providers whose flow isn't available at this scope are shown disabled with
 * a reason instead of a button that silently no-ops. Mirrors where each flow stores tokens:
 *   - api_key  → owner-scoped platform_credentials (any actor that canOwn)
 *   - social   → social_media_accounts keyed by user_id (any authenticated user)
 *   - email/calendar OAuth → agent_api_credentials keyed by agentId (needs hasAgentId)
 *   - QuickBooks OAuth → brokerage-scoped callback (needs isBrokerageManager)
 */
export function isConnectSupported(
  domain: ConnectorDomain,
  canonicalProviderId: string,
  caps: ConnectCaps,
): { available: boolean; reason?: string } {
  if (!caps.canOwn) return { available: false, reason: "Not available for your account type." }
  if (!isOAuthConnection(domain, canonicalProviderId)) {
    // api_key → owner-scoped platform_credentials write, which requires a brokerage anchor
    // (brokerage_id is NOT NULL). A platform/superadmin actor without a brokerage can't store it here.
    return caps.hasBrokerage ? { available: true } : { available: false, reason: "Requires a brokerage to store this connection." }
  }
  if (domain === "social") return { available: true } // stored by user_id — any signed-in user
  if (domain === "financial" && canonicalProviderId === "quickbooks") {
    return caps.isBrokerageManager ? { available: true } : { available: false, reason: "Connect QuickBooks at the brokerage level." }
  }
  // email / calendar OAuth → personal mailbox tokens (agent_api_credentials).
  return caps.hasAgentId ? { available: true } : { available: false, reason: "Available soon for your account type." }
}

/** Pure: map an app userType to its connection ownership scope + whether it manages brokerage-level
 *  connections. Vendors/contacts are leaf actors; brokers/admins manage the brokerage; team leads own
 *  team-level; superadmin owns platform defaults; everyone else (agent/tc/isa) is agent-scoped. */
export function connectionScopeForUserType(
  userType: string,
): { scope: ConnectionScope; isBrokerageManager: boolean } {
  const t = (userType ?? "").toLowerCase()
  if (t === "vendor") return { scope: "vendor", isBrokerageManager: false }
  if (t === "contact") return { scope: "contact", isBrokerageManager: false }
  if (t === "superadmin") return { scope: "platform", isBrokerageManager: false }
  if (["broker", "broker_owner", "admin"].includes(t)) return { scope: "brokerage", isBrokerageManager: true }
  if (["team_lead", "team_leader"].includes(t)) return { scope: "team", isBrokerageManager: false }
  return { scope: "agent", isBrokerageManager: false }
}
