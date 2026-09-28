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
 * Throws when no API provider is configured. Lane 88B: the throw names the DEFAULT — Google
 * eSignature, a portal-send provider (catalog DEFAULT_ESIGN_PROVIDER) — and where to send from,
 * never "connect Dotloop"; an explicit Google selection is refused the same honest way.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { DEFAULT_ESIGN_PROVIDER, getCatalogEntry, providerPortalMode } from "@/lib/integrations/providers/catalog"
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

export async function resolveESignProviderForActor(
  ctx: ResolveESignContext,
): Promise<ResolvedESignProvider> {
  if (!ctx.brokerageId) {
    throw new Error("brokerageId required to resolve e-sign provider")
  }

  // Provider SELECTION via provider_overrides (most-specific scope first). The CREDENTIAL read
  // goes through the unified ownership cascade (resolveScopedConnection: agent → team →
  // brokerage → platform, legacy fallback preserved), so per-tier scoping — including TEAM,
  // which the old per-column read skipped — resolves in one place.
  const userPick      = ctx.userId ? await readOverride("user", ctx.userId)           : null
  const teamPick      = ctx.teamId ? await readOverride("team", ctx.teamId)           : null
  const brokeragePick = await readOverride("brokerage", ctx.brokerageId)
  const preferredPlatform = userPick ?? teamPick ?? brokeragePick ?? null

  // Lane 88B (owner, wave 88: "google esign is default not dotloop."). This resolver answers "which
  // CONNECTED API provider, with what credential". A portal-send selection (Google eSignature — the
  // catalog DEFAULT) has neither, so it is refused here with WHERE to send from, not searched for
  // a credential that cannot exist.
  if (preferredPlatform && getCatalogEntry(preferredPlatform)?.portalSend) {
    throw new Error(portalSendMessage(preferredPlatform))
  }

  const scopeCtx = { agentUserId: ctx.userId ?? null, teamId: ctx.teamId ?? null, brokerageId: ctx.brokerageId }
  const ownerToScope = (o: string): "user" | "team" | "brokerage" =>
    o === "agent" ? "user" : o === "team" ? "team" : "brokerage"

  const providersToTry = preferredPlatform ? [preferredPlatform] : SUPPORTED_PLATFORMS
  for (const provider of providersToTry) {
    const conn = await resolveScopedConnection(provider, scopeCtx)
    if (conn && conn.apiKey && SUPPORTED_PLATFORMS.includes(conn.provider)) {
      return buildResolved(
        { id: conn.credentialId, platform: conn.provider, api_key: conn.apiKey, account_id: conn.accountId, config: conn.config },
        ownerToScope(conn.ownerType),
      )
    }
  }

  throw new Error(
    preferredPlatform
      ? `Selected '${preferredPlatform}' as e-sign provider but no active credentials are configured. Add credentials in Settings → Integrations.`
      // Lane 88B — nothing selected and nothing connected = the DEFAULT (Google eSignature), which
      // is sent from the agent's own Google Drive; the old copy told them to connect Dotloop & co.
      : portalSendMessage(DEFAULT_ESIGN_PROVIDER),
  )
}

/** Lane 88B — the honest "send it from the provider's own window" sentence for a portal-send
 *  provider (Google eSignature): nothing was sent, and this says where the agent sends from. */
function portalSendMessage(providerName: string): string {
  const portal = providerPortalMode(providerName)
  const label = portal?.label ?? providerName
  return `E-sign is set to ${label} (the default), which sends from your own ${label} window — open ${portal?.url ?? label}, open the filled document, then Tools → eSignature → Request signature. To auto-send from here instead, connect DocuSign, Dotloop or another provider in Settings → Integrations.`
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

// TOMBSTONE (orphan tranche 4): resolveESignProviderForBrokerage deleted. It was
// a pure delegation to the survivor resolveESignProviderForActor({ brokerageId })
// above — the live cascade with callers across buyer-broker agreements,
// commission acknowledgement, the assistant tool rail and the e-sign webhooks.
// A brokerage-only caller passes { brokerageId } to the actor resolver directly.

