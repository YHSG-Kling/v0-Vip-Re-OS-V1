/**
 * E-sign provider resolver — single source of truth for which provider
 * handles signature requests for a given user / team / brokerage.
 *
 * Resolution cascade (each agent's own settings win — e-sign is what the
 * USER uses, not just the brokerage):
 *   1. provider_overrides (scope='user', provider_type='esign', enabled)
 *   2. provider_overrides (scope='team', ...)
 *   3. provider_overrides (scope='brokerage', ...)
 *   4. platform_credentials (most recent active for user)
 *   5. platform_credentials (most recent active for brokerage)
 *
 * Throws when no provider is configured — admin must fix in Settings.
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
  accountId:    string | null
  credentialId: string
  provider:     ITransactionProvider
  resolvedScope: "user" | "team" | "brokerage"
}

export interface ResolveESignContext {
  brokerageId: string
  userId?:     string | null
  teamId?:     string | null
}

const SUPPORTED_PLATFORMS = ["dotloop", "docusign", "skyslope", "authentisign"]

async function readOverride(
  scope: "user" | "team" | "brokerage",
  scopeId: string,
): Promise<string | null> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("provider_overrides")
    .select("provider_key")
    .eq("provider_type", "esign")
    .eq("scope_type", scope)
    .eq("scope_id", scopeId)
    .eq("enabled", true)
    .maybeSingle()
  return (data?.provider_key as string | null) ?? null
}

async function readCredential(params: {
  scopeColumn: "agent_user_id" | "brokerage_id"
  scopeId: string
  preferredPlatform: string | null
}) {
  const svc = createServiceClient()
  const q = svc
    .from("platform_credentials")
    .select("id, platform, api_key, account_id, config")
    .eq(params.scopeColumn, params.scopeId)
    .eq("is_active", true)
    .in("platform", params.preferredPlatform ? [params.preferredPlatform] : SUPPORTED_PLATFORMS)
    .order("last_tested_at", { ascending: false, nullsFirst: false })
    .limit(1)
  const { data } = await q.maybeSingle()
  return data
}

export async function resolveESignProviderForActor(
  ctx: ResolveESignContext,
): Promise<ResolvedESignProvider> {
  if (!ctx.brokerageId) {
    throw new Error("brokerageId required to resolve e-sign provider")
  }

  // 1. User override → user credential
  if (ctx.userId) {
    const userPick = await readOverride("user", ctx.userId)
    const userCred = await readCredential({
      scopeColumn:       "agent_user_id",
      scopeId:           ctx.userId,
      preferredPlatform: userPick,
    })
    if (userCred && userCred.api_key) {
      return buildResolved(userCred, "user")
    }
  }

  // 2. Team / 3. Brokerage overrides
  let teamPick: string | null = null
  if (ctx.teamId) teamPick = await readOverride("team", ctx.teamId)
  const brokeragePick = await readOverride("brokerage", ctx.brokerageId)
  const preferredPlatform = teamPick ?? brokeragePick

  // 5. Brokerage credential (or matched against override)
  const brokCred = await readCredential({
    scopeColumn:       "brokerage_id",
    scopeId:           ctx.brokerageId,
    preferredPlatform,
  })
  if (!brokCred) {
    throw new Error(
      preferredPlatform
        ? `Selected '${preferredPlatform}' as e-sign provider but no active credentials are configured. Add credentials in Settings → Integrations.`
        : "No e-sign provider configured for this brokerage. Add credentials in Settings → Integrations.",
    )
  }
  if (!brokCred.api_key) {
    throw new Error(`E-sign provider '${brokCred.platform}' credentials are missing an API key. Re-authorize in Settings → Integrations.`)
  }
  return buildResolved(brokCred, teamPick ? "team" : "brokerage")
}

function buildResolved(
  cred: any,
  scope: "user" | "team" | "brokerage",
): ResolvedESignProvider {
  const cfg = (cred.config as Record<string, unknown> | null) ?? {}
  const profileId =
    (cfg.profile_id as string)
    ?? cred.account_id
    ?? ""
  // Optional per-provider base URI override (e.g. demo.docusign.net vs prod).
  const baseUri = (cfg.base_uri as string | undefined)
                ?? (cfg.baseUri as string | undefined)
                ?? undefined
  const provider = getTransactionProviderByName(cred.platform, {
    apiKey:    cred.api_key as string,
    profileId,
    baseUri,
  })
  return {
    providerName:  cred.platform as ResolvedESignProvider["providerName"],
    credentials:   { apiKey: cred.api_key as string, profileId },
    accountId:     cred.account_id as string | null,
    credentialId:  cred.id as string,
    provider,
    resolvedScope: scope,
  }
}

/** Backwards-compat wrapper for callers without userId/teamId. */
export async function resolveESignProviderForBrokerage(
  brokerageId: string,
): Promise<ResolvedESignProvider> {
  return resolveESignProviderForActor({ brokerageId })
}

