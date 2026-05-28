"use server"

// The per-tier Connection Center server layer. ONE place the connection UI calls to (a) discover
// which domains/providers the current actor may connect (driven by the canonical registry +
// per-actor gating) and (b) connect / disconnect a credential through the GATED write-side so a
// vendor/contact can never wire email/crm/etc. Writes land in the exact shape dispatch resolvers
// read (see lib/connections/field-spec.ts), so a connection made here is immediately usable.
//
// No stubs: status is read from the real tables dispatch uses (agent_api_credentials for personal
// email/calendar OAuth, social_media_accounts for social, platform_credentials for the rest).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { revalidatePath } from "next/cache"
import { canonicalProvider, aliasesFor } from "@/lib/integrations/connection-manager"
import {
  CONNECTOR_PROVIDERS,
  selectableConnectionsForScope,
  isProviderAllowedForScope,
  type ConnectionScope,
  type ConnectorDomain,
} from "@/lib/connections/scope"
import {
  DOMAIN_AUTH,
  isOAuthConnection,
  oauthStartPath,
  buildCredentialWrite,
  connectionScopeForUserType,
} from "@/lib/connections/field-spec"

export interface ProviderStatus {
  domain: ConnectorDomain
  provider: string
  connected: boolean
  detail: string | null
  auth: "oauth" | "api_key"
  oauthStartPath: string | null
}

export interface ConnectionCenter {
  ok: boolean
  error?: string
  scope: ConnectionScope
  /** domain → field spec for rendering api_key forms. */
  domains: Array<{
    domain: ConnectorDomain
    method: "oauth" | "api_key"
    fields: { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string }[]
    providers: ProviderStatus[]
  }>
}

interface Actor {
  userId: string
  agentId: string | null
  brokerageId: string | null
  teamId: string | null
  scope: ConnectionScope
  isBrokerageManager: boolean
}

async function resolveActor(): Promise<Actor | null> {
  const ctx = await getAgentContext().catch(() => null)
  if (!ctx?.isAuthenticated) return null
  // team_id isn't on AgentContext; read it directly for team-scoped ownership.
  let teamId: string | null = null
  try {
    const supabase = await createClient()
    const { data } = await supabase.from("users").select("team_id").eq("id", ctx.userId).maybeSingle()
    teamId = (data?.team_id as string | null) ?? null
  } catch {
    teamId = null
  }
  const { scope, isBrokerageManager } = connectionScopeForUserType(ctx.userType)
  return { userId: ctx.userId, agentId: ctx.agentId, brokerageId: ctx.brokerageId, teamId, scope, isBrokerageManager }
}

/** owner_id for the actor's scope, or null when this surface can't own it (vendor/contact use
 *  their portal identity; platform requires a brokerage anchor for the NOT NULL FK). */
function ownerIdFor(actor: Actor): string | null {
  switch (actor.scope) {
    case "agent":     return actor.userId
    case "team":      return actor.teamId
    case "brokerage": return actor.brokerageId
    case "platform":  return "platform"
    default:          return null // vendor / contact — managed in their portal, not here
  }
}

async function isProviderConnected(
  actor: Actor,
  domain: ConnectorDomain,
  provider: string,
): Promise<{ connected: boolean; detail: string | null }> {
  const svc = createServiceClient()
  const aliases = aliasesFor(provider)

  // Personal email/calendar OAuth lives in agent_api_credentials (what dispatch sends through).
  if ((domain === "email" || domain === "calendar") && actor.agentId) {
    const { data } = await svc
      .from("agent_api_credentials")
      .select("config, is_active")
      .eq("agent_id", actor.agentId)
      .in("service_name", aliases)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    return { connected: !!data, detail: (data?.config as any)?.email ?? null }
  }

  if (domain === "social") {
    let q = svc.from("social_media_accounts").select("account_name, is_active").eq("platform", provider).eq("is_active", true)
    q = actor.agentId ? q.eq("agent_id", actor.agentId) : q.eq("user_id", actor.userId)
    const { data } = await q.limit(1).maybeSingle()
    return { connected: !!data, detail: (data?.account_name as string) ?? null }
  }

  // Everything else: owner-scoped platform_credentials.
  const ownerId = ownerIdFor(actor)
  if (!ownerId) return { connected: false, detail: null }
  const { data } = await svc
    .from("platform_credentials")
    .select("account_name, is_active")
    .eq("owner_type", actor.scope)
    .eq("owner_id", ownerId)
    .in("platform", aliases)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()
  return { connected: !!data, detail: (data?.account_name as string) ?? null }
}

export async function getConnectionCenter(): Promise<ConnectionCenter> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Not authenticated", scope: "agent", domains: [] }

  const selectable = selectableConnectionsForScope(actor.scope)
  const domains: ConnectionCenter["domains"] = []

  for (const domain of Object.keys(selectable) as ConnectorDomain[]) {
    const spec = DOMAIN_AUTH[domain]
    const providers: ProviderStatus[] = []
    for (const provider of CONNECTOR_PROVIDERS[domain]) {
      const status = await isProviderConnected(actor, domain, provider)
      providers.push({
        domain,
        provider,
        connected: status.connected,
        detail: status.detail,
        auth: isOAuthConnection(domain, provider) ? "oauth" : "api_key",
        oauthStartPath: oauthStartPath(domain, provider),
      })
    }
    domains.push({ domain, method: spec.method, fields: spec.fields, providers })
  }

  return { ok: true, scope: actor.scope, domains }
}

export async function connectApiKeyProvider(params: {
  domain: ConnectorDomain
  provider: string
  fields: Record<string, string>
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Not authenticated" }

  const provider = canonicalProvider(params.provider)
  if (!isProviderAllowedForScope(actor.scope, params.domain, provider)) {
    return { ok: false, error: `Your account may not connect ${provider} for ${params.domain}.` }
  }
  if (isOAuthConnection(params.domain, provider)) {
    return { ok: false, error: `${provider} uses a Connect (OAuth) flow, not an API key.` }
  }
  const ownerId = ownerIdFor(actor)
  if (!ownerId) return { ok: false, error: "Connection management for your account type isn't available here." }
  if (!actor.brokerageId) return { ok: false, error: "A brokerage is required to store this connection." }

  const write = buildCredentialWrite(params.domain, params.fields)
  if (!write) return { ok: false, error: "Missing required credential fields." }

  const svc = createServiceClient()
  const row = {
    brokerage_id: actor.brokerageId,
    agent_user_id: actor.scope === "agent" ? actor.userId : null,
    owner_type: actor.scope,
    owner_id: ownerId,
    platform: provider,
    scope: actor.scope === "agent" ? "agent" : actor.scope === "team" ? "team" : "brokerage",
    api_key: write.api_key,
    account_id: write.account_id,
    config: write.config,
    is_active: true,
    test_status: "pending",
    updated_at: new Date().toISOString(),
  }

  // Update-or-insert by (owner_type, owner_id, platform) — the partial owner index can't be an
  // ON CONFLICT target, so resolve the existing row explicitly to avoid duplicates.
  const { data: existing } = await svc
    .from("platform_credentials")
    .select("id")
    .eq("owner_type", actor.scope)
    .eq("owner_id", ownerId)
    .eq("platform", provider)
    .maybeSingle()
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", existing.id)
    : await svc.from("platform_credentials").insert(row)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/settings/connections")
  return { ok: true }
}

export async function disconnectProvider(params: {
  domain: ConnectorDomain
  provider: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Not authenticated" }
  const provider = canonicalProvider(params.provider)
  const svc = createServiceClient()
  const aliases = aliasesFor(provider)

  if ((params.domain === "email" || params.domain === "calendar") && actor.agentId) {
    const { error } = await svc.from("agent_api_credentials").update({ is_active: false })
      .eq("agent_id", actor.agentId).in("service_name", aliases)
    if (error) return { ok: false, error: error.message }
  } else if (params.domain === "social") {
    let q = svc.from("social_media_accounts").update({ is_active: false }).eq("platform", provider)
    q = actor.agentId ? q.eq("agent_id", actor.agentId) : q.eq("user_id", actor.userId)
    const { error } = await q
    if (error) return { ok: false, error: error.message }
  } else {
    const ownerId = ownerIdFor(actor)
    if (!ownerId) return { ok: false, error: "Not available for your account type." }
    const { error } = await svc.from("platform_credentials").update({ is_active: false })
      .eq("owner_type", actor.scope).eq("owner_id", ownerId).in("platform", aliases)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath("/settings/connections")
  return { ok: true }
}
