/**
 * E-sign provider resolver — single source of truth for which provider
 * handles signature requests for a given brokerage.
 *
 * Resolution order (highest precedence first):
 *   1. provider_overrides (scope=brokerage, provider_type='esign', enabled=true)
 *   2. platform_credentials (most recently active credential with platform IN
 *      [dotloop, docusign, skyslope, authentisign])
 *   3. SYSTEM_DEFAULTS.esign from lib/kernel/providers (currently 'dotloop')
 *
 * Throws when no provider is configured — callers MUST surface this to the
 * admin so they configure a provider before signature flows run.
 *
 * Returns the provider instance (ITransactionProvider) ready to call
 * createTransaction / sendForSignature / etc.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import type { ITransactionProvider } from "@/lib/integrations/providers/transaction-provider.interface"

export interface ResolvedESignProvider {
  providerName: "dotloop" | "docusign" | "skyslope" | "authentisign"
  credentials: {
    apiKey:     string
    profileId:  string
  }
  accountId:  string | null
  credentialId: string
  provider:   ITransactionProvider
}

const SUPPORTED_PLATFORMS = ["dotloop", "docusign", "skyslope", "authentisign"]

export async function resolveESignProviderForBrokerage(
  brokerageId: string,
): Promise<ResolvedESignProvider> {
  if (!brokerageId) {
    throw new Error("brokerageId required to resolve e-sign provider")
  }
  const svc = createServiceClient()

  // 1. provider_overrides — explicit per-brokerage selection
  const { data: override } = await svc
    .from("provider_overrides")
    .select("provider_key, config")
    .eq("provider_type", "esign")
    .eq("scope_type", "brokerage")
    .eq("scope_id", brokerageId)
    .eq("enabled", true)
    .maybeSingle()

  let providerName: string | null = (override?.provider_key as string | null) ?? null

  // 2. platform_credentials — pick the active credential matching the override
  //    or the most recently-tested active one if no override.
  let credentialsQuery = svc
    .from("platform_credentials")
    .select("id, platform, api_key, account_id, config")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .in("platform", SUPPORTED_PLATFORMS)
    .order("last_tested_at", { ascending: false, nullsFirst: false })
    .limit(1)
  if (providerName) {
    credentialsQuery = credentialsQuery.eq("platform", providerName)
  }
  const { data: cred } = await credentialsQuery.maybeSingle()

  if (!cred) {
    throw new Error(
      providerName
        ? `Brokerage selected '${providerName}' as e-sign provider but no active credentials are configured. Add credentials in Settings → Integrations.`
        : "No e-sign provider configured for this brokerage. Add credentials in Settings → Integrations.",
    )
  }

  providerName = providerName ?? cred.platform
  const profileId = (cred.config as Record<string, unknown> | null)?.profile_id as string
                    ?? cred.account_id
                    ?? ""

  if (!cred.api_key) {
    throw new Error(`E-sign provider '${providerName}' credentials are missing an API key. Re-authorize in Settings → Integrations.`)
  }

  const provider = getTransactionProviderByName(providerName ?? undefined, {
    apiKey:    cred.api_key as string,
    profileId,
  })

  return {
    providerName: providerName as ResolvedESignProvider["providerName"],
    credentials:  { apiKey: cred.api_key as string, profileId },
    accountId:    cred.account_id as string | null,
    credentialId: cred.id as string,
    provider,
  }
}
