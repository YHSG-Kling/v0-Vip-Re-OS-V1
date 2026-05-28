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
