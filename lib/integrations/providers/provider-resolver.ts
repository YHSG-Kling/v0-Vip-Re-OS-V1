/**
 * Provider Resolver
 *
 * Registry-based resolver for transaction / e-sign providers. Each provider
 * has a factory that constructs a real ITransactionProvider with whatever
 * credentials the caller has resolved from platform_credentials.
 *
 * Adding a new provider = drop a class in /providers, add a row here.
 */

import type { ITransactionProvider } from "./transaction-provider.interface"
import { DotloopProvider }        from "./dotloop-provider"
import { DocusignProvider }       from "./docusign-provider"
import { SkyslopeProvider }       from "./skyslope-provider"
import { AuthentisignProvider }   from "./authentisign-provider"
import { BrokermintProvider }     from "./brokermint-provider"
import { FormSimplicityProvider } from "./formsimplicity-provider"
import { getTransactionProvider as getProviderName } from "@/lib/brokerage"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { getCatalogEntry, getImplementedProviders, type ProviderName } from "./catalog"

/** Clear, catalog-aware error for a name that has no instantiable provider class. */
function unresolvableProviderError(providerName: string): Error {
  const entry = getCatalogEntry(providerName)
  // Lane 88B — a portal-send provider (Google eSignature, the default) has no API to dispatch
  // through: say so, and where the agent sends from, instead of "not yet available".
  if (entry?.portalSend) {
    return new Error(`${entry.label} sends from ${entry.label}'s own window (no send API) — open it, request signatures on the filled document, and the signed copy syncs back when uploaded.`)
  }
  if (entry && !entry.implemented) {
    const available = getImplementedProviders().map((p) => p.label).join(", ")
    return new Error(`${entry.label} is not yet available. Choose one of: ${available}.`)
  }
  return new Error(`Unknown legal-forms provider: ${providerName}. Contact support.`)
}

// ── Provider registry ────────────────────────────────────────────────────────
// Every provider supported by resolveESignProviderForActor MUST appear here.
// Brokerages choose one in Settings → Integrations; we instantiate from
// platform_credentials at dispatch time.

// ProviderName is the unified catalog type (6 providers). The registry only
// contains entries for providers with a working class; resolution throws a
// catalog-aware error for any known-but-unregistered name.
export type { ProviderName }

type ProviderCredentials = { apiKey: string; profileId: string; baseUri?: string }

const PROVIDER_REGISTRY: Partial<Record<ProviderName, (creds?: ProviderCredentials) => ITransactionProvider>> = {
  dotloop:        (creds) => new DotloopProvider(creds),
  docusign:       (creds) => new DocusignProvider(creds as ProviderCredentials),
  skyslope:       (creds) => new SkyslopeProvider(creds as ProviderCredentials),
  authentisign:   (creds) => new AuthentisignProvider(creds as ProviderCredentials),
  brokermint:     (creds) => new BrokermintProvider(creds as ProviderCredentials),
  formsimplicity: (creds) => new FormSimplicityProvider(creds as ProviderCredentials),
}

/**
 * THE TENANT'S OWN CREDENTIAL FOR A TRANSACTION / E-SIGN PROVIDER (wave 141, lane 141C; owner:
 * "Transaction-provider credentials are the TENANT's; no shared cross-tenant credentials").
 * Walks the ownership cascade (agent → team → brokerage) through the ONE resolver and REFUSES the
 * platform tier by name: a platform-owned Dotloop / SkySlope / … row is one account carrying every
 * tenant's transactions, which is the shape the owner forbids. (The e-sign DEFAULT's platform
 * DocuSign account is a different door — lib/integrations/resolve-esign-provider.ts, isDefault only.)
 * Returns the credential shape the provider classes take, or a reason — never throws.
 */
export async function resolveTenantProviderCredentials(
  provider: string,
  ctx: { brokerageId: string; agentUserId?: string | null; teamId?: string | null },
): Promise<{ ok: true; credentials: ProviderCredentials; credentialId: string; ownerType: string } | { ok: false; reason: string }> {
  const label = getCatalogEntry(provider)?.label ?? provider
  if (!ctx.brokerageId) return { ok: false, reason: `${label}: no brokerage to resolve a credential for` }
  const conn = await resolveScopedConnection(provider, { brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId ?? null, teamId: ctx.teamId ?? null })
  if (!conn) return { ok: false, reason: `${label} is selected but not connected for this brokerage (or its tier could not be read) — connect it in Settings → Integrations.` }
  if (conn.ownerType === "platform") {
    return { ok: false, reason: `${label} resolved only to a PLATFORM-owned credential — transaction-provider credentials are the tenant's own; connect ${label} for this brokerage in Settings → Integrations.` }
  }
  const cfg = (conn.config ?? {}) as Record<string, unknown>
  const apiKey = conn.apiKey ?? conn.accessToken ?? null
  const profileId = (typeof cfg.profile_id === "string" && cfg.profile_id) || conn.accountId || ""
  if (!apiKey) return { ok: false, reason: `${label} is connected for this brokerage but carries no token — reconnect it in Settings → Integrations.` }
  const baseUri = (typeof cfg.base_uri === "string" && cfg.base_uri) || (typeof cfg.baseUri === "string" && cfg.baseUri) || undefined
  return { ok: true, credentials: { apiKey, profileId, ...(baseUri ? { baseUri } : {}) }, credentialId: conn.credentialId, ownerType: conn.ownerType }
}

/**
 * THE TRANSACTION PROVIDER SELECTED FOR A BROKERAGE — the name only (wave 141, lane 141C).
 * ONE order, like the e-sign selection (lib/integrations/resolve-esign-provider.ts readSelection):
 *   1. the tenant's TRANSACTION selection in provider_overrides (the per-capability settings store
 *      the owner named: "TRANSACTION/FORMS provider · E-SIGN provider · …") at the brokerage tier
 *      (sessionless callers — the portal document sync — have no user to read a user tier for);
 *   2. else the brokerage settings' transaction_provider (the older explicit setting, kept as a
 *      fallback rather than migrated blind);
 *   3. else NONE. The kernel cascade's system default for `transaction` is NOT consulted here: a
 *      tenant that selected nothing has no transaction provider — never a silent Dotloop.
 */
async function resolveTransactionProviderSelection(brokerageId: string): Promise<{ provider: string | null; source: "provider_overrides" | "brokerage_settings" | "none" }> {
  try {
    const { resolveTenantProvider } = await import("@/lib/kernel/tenant-config-reads")
    const r = await resolveTenantProvider({ providerType: "transaction", actorContext: { userId: "", brokerageId } })
    if (r.providerKey && r.providerKey !== "none" && (r.scope === "brokerage" || r.scope === "team" || r.scope === "user")) {
      return { provider: r.providerKey.toLowerCase(), source: "provider_overrides" }
    }
  } catch (e) {
    console.error(`[provider-resolver] transaction selection read failed for ${brokerageId}: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    const legacy = await getProviderName(brokerageId)
    if (legacy) return { provider: String(legacy).toLowerCase(), source: "brokerage_settings" }
  } catch { /* no legacy setting — fall through to none */ }
  return { provider: null, source: "none" }
}

/**
 * Resolve the correct provider based on brokerage configuration, INSTANTIATED WITH THE TENANT'S
 * OWN CREDENTIAL. Before wave 141 this called `factory()` with no credentials at all: every class
 * but Dotloop threw "api_key required" (so the portal document sync failed for every SkySlope /
 * Brokermint / Form Simplicity / DocuSign / Authentisign tenant — reported as "provider sync
 * threw"), and Dotloop fell back to the shared DOTLOOP_API_KEY env account — one Dotloop
 * profile serving every tenant's loops. Both halves are closed here: the selection comes from the
 * tenant's settings (resolveTransactionProviderSelection) and the credential from the tenant's
 * own tier (resolveTenantProviderCredentials); a missing credential is a named refusal.
 */
export async function getTransactionProvider(
  brokerageId: string
): Promise<ITransactionProvider> {
  const selection = await resolveTransactionProviderSelection(brokerageId)
  if (!selection.provider) {
    throw new Error("No legal-forms provider is selected for this brokerage. Choose one in Settings → Integrations (Provider Routing → TRANSACTION).")
  }
  const normalized = selection.provider as ProviderName
  const factory    = PROVIDER_REGISTRY[normalized]
  if (!factory) {
    throw unresolvableProviderError(selection.provider)
  }
  const cred = await resolveTenantProviderCredentials(normalized, { brokerageId })
  if (!cred.ok) throw new Error(cred.reason)
  return factory(cred.credentials)
}

/**
 * Get transaction provider by name string.
 * Used by submitForSignature where the platform name comes from platform_credentials,
 * not from a brokerage settings lookup. Throws if provider is not configured.
 */
export function getTransactionProviderByName(
  providerName?: string,
  credentials?: ProviderCredentials
): ITransactionProvider {
  if (!providerName || providerName === "not_configured") {
    throw new Error("No legal-forms provider configured. Set up a provider in Settings > Integrations.")
  }

  const normalizedName = providerName.toLowerCase() as ProviderName
  const factory = PROVIDER_REGISTRY[normalizedName]

  if (!factory) {
    throw unresolvableProviderError(providerName)
  }

  return factory(credentials)
}

/**
 * Get available providers
 */
export function getAvailableProviders(): ProviderName[] {
  return Object.keys(PROVIDER_REGISTRY) as ProviderName[]
}

/**
 * Check if provider is supported
 */
export function isProviderSupported(providerName: string): boolean {
  return providerName.toLowerCase() in PROVIDER_REGISTRY
}
