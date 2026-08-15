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
import { getCatalogEntry, getImplementedProviders, type ProviderName } from "./catalog"

/** Clear, catalog-aware error for a name that has no instantiable provider class. */
function unresolvableProviderError(providerName: string): Error {
  const entry = getCatalogEntry(providerName)
  if (entry && !entry.implemented) {
    const available = getImplementedProviders().map((p) => p.label).join(", ")
    return new Error(`${entry.label} is not yet available. Choose one of: ${available}.`)
  }
  return new Error(`Unknown transaction provider: ${providerName}. Contact support.`)
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
 * Resolve the correct provider based on brokerage configuration
 * Reads from System 7.2 — Brokerage Settings Resolver
 */
export async function getTransactionProvider(
  brokerageId: string
): Promise<ITransactionProvider> {
  const providerName = await getProviderName(brokerageId)
  const normalized   = String(providerName ?? "").toLowerCase() as ProviderName
  const factory      = PROVIDER_REGISTRY[normalized]
  if (!factory) {
    throw unresolvableProviderError(String(providerName ?? ""))
  }
  return factory()
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
    throw new Error("No transaction provider configured. Set up a provider in Settings > Integrations.")
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
