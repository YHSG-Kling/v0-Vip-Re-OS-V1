"use server"

// TENANT SELF-SERVE DEVELOPERS SURFACE — outbound webhook subscriptions +
// brokerage-scoped Agentic-API tokens, managed by the TENANCY PRINCIPAL
// (isTenancyPrincipal — broker/admin always; the solo agent on solo tier;
// the team lead on team tier). Everything is brokerage-scoped: a tenant can
// only ever see/mutate their own subscriptions, deliveries, and tokens.
//
// Secrets follow the superadmin agentic-tokens idiom exactly: the raw value
// (webhook signing secret / vos_ bearer token) is returned ONCE at mint; only
// a hash (tokens) or the stored secret (webhooks, needed for signing) lives
// server-side, and list surfaces only ever show a masked tail.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isTenancyPrincipal } from "@/lib/kernel/tenancy-principal"
import { TIER_LABELS, isCanonicalTier } from "@/lib/kernel/tier-role-matrix"
import { generateAgentToken, hashAgentToken } from "@/lib/agentic-os/agent-credentials"
import {
  SAMPLE_WEBHOOK_PAYLOAD,
  TENANT_MINTABLE_SCOPES,
  TOKEN_SELF_SERVE_TIERS,
  WEBHOOK_EVENT_CATALOG,
  buildWebhookPayload,
  generateWebhookSecret,
  isKnownWebhookEvent,
  maskWebhookSecret,
  validateTenantScopes,
} from "@/lib/platform/tenant-webhooks-core"
import { postSignedWebhook } from "@/lib/platform/tenant-webhooks"

type Svc = ReturnType<typeof createServiceClient>

// ─── Principal gate (the coverage-mode idiom) ────────────────────────────────

async function principalGate(): Promise<{ svc: Svc; brokerageId: string; userId: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  // user_type, never legacy users.role — PRINCIPAL_ROLES is user_type vocabulary.
  const { data: me } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  const brokerageId = (me as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return null
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, {
    userId: user.id,
    brokerageId,
    role: String((me as { user_type?: string | null } | null)?.user_type ?? ""),
  })
  return principal ? { svc, brokerageId, userId: user.id } : null
}

// ─── Webhook subscriptions — CRUD ────────────────────────────────────────────

export interface WebhookSubscriptionView {
  id: string
  url: string
  events: string[]
  description: string | null
  active: boolean
  secretMasked: string
  createdAt: string
  lastSuccessAt: string | null
  lastFailureAt: string | null
  failureCount: number
}

function toSubscriptionView(row: Record<string, unknown>): WebhookSubscriptionView {
  return {
    id: String(row.id),
    url: String(row.url),
    events: (row.events as string[] | null) ?? [],
    description: (row.description as string | null) ?? null,
    active: row.active === true,
    secretMasked: maskWebhookSecret(String(row.secret ?? "")),
    createdAt: String(row.created_at),
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastFailureAt: (row.last_failure_at as string | null) ?? null,
    failureCount: Number(row.failure_count ?? 0),
  }
}

export async function listWebhookSubscriptions(): Promise<
  { ok: true; rows: WebhookSubscriptionView[] } | { ok: false; error: string }
> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }
  const { data, error } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .select("id, url, events, description, active, secret, created_at, last_success_at, last_failure_at, failure_count")
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: (data ?? []).map((r) => toSubscriptionView(r as Record<string, unknown>)) }
}

function validateEndpointUrl(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return "url must be a valid absolute URL" }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "url must be http(s)"
  return null
}

/** Create a subscription. The signing secret is generated server-side and returned ONCE. */
export async function createWebhookSubscription(params: {
  url: string
  events: string[]
  description?: string | null
}): Promise<{ ok: true; id: string; secret: string } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }

  const url = params.url?.trim()
  if (!url) return { ok: false, error: "url is required" }
  const urlError = validateEndpointUrl(url)
  if (urlError) return { ok: false, error: urlError }
  const events = Array.from(new Set((params.events ?? []).map((e) => e.trim()).filter(Boolean)))
  if (events.length === 0) return { ok: false, error: "pick at least one event" }
  const unknown = events.filter((e) => !isKnownWebhookEvent(e))
  if (unknown.length > 0) return { ok: false, error: `unknown event(s): ${unknown.join(", ")}` }

  const secret = generateWebhookSecret()
  const { data, error } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .insert({
      brokerage_id: gate.brokerageId,
      url,
      secret,
      events,
      description: params.description?.trim() || null,
      active: true,
      created_by: gate.userId,
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, id: (data as { id: string }).id, secret } // raw secret — shown once
}

export async function updateWebhookSubscription(params: {
  id: string
  url?: string
  events?: string[]
  description?: string | null
  active?: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (params.url !== undefined) {
    const url = params.url.trim()
    const urlError = url ? validateEndpointUrl(url) : "url is required"
    if (urlError) return { ok: false, error: urlError }
    patch.url = url
  }
  if (params.events !== undefined) {
    const events = Array.from(new Set(params.events.map((e) => e.trim()).filter(Boolean)))
    if (events.length === 0) return { ok: false, error: "pick at least one event" }
    const unknown = events.filter((e) => !isKnownWebhookEvent(e))
    if (unknown.length > 0) return { ok: false, error: `unknown event(s): ${unknown.join(", ")}` }
    patch.events = events
  }
  if (params.description !== undefined) patch.description = params.description?.trim() || null
  if (params.active !== undefined) patch.active = params.active

  const { error } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .update(patch)
    .eq("id", params.id)
    .eq("brokerage_id", gate.brokerageId) // tenant anchor — never another brokerage's row
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deleteWebhookSubscription(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }
  const { error } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .delete()
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId) // deliveries follow via FK cascade
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Send a REAL signed test ping to the endpoint and report the honest response. */
export async function sendWebhookTestPing(id: string): Promise<
  { ok: true; delivered: boolean; status: number | null; error: string | null; durationMs: number }
  | { ok: false; error: string }
> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }
  const { data: sub, error } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .select("id, url, secret")
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  if (error || !sub) return { ok: false, error: error?.message ?? "subscription not found" }

  const payload = buildWebhookPayload("ping", {
    id: crypto.randomUUID(),
    brokerage_id: gate.brokerageId,
    entity_type: "webhook_subscription",
    entity_id: (sub as { id: string }).id,
    event_type: "ping",
    metadata: { note: "Test ping from the VIP-RE-OS Developers settings page." },
    created_at: new Date().toISOString(),
  })
  const post = await postSignedWebhook({
    url: (sub as { url: string }).url,
    secret: (sub as { secret: string }).secret,
    event: "ping",
    deliveryId: payload.id,
    payload,
  })
  return { ok: true, delivered: post.ok, status: post.status, error: post.error, durationMs: post.durationMs }
}

// ─── Delivery log ────────────────────────────────────────────────────────────

export interface WebhookDeliveryView {
  id: string
  subscriptionId: string
  eventType: string
  status: string
  attempts: number
  responseStatus: number | null
  errorDetail: string | null
  createdAt: string
  deliveredAt: string | null
  nextAttemptAt: string | null
}

export async function listWebhookDeliveries(limit = 50): Promise<
  { ok: true; rows: WebhookDeliveryView[] } | { ok: false; error: string }
> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }
  const { data, error } = await gate.svc
    .from("tenant_webhook_deliveries")
    .select("id, subscription_id, event_type, status, attempts, response_status, error_detail, created_at, delivered_at, next_attempt_at")
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)))
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    rows: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      subscriptionId: String(r.subscription_id),
      eventType: String(r.event_type),
      status: String(r.status),
      attempts: Number(r.attempts ?? 0),
      responseStatus: (r.response_status as number | null) ?? null,
      errorDetail: (r.error_detail as string | null) ?? null,
      createdAt: String(r.created_at),
      deliveredAt: (r.delivered_at as string | null) ?? null,
      nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
    })),
  }
}

// ─── Self-serve API tokens (brokerage tier) ──────────────────────────────────

export interface TenantApiTokenView {
  id: string
  name: string
  scopes: string[]
  isActive: boolean
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface DeveloperTokenState {
  /** Honest tier gate: brokerage / multi_location tiers mint; others see why not. */
  tokensAvailable: boolean
  tierLabel: string
  requiredTierLabel: string
  tokens: TenantApiTokenView[]
  mintableScopes: Array<{ scope: string; description: string }>
}

async function resolveTier(svc: Svc, brokerageId: string): Promise<{ tier: string; label: string }> {
  const { data } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
  const tier = String((data as { plan_tier?: string | null } | null)?.plan_tier ?? "solo_agent")
  return { tier, label: isCanonicalTier(tier) ? TIER_LABELS[tier] : tier }
}

export async function getDeveloperTokenState(): Promise<
  { ok: true; state: DeveloperTokenState } | { ok: false; error: string }
> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage API tokens" }
  const { tier, label } = await resolveTier(gate.svc, gate.brokerageId)
  const tokensAvailable = TOKEN_SELF_SERVE_TIERS.has(tier)

  let tokens: TenantApiTokenView[] = []
  if (tokensAvailable) {
    const { data, error } = await gate.svc
      .from("agent_credentials")
      .select("id, name, scopes, is_active, created_at, last_used_at, expires_at")
      .eq("brokerage_id", gate.brokerageId)
      .order("created_at", { ascending: false })
    if (error) return { ok: false, error: error.message }
    tokens = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      scopes: (r.scopes as string[] | null) ?? [],
      isActive: r.is_active === true,
      createdAt: String(r.created_at),
      lastUsedAt: (r.last_used_at as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
    }))
  }

  return {
    ok: true,
    state: {
      tokensAvailable,
      tierLabel: label,
      requiredTierLabel: TIER_LABELS.brokerage,
      tokens,
      mintableScopes: TENANT_MINTABLE_SCOPES.map((s) => ({ ...s })),
    },
  }
}

/**
 * Mint a brokerage-scoped Agentic-API token — the EXACT agent_credentials idiom
 * the superadmin surface uses (raw vos_ token returned once; only the sha256 is
 * stored), but pinned to the caller's brokerage and to the self-serve scope
 * allowlist (never "*", never another tenant). Brokerage tier only.
 */
export async function mintTenantApiToken(params: {
  name: string
  scopes: string[]
}): Promise<{ ok: true; id: string; token: string } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can mint API tokens" }
  const { tier, label } = await resolveTier(gate.svc, gate.brokerageId)
  if (!TOKEN_SELF_SERVE_TIERS.has(tier)) {
    return { ok: false, error: `API tokens are available on the ${TIER_LABELS.brokerage} tier (you're on ${label})` }
  }
  if (!params.name?.trim()) return { ok: false, error: "name is required" }
  const scopeCheck = validateTenantScopes(params.scopes)
  if (!scopeCheck.ok) return { ok: false, error: scopeCheck.error }

  const rawToken = generateAgentToken()
  const { data, error } = await gate.svc
    .from("agent_credentials")
    .insert({
      name: params.name.trim(),
      token_hash: hashAgentToken(rawToken),
      scopes: scopeCheck.scopes,
      brokerage_id: gate.brokerageId, // always the caller's own tenancy
      created_by: gate.userId,
      expires_at: null,
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, id: (data as { id: string }).id, token: rawToken } // raw token — shown once
}

/** Revoke (deactivate) one of this brokerage's tokens. */
export async function revokeTenantApiToken(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can revoke API tokens" }
  const { error } = await gate.svc
    .from("agent_credentials")
    .update({ is_active: false })
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId) // tenant anchor — cannot touch platform or other-tenant tokens
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ─── Docs data for the Developers page (serializable — safe to pass to the client) ──

export interface DevelopersDocsData {
  catalog: Array<{ event: string; description: string }>
  samplePayloadJson: string
  signatureHeaderExample: string
}

export async function getDevelopersDocsData(): Promise<DevelopersDocsData> {
  return {
    catalog: WEBHOOK_EVENT_CATALOG.map((d) => ({ event: d.event, description: d.description })),
    samplePayloadJson: JSON.stringify(SAMPLE_WEBHOOK_PAYLOAD, null, 2),
    signatureHeaderExample: "X-Webhook-Signature: t=1752857112,v1=5f2ab6…9c41 (hex HMAC-SHA256 over `${t}.${rawBody}`)",
  }
}
