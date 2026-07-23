"use server"

// The per-tier Connection Center server layer. ONE place the connection UI calls to (a) discover
// which domains/providers the current actor may connect (driven by the canonical registry +
// per-actor gating) and (b) connect / disconnect a credential through the GATED write-side so a
// vendor/contact can never wire email/crm/etc. Writes land in the exact shape dispatch resolvers
// read (see lib/connections/field-spec.ts), so a connection made here is immediately usable.
//
// Works for internal actors (agent/team/brokerage) AND, when an `owner` is supplied, for a
// VENDOR or CONTACT in their portal — ownership is verified via the existing portal auth gates
// (requireVendorActor / requireContactAccess), never trusted from the client.
//
// No stubs: status is read from the real tables dispatch uses (agent_api_credentials for personal
// email/calendar OAuth, social_media_accounts for social, platform_credentials for the rest), and
// each provider carries an `available` flag so the UI never shows a connect path that no-ops.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { revalidatePath } from "next/cache"
import { requireVendorActor } from "@/lib/kernel/portal-auth"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { canonicalProvider, aliasesFor } from "@/lib/integrations/connection-manager"
import { createConnectedAccount, createAccountLink } from "@/lib/providers/payment"
import {
  CONNECTOR_PROVIDERS,
  isProviderAllowedForScope,
  type ConnectionScope,
  type ConnectorDomain,
} from "@/lib/connections/scope"
import {
  DOMAIN_AUTH,
  isOAuthConnection,
  oauthStartPath,
  isConnectSupported,
  buildCredentialWrite,
  connectionScopeForUserType,
  selfConnectableDomains,
} from "@/lib/connections/field-spec"

/** A vendor/contact portal passes this so the center acts on their owner scope (verified server-side). */
export type OwnerHint = { scope: "vendor" | "contact"; id: string }

export interface ProviderStatus {
  domain: ConnectorDomain
  provider: string
  connected: boolean
  detail: string | null
  auth: "oauth" | "api_key"
  oauthStartPath: string | null
  available: boolean
  unavailableReason: string | null
}

export interface ConnectionCenter {
  ok: boolean
  error?: string
  scope: ConnectionScope
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
  scope: ConnectionScope
  ownerId: string | null
  isBrokerageManager: boolean
  /** App role (userType) — drives the self-connectable domain surface (e.g. staff = email/calendar). */
  userType: string
}

async function resolveActor(owner?: OwnerHint): Promise<Actor | null> {
  // Vendor / contact portal — ownership verified by the portal auth gate.
  if (owner?.scope === "vendor") {
    try {
      const v = await requireVendorActor(owner.id)
      return { userId: v.userId, agentId: null, brokerageId: v.brokerageId, scope: "vendor", ownerId: v.vendorId, isBrokerageManager: false, userType: "vendor" }
    } catch {
      // No valid vendor role assignment for this user/vendor pair (vendors has no
      // user_id — the canonical linkage is user_role_assignments, resolved above).
      return null
    }
  }
  if (owner?.scope === "contact") {
    const c = await requireContactAccess(owner.id)
    if (!c.ok || !c.isContactSelf) return null // only the contact connects their own accounts
    return { userId: c.userId, agentId: null, brokerageId: c.brokerageId, scope: "contact", ownerId: owner.id, isBrokerageManager: false, userType: "contact" }
  }

  // Internal actor (agent / team / brokerage).
  const ctx = await getAgentContext().catch(() => null)
  if (!ctx?.isAuthenticated) return null
  const { scope, isBrokerageManager } = connectionScopeForUserType(ctx.userType)
  let teamId: string | null = null
  if (scope === "team") {
    try {
      const supabase = await createClient()
      const { data } = await supabase.from("users").select("team_id").eq("id", ctx.userId).maybeSingle()
      teamId = (data?.team_id as string | null) ?? null
    } catch { teamId = null }
  }
  const ownerId =
    scope === "agent" ? ctx.userId
    : scope === "team" ? teamId
    : scope === "brokerage" ? ctx.brokerageId
    : scope === "platform" ? "platform"
    : null
  return { userId: ctx.userId, agentId: ctx.agentId, brokerageId: ctx.brokerageId, scope, ownerId, isBrokerageManager, userType: ctx.userType }
}

async function isProviderConnected(
  actor: Actor,
  domain: ConnectorDomain,
  provider: string,
): Promise<{ connected: boolean; detail: string | null }> {
  const svc = createServiceClient()
  const aliases = aliasesFor(provider)

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
    const { data } = await svc
      .from("social_media_accounts")
      .select("account_name, is_active")
      .eq("platform", provider)
      .eq("user_id", actor.userId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    return { connected: !!data, detail: (data?.account_name as string) ?? null }
  }

  if (!actor.ownerId) return { connected: false, detail: null }
  const { data } = await svc
    .from("platform_credentials")
    .select("account_name, is_active")
    .eq("owner_type", actor.scope)
    .eq("owner_id", actor.ownerId)
    .in("platform", aliases)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()
  return { connected: !!data, detail: (data?.account_name as string) ?? null }
}

export async function getConnectionCenter(owner?: OwnerHint): Promise<ConnectionCenter> {
  const actor = await resolveActor(owner)
  if (!actor) return { ok: false, error: "Not authorized", scope: owner?.scope ?? "agent", domains: [] }

  const caps = { canOwn: actor.ownerId != null, hasAgentId: actor.agentId != null, isBrokerageManager: actor.isBrokerageManager, hasBrokerage: actor.brokerageId != null }
  // Role-aware self-connect surface: staff see only email/calendar (the rest is the brokerage's);
  // external partners (vendor scope) see calendar/social/financial; everyone else gets their full set.
  const allowedDomains = selfConnectableDomains(actor.userType, actor.scope)
  const domains: ConnectionCenter["domains"] = []

  for (const domain of allowedDomains) {
    const spec = DOMAIN_AUTH[domain]
    const providers: ProviderStatus[] = []
    for (const provider of CONNECTOR_PROVIDERS[domain]) {
      const status = await isProviderConnected(actor, domain, provider)
      const support = isConnectSupported(domain, provider, caps)
      providers.push({
        domain,
        provider,
        connected: status.connected,
        detail: status.detail,
        auth: isOAuthConnection(domain, provider) ? "oauth" : "api_key",
        oauthStartPath: oauthStartPath(domain, provider),
        available: support.available,
        unavailableReason: support.reason ?? null,
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
  owner?: OwnerHint
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await resolveActor(params.owner)
  if (!actor) return { ok: false, error: "Not authorized" }

  const provider = canonicalProvider(params.provider)
  if (!isProviderAllowedForScope(actor.scope, params.domain, provider)) {
    return { ok: false, error: `Your account may not connect ${provider} for ${params.domain}.` }
  }
  // Role surface: staff may only self-connect email/calendar; the rest is brokerage-managed.
  if (!selfConnectableDomains(actor.userType, actor.scope).includes(params.domain)) {
    return { ok: false, error: `Your account connects ${params.domain} through the brokerage, not directly.` }
  }
  if (isOAuthConnection(params.domain, provider)) {
    return { ok: false, error: `${provider} uses a Connect (OAuth) flow, not an API key.` }
  }
  if (!actor.ownerId) return { ok: false, error: "Connection management for your account type isn't available here." }
  if (!actor.brokerageId) return { ok: false, error: "A brokerage is required to store this connection." }

  // Bring-your-own CARRIER (phone/SMS) is available on EVERY plan, but the SUBSCRIBER
  // decides whether their MANAGED agents may BYO — otherwise the platform provisions +
  // bills the number (docs/PHONE-SYSTEM-SETUP.md). A tenancy PRINCIPAL (a solo agent —
  // their own shop — a team lead, or a broker/admin) may always BYO for themselves; a
  // managed agent may only when the brokerage's allow_user_byo_carrier policy is on.
  // Enforced server-side so a managed agent can't store carrier secrets off-UI.
  if (params.domain === "phone" && actor.scope === "agent") {
    const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
    const svcGate = createServiceClient()
    const principal = await isTenancyPrincipal(svcGate, {
      userId: actor.userId, brokerageId: actor.brokerageId, role: actor.userType,
    })
    if (!principal) {
      const { data: gs } = await svcGate
        .from("global_settings").select("additional_settings").eq("brokerage_id", actor.brokerageId).maybeSingle()
      const allow = !!((gs?.additional_settings as Record<string, unknown> | null)?.allow_user_byo_carrier)
      if (!allow) {
        return { ok: false, error: "Your brokerage hasn't enabled bring-your-own carrier — your calling/SMS number is provided by the platform." }
      }
    }
  }

  const write = buildCredentialWrite(params.domain, params.fields)
  if (!write) return { ok: false, error: "Missing required credential fields." }

  const svc = createServiceClient()
  const row = {
    brokerage_id: actor.brokerageId,
    agent_user_id: actor.scope === "agent" ? actor.userId : null,
    owner_type: actor.scope,
    owner_id: actor.ownerId,
    platform: provider,
    scope: actor.scope === "agent" ? "agent" : actor.scope === "team" ? "team" : "brokerage",
    api_key: write.api_key,
    account_id: write.account_id,
    config: write.config,
    is_active: true,
    test_status: "pending",
    updated_at: new Date().toISOString(),
  }

  const { data: existing } = await svc
    .from("platform_credentials")
    .select("id")
    .eq("owner_type", actor.scope)
    .eq("owner_id", actor.ownerId)
    .eq("platform", provider)
    .maybeSingle()
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", existing.id)
    : await svc.from("platform_credentials").insert(row)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/settings/connections")
  return { ok: true }
}

/**
 * Generalized Stripe Connect onboarding for ANY tier (agent / team / brokerage / vendor). Creates
 * (or reuses) an owner-scoped Connect account, stores its acct_… id in platform_credentials so it
 * cascades like every other financial connection, and returns the Stripe onboarding URL. All Stripe
 * calls egress through the gateway (createConnectedAccount / createAccountLink).
 */
export async function startStripeConnect(owner?: OwnerHint): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const actor = await resolveActor(owner)
  if (!actor || !actor.ownerId) return { ok: false, error: "Not authorized" }
  if (!actor.brokerageId) return { ok: false, error: "A brokerage is required to store this connection." }
  if (!selfConnectableDomains(actor.userType, actor.scope).includes("financial")) {
    return { ok: false, error: "Your account doesn't manage a Stripe payout connection here." }
  }

  const svc = createServiceClient()
  const { data: existing } = await svc
    .from("platform_credentials")
    .select("id, account_id")
    .eq("owner_type", actor.scope)
    .eq("owner_id", actor.ownerId)
    .eq("platform", "stripe")
    .maybeSingle()

  // Existing Connect account → just mint a fresh onboarding/resume link.
  if (existing?.account_id) {
    const link = await createAccountLink(existing.account_id as string)
    if (!link.success || !link.onboardingUrl) return { ok: false, error: link.error || "Stripe onboarding failed" }
    return { ok: true, url: link.onboardingUrl }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const created = await createConnectedAccount(user?.email ?? "")
  if (!created.success || !created.accountId || !created.onboardingUrl) {
    return { ok: false, error: created.error || "Stripe onboarding failed" }
  }

  const row = {
    brokerage_id: actor.brokerageId,
    agent_user_id: actor.scope === "agent" ? actor.userId : null,
    owner_type: actor.scope,
    owner_id: actor.ownerId,
    platform: "stripe",
    scope: actor.scope === "agent" ? "agent" : actor.scope === "team" ? "team" : "brokerage",
    account_id: created.accountId,
    config: { stripe_onboarding_complete: false },
    is_active: true,
    test_status: "pending",
    updated_at: new Date().toISOString(),
  }
  const { error } = existing?.id
    ? await svc.from("platform_credentials").update(row).eq("id", existing.id)
    : await svc.from("platform_credentials").insert(row)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/settings/connections")
  return { ok: true, url: created.onboardingUrl }
}

export async function disconnectProvider(params: {
  domain: ConnectorDomain
  provider: string
  owner?: OwnerHint
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await resolveActor(params.owner)
  if (!actor) return { ok: false, error: "Not authorized" }
  const provider = canonicalProvider(params.provider)
  const svc = createServiceClient()
  const aliases = aliasesFor(provider)

  if ((params.domain === "email" || params.domain === "calendar") && actor.agentId) {
    const { error } = await svc.from("agent_api_credentials").update({ is_active: false })
      .eq("agent_id", actor.agentId).in("service_name", aliases)
    if (error) return { ok: false, error: error.message }
  } else if (params.domain === "social") {
    const { error } = await svc.from("social_media_accounts").update({ is_active: false })
      .eq("platform", provider).eq("user_id", actor.userId)
    if (error) return { ok: false, error: error.message }
  } else {
    if (!actor.ownerId) return { ok: false, error: "Not available for your account type." }
    const { error } = await svc.from("platform_credentials").update({ is_active: false })
      .eq("owner_type", actor.scope).eq("owner_id", actor.ownerId).in("platform", aliases)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath("/settings/connections")
  return { ok: true }
}
