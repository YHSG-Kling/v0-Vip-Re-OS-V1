/**
 * Provider Resolver
 * 
 * Registry-based resolver for transaction providers.
 * Defaults to Dotloop if provider unknown or not configured.
 */

import type { ITransactionProvider, TransactionProvider } from "./transaction-provider.interface"
import { DotloopProvider } from "./dotloop-provider"
import { getTransactionProvider as getProviderName } from "@/lib/brokerage"

// ── Provider registry ────────────────────────────────────────────────────────
// Add new providers here. Factory returns an instance; throw means not-yet-implemented.

export type ProviderName = "dotloop" | "skyslope" | "formsimplicity" | "brokermint"

const PROVIDER_REGISTRY: Record<ProviderName, () => ITransactionProvider> = {
  dotloop:         () => new DotloopProvider(),
  skyslope:        () => { throw new Error("SkySlope provider not yet implemented") },
  formsimplicity:  () => { throw new Error("FormSimplicity provider not yet implemented") },
  brokermint:      () => { throw new Error("BrokerMint provider not yet implemented") },
}

/**
 * Resolve the correct provider based on brokerage configuration
 * Reads from System 7.2 — Brokerage Settings Resolver
 */
export async function getTransactionProvider(
  brokerageId: string
): Promise<TransactionProvider> {
  const providerName = await getProviderName(brokerageId)
  
  switch (providerName) {
    case "dotloop":
      return new DotloopProvider()
    case "skyslope":
      throw new Error("SkySlope provider not yet implemented")
    case "formsimplicity":
      throw new Error("FormSimplicity provider not yet implemented")
    case "brokermint":
      throw new Error("BrokerMint provider not yet implemented")
    default:
      throw new Error(`Unknown transaction provider: ${providerName}`)
  }
}

/**
 * Get transaction provider by name string.
 * Used by submitForSignature where the platform name comes from platform_credentials,
 * not from a brokerage settings lookup. Throws if provider is not configured.
 */
export function getTransactionProviderByName(providerName?: string): ITransactionProvider {
  if (!providerName || providerName === "not_configured") {
    throw new Error("No transaction provider configured. Set up a provider in Settings > Integrations.")
  }

  const normalizedName = providerName.toLowerCase() as ProviderName
  const factory = PROVIDER_REGISTRY[normalizedName]

  if (!factory) {
    throw new Error(`Unknown transaction provider: ${providerName}. Contact support.`)
  }

  return factory()
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
