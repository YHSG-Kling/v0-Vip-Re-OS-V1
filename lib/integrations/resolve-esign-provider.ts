/**
 * E-sign provider resolver — single source of truth for which provider
 * handles signature requests for a given user / team / brokerage.
 *
 * THE RULE (lane 89A, owner wave 89: "brokerage uses their own transaction and esign provider. the
 * platforms defualt esign is no longer google but we decided on docusign instead since it will
 * embed in our platform window."):
 *   WHICH provider = the e-sign SELECTION (provider_overrides `esign`, user → team → brokerage),
 *                    else the catalog DEFAULT_ESIGN_PROVIDER (DocuSign).
 *   WHOSE credential = that ONE provider's connection through the ownership cascade
 *                    (platform_credentials agent → team → brokerage → platform); for the DEFAULT
 *                    only, the platform's own DocuSign account (lib/esign/docusign-platform-account.ts)
 *                    is the last rung, so a tenant that connected nothing still sends.
 *
 * WHAT WAS FIXED: with no selection this resolver used to iterate EVERY supported vendor and return
 * whichever credential was connected first (Dotloop before DocuSign) — "whatever TM is connected"
 * chose the signer, which is the defect lane 88B2 removed from the workflow step and which lived on
 * here for the FormWizard, the assistant tool, the BBA and commission-disclosure sends. Now a
 * different vendor never stands in: a selected provider that is not connected is refused BY NAME.
 *
 * `provider` on the context is the one exception — the webhook downloader knows which vendor SENT
 * the envelope it is syncing and must reach that vendor's client, whatever the tenant selects today.
 *
 * Throws (a value-returning sibling, resolveESignChoice, is below). A portal-send selection (Google
 * eSignature) has no credential and is refused with WHERE to send from.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { DEFAULT_ESIGN_PROVIDER, getCatalogEntry, getEsignProviders, providerPortalMode } from "@/lib/integrations/providers/catalog"
import type { ITransactionProvider } from "@/lib/integrations/providers/transaction-provider.interface"

export interface ResolvedESignProvider {
  providerName: "dotloop" | "docusign" | "skyslope" | "authentisign" | "formsimplicity"
  credentials: {
    apiKey:     string
    profileId:  string
  }
  accountId:    string | null
  credentialId: string
  provider:     ITransactionProvider
  /** Whose credential carries the envelope. "platform" = the platform's own DocuSign account
   *  (the default with nothing connected); "default" is never a scope — a default still resolves
   *  to a credential at one of these tiers. */
  resolvedScope: "user" | "team" | "brokerage" | "platform"
  /** true when the provider is the platform DEFAULT rather than a tenant selection. */
  isDefault: boolean
}

export interface ResolveESignContext {
  brokerageId: string
  userId?:     string | null
  teamId?:     string | null
  /** The vendor that SENT an envelope being synced back (webhooks) — bypasses the selection. */
  provider?:   string | null
}

/** The e-sign providers with a sending class — derived from the catalog, never a hand list. */
const SUPPORTED_PLATFORMS: string[] = getEsignProviders()

async function readOverride(
  scope: "user" | "team" | "brokerage",
  scopeId: string,
): Promise<string | null> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("provider_overrides")
    .select("provider_key")
    .eq("provider_type", "esign")
    .eq("scope_type", scope)
    .eq("scope_id", scopeId)
    .eq("enabled", true)
    .maybeSingle()
  // A refused read is NOT "no override" — say so (the cascade then continues, but the
  // loss of the agent's explicit pick is visible rather than silent).
  if (error) console.error(`[resolve-esign-provider] ${scope} e-sign override read refused: ${error.message}`)
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
  const selection = await readSelection(ctx)
  const providerName = (ctx.provider?.toLowerCase() || selection.pick || DEFAULT_ESIGN_PROVIDER)
  const isDefault = !ctx.provider && !selection.pick

  // A portal-send selection (Google eSignature) has no credential and no send API: it is refused
  // here with WHERE to send from, not searched for a credential that cannot exist.
  if (getCatalogEntry(providerName)?.portalSend) {
    throw new Error(portalSendMessage(providerName, isDefault))
  }
  if (!SUPPORTED_PLATFORMS.includes(providerName)) {
    const label = getCatalogEntry(providerName)?.label ?? providerName
    throw new Error(`E-sign is set to '${label}', which cannot send for signature. Choose DocuSign, Dotloop, SkySlope, Authentisign, Form Simplicity or Google eSignature in Settings → Integrations.`)
  }

  const scopeCtx = { agentUserId: ctx.userId ?? null, teamId: ctx.teamId ?? null, brokerageId: ctx.brokerageId }
  const ownerToScope = (o: string): ResolvedESignProvider["resolvedScope"] =>
    o === "agent" ? "user" : o === "team" ? "team" : o === "platform" ? "platform" : "brokerage"

  // ONE provider, the tenant's own credential first (agent → team → brokerage → platform tier).
  const conn = await resolveScopedConnection(providerName, scopeCtx)
  if (conn && conn.apiKey && conn.provider === providerName) {
    return buildResolved(
      { id: conn.credentialId, platform: conn.provider, api_key: conn.apiKey, account_id: conn.accountId, config: conn.config },
      ownerToScope(conn.ownerType),
      isDefault,
    )
  }

  // The DEFAULT with nothing connected: the platform's own DocuSign account carries the envelope
  // (lane 89A). Only for the default — a tenant that SELECTED a vendor gets that vendor or a refusal.
  if (isDefault && providerName === DEFAULT_ESIGN_PROVIDER && providerName === "docusign") {
    const { resolvePlatformDocusignCredential } = await import("@/lib/esign/docusign-platform-account")
    const platform = await resolvePlatformDocusignCredential()
    if (platform.ok) {
      return buildResolved(
        { id: "platform-docusign", platform: "docusign", api_key: platform.credential.apiKey, account_id: platform.credential.profileId, config: { base_uri: platform.credential.baseUri } },
        "platform",
        true,
      )
    }
    throw new Error(`${platform.error} Connect your own DocuSign, Dotloop, SkySlope or Authentisign — or select Google eSignature — in Settings → Integrations.`)
  }

  const label = getCatalogEntry(providerName)?.label ?? providerName
  throw new Error(
    isDefault
      ? `E-sign defaults to ${label}, but no ${label} connection was found for you, your team or your brokerage. Connect ${label} (or another e-sign provider) in Settings → Integrations.`
      : `E-sign is set to ${label}${selection.scope ? ` (${selection.scope} setting)` : ""}, but no active ${label} connection was found for you, your team or your brokerage. Connect it in Settings → Integrations, or change the e-sign selection.`,
  )
}

/** The e-sign SELECTION (provider_overrides `esign`), most-specific scope first. */
async function readSelection(ctx: ResolveESignContext): Promise<{ pick: string | null; scope: "user" | "team" | "brokerage" | null }> {
  const userPick      = ctx.userId ? await readOverride("user", ctx.userId) : null
  if (userPick) return { pick: userPick.toLowerCase(), scope: "user" }
  const teamPick      = ctx.teamId ? await readOverride("team", ctx.teamId) : null
  if (teamPick) return { pick: teamPick.toLowerCase(), scope: "team" }
  const brokeragePick = await readOverride("brokerage", ctx.brokerageId)
  if (brokeragePick) return { pick: brokeragePick.toLowerCase(), scope: "brokerage" }
  return { pick: null, scope: null }
}

/** The honest "send it from the provider's own window" sentence for a portal-send provider
 *  (Google eSignature): nothing was sent, and this says where the agent sends from. */
function portalSendMessage(providerName: string, isDefault = false): string {
  const portal = providerPortalMode(providerName)
  const label = portal?.label ?? providerName
  return `E-sign is set to ${label}${isDefault ? " (the default)" : ""}, which sends from your own ${label} window — open ${portal?.url ?? label}, open the filled document, then Tools → eSignature → Request signature. To send from inside the platform instead, select DocuSign (the default) or connect Dotloop, SkySlope or Authentisign in Settings → Integrations.`
}

// ─── THE E-SIGN CHOICE FOR A SEND (lane 88C; re-anchored to the DocuSign default, lane 89A) ──
//
// resolveESignProviderForActor above answers "which provider, with what credential" and
// REFUSES a portal-send selection with where to send from. A SEND (FormWizard offer + listing,
// the transaction page's per-document send — all through lib/esign/dispatch-packet.ts) needs one
// more answer: when the choice is Google eSignature, do the filled forms go into the agent's
// Drive for them (lane 88C's hand-off, lib/esign/google-esign-handoff.ts), or does the agent
// upload them by hand? ONE order, the resolver's (§6):
//   1. the e-sign SELECTION (user → team → brokerage) — google_esign is the Google choice; any
//      other selection resolves to ITS credential or a named refusal;
//   2. no selection → the DEFAULT (DocuSign): the tenant's own DocuSign connection, else the
//      platform's DocuSign account. A refusal is a refusal — never a silent other vendor and
//      never a silent Google fallback (Google is a CHOICE now, not the default).

export type ESignChoice =
  | { ok: true; kind: "google"; providerName: "google_esign"; resolvedScope: "user" | "team" | "brokerage" | "default"; connected: boolean; driveGranted: boolean | null; manualSteps: string }
  | { ok: true; kind: "api"; providerName: ResolvedESignProvider["providerName"]; resolved: ResolvedESignProvider }
  | { ok: false; error: string }

export async function resolveESignChoice(ctx: ResolveESignContext): Promise<ESignChoice> {
  if (!ctx.brokerageId) return { ok: false, error: "brokerageId required to resolve e-sign provider" }
  const selection = await readSelection(ctx)
  const pick = selection.pick
  const pickScope: "user" | "team" | "brokerage" | "default" = selection.scope ?? "default"

  const google = async (scope: "user" | "team" | "brokerage" | "default"): Promise<ESignChoice> => {
    const { googleEsignReadiness } = await import("@/lib/esign/google-esign-handoff")
    const g = ctx.userId ? await googleEsignReadiness(ctx.userId) : { connected: false, driveGranted: null }
    return { ok: true, kind: "google", providerName: "google_esign", resolvedScope: scope, connected: g.connected, driveGranted: g.driveGranted, manualSteps: portalSendMessage("google_esign", scope === "default") }
  }

  const chosen = pick ?? DEFAULT_ESIGN_PROVIDER
  if (getCatalogEntry(chosen)?.portalSend) return google(pickScope)
  try {
    const resolved = await resolveESignProviderForActor(ctx)
    return { ok: true, kind: "api", providerName: resolved.providerName, resolved }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildResolved(
  cred: any,
  scope: ResolvedESignProvider["resolvedScope"],
  isDefault: boolean,
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
    isDefault,
  }
}

// TOMBSTONE (orphan tranche 4): resolveESignProviderForBrokerage deleted. It was
// a pure delegation to the survivor resolveESignProviderForActor({ brokerageId })
// above — the live cascade with callers across buyer-broker agreements,
// commission acknowledgement, the assistant tool rail and the e-sign webhooks.
// A brokerage-only caller passes { brokerageId } to the actor resolver directly.

