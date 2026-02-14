/**
 * Provider Resolver
 * 
 * Registry-based resolver for transaction providers.
 * Defaults to Dotloop if provider unknown or not configured.
 */

import type { ITransactionProvider } from "./transaction-provider.interface"
import { DotloopProvider } from "./dotloop-provider"

type ProviderName = "dotloop" | "skyslope" | "formsimplicity" | "brokermint"

const PROVIDER_REGISTRY: Record<ProviderName, () => ITransactionProvider> = {
  dotloop: () => new DotloopProvider(),
  // Future providers (add as needed):
  // skyslope: () => new SkySlopeProvider(),
  // formsimplicity: () => new FormSimplicityProvider(),
  // brokermint: () => new BrokerMintProvider(),
  skyslope: () => new DotloopProvider(), // Fallback to Dotloop
  formsimplicity: () => new DotloopProvider(), // Fallback to Dotloop
  brokermint: () => new DotloopProvider(), // Fallback to Dotloop
}

/**
 * Get transaction provider by name
 * 
 * Defaults to Dotloop if provider not found
 */
export function getTransactionProvider(providerName?: string): ITransactionProvider {
  const normalizedName = (providerName?.toLowerCase() || "dotloop") as ProviderName

  const factory = PROVIDER_REGISTRY[normalizedName]

  if (!factory) {
    console.warn(`[v0] Unknown provider: ${providerName}, defaulting to Dotloop`)
    return new DotloopProvider()
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
