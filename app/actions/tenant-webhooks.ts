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
import {
  mapWorkflowWebhookEventRow,
  type WorkflowWebhookEventDbRow,
  type InboundWorkflowEventViewShape,
} from "@/lib/workflow/inbound-event-view"
import { isTenancyPrincipal } from "@/lib/kernel/tenancy-principal"
import { TIER_LABELS, isCanonicalTier } from "@/lib/kernel/tier-role-matrix"
import { generateAgentToken, hashAgentToken } from "@/lib/agentic-os/agent-credentials"
import {
  SAMPLE_WEBHOOK_PAYLOAD,
  TENANT_MINTABLE_SCOPES,
  TOKEN_SELF_SERVE_TIERS,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_SECRET_ROTATION_OVERLAP_MS,
  buildWebhookPayload,
  generateWebhookSecret,
  maskWebhookSecret,
  signWebhookPayload,
  validateTenantScopes,
  validateWebhookEventFilter,
  verifyWebhookSignature,
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
  /** m736 (wave 137B): why the drain switched it off, when it did — null while live / pre-m736. */
  disabledReason?: string | null
  /** m736: when the subscription was switched off (auto or by a tenant admin). */
  disabledAt?: string | null
  /** m736: when the signing secret was last rotated. */
  secretRotatedAt?: string | null
  /** m736: the previous secret still verifies until this instant (rotation overlap). */
  previousSecretExpiresAt?: string | null
}

/**
 * The m736 columns, read in their OWN error-read query so the list keeps working before m736 is
 * applied (the base view simply carries no disabled reason / overlap until then).
 */
async function loadSubscriptionSidecar(svc: Svc, brokerageId: string): Promise<Map<string, { disabledReason: string | null; disabledAt: string | null; secretRotatedAt: string | null; previousSecretExpiresAt: string | null }>> {
  const out = new Map<string, { disabledReason: string | null; disabledAt: string | null; secretRotatedAt: string | null; previousSecretExpiresAt: string | null }>()
  const { data, error } = await svc
    .from("tenant_webhook_subscriptions")
    .select("id, disabled_reason, disabled_at, secret_rotated_at, previous_secret_expires_at")
    .eq("brokerage_id", brokerageId)
  if (error) { console.error(`[tenant-webhooks] m736 sidecar unreadable (applied?): ${error.message}`); return out }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    out.set(String(r.id), {
      disabledReason: (r.disabled_reason as string | null) ?? null,
      disabledAt: (r.disabled_at as string | null) ?? null,
      secretRotatedAt: (r.secret_rotated_at as string | null) ?? null,
      previousSecretExpiresAt: (r.previous_secret_expires_at as string | null) ?? null,
    })
  }
  return out
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
  const sidecar = await loadSubscriptionSidecar(gate.svc, gate.brokerageId)
  return {
    ok: true,
    rows: (data ?? []).map((r) => {
      const view = toSubscriptionView(r as Record<string, unknown>)
      const side = sidecar.get(view.id)
      return side ? { ...view, ...side } : view
    }),
  }
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
  // Filters are limited to the APPROVED catalogue (one validator for both doors).
  const filter = validateWebhookEventFilter(params.events)
  if (!filter.ok) return { ok: false, error: filter.error }
  const events = filter.events

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
    const filter = validateWebhookEventFilter(params.events)
    if (!filter.ok) return { ok: false, error: filter.error }
    patch.events = filter.events
  }
  if (params.description !== undefined) patch.description = params.description?.trim() || null
  if (params.active !== undefined) patch.active = params.active

  const { data: touched, error } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .update(patch)
    .eq("id", params.id)
    .eq("brokerage_id", gate.brokerageId) // tenant anchor — never another brokerage's row
    .select("id")
  if (error) return { ok: false, error: error.message }
  // A tenant predicate that matched nothing resolves exactly like a success (CLAUDE.md §3) — count it.
  if ((touched ?? []).length === 0) return { ok: false, error: "subscription not found" }

  if (params.active === true) {
    // RESUME (wave 137B): a human re-enabling an endpoint starts a fresh streak and clears the
    // auto-disable stamp — m736 columns, their own error-read write (never undoes the resume).
    const { error: resetErr } = await gate.svc
      .from("tenant_webhook_subscriptions")
      .update({ consecutive_failures: 0, disabled_at: null, disabled_reason: null })
      .eq("id", params.id)
      .eq("brokerage_id", gate.brokerageId)
    if (resetErr) console.error(`[tenant-webhooks] resume reset NOT saved (m736 applied?): ${resetErr.message}`)
  } else if (params.active === false) {
    const { error: stampErr } = await gate.svc
      .from("tenant_webhook_subscriptions")
      .update({ disabled_at: new Date().toISOString(), disabled_reason: "paused by tenant admin" })
      .eq("id", params.id)
      .eq("brokerage_id", gate.brokerageId)
    if (stampErr) console.error(`[tenant-webhooks] pause stamp NOT saved (m736 applied?): ${stampErr.message}`)
  }
  return { ok: true }
}

/**
 * ROTATE the signing secret (wave 137B). The new secret is minted server-side and returned ONCE;
 * the old one moves to previous_secret and keeps signing (the drain sends both v1s) and verifying
 * (the inbound trigger door accepts it) until previous_secret_expires_at — the overlap window — so
 * the tenant can swap their receiver without dropping a delivery. Ledgered (withActionLedger,
 * HUMAN_REQUESTED). REQUIRES m736 — before it is applied the rotate is REFUSED (fail closed),
 * never half-done: the update names the m736 columns, so PostgREST rejects it whole.
 */
export async function rotateWebhookSecret(id: string): Promise<
  { ok: true; secret: string; previousValidUntil: string } | { ok: false; error: string }
> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can manage webhooks" }
  const { data: sub, error: readErr } = await gate.svc
    .from("tenant_webhook_subscriptions")
    .select("id, secret")
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!sub) return { ok: false, error: "subscription not found" }

  const secret = generateWebhookSecret()
  const nowIso = new Date().toISOString()
  const previousValidUntil = new Date(Date.now() + WEBHOOK_SECRET_ROTATION_OVERLAP_MS).toISOString()
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const res = await withActionLedger(
    {
      brokerageId: gate.brokerageId,
      action: "webhook.subscription.rotate_secret",
      actor: { type: "user", userId: gate.userId },
      subject: { type: "tenant_webhook_subscription", id },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `signing secret rotated; previous secret valid until ${previousValidUntil}`,
      idempotencyKey: `webhook_rotate:${id}:${nowIso}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "tenant-webhooks",
      detail: { previous_valid_until: previousValidUntil },
    },
    async () => {
      const { data, error } = await gate.svc
        .from("tenant_webhook_subscriptions")
        .update({
          secret,
          previous_secret: (sub as { secret: string }).secret,
          previous_secret_expires_at: previousValidUntil,
          secret_rotated_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", id)
        .eq("brokerage_id", gate.brokerageId)
        .select("id")
      const rotated = !error && (data ?? []).length > 0
      return { rotated, error: error ? error.message : rotated ? null : "subscription not found" }
    },
    {
      settle: (r) => ({ status: r.rotated ? "executed" : "failed", outcome: r.rotated ? "rotated" : "refused", error: r.error }),
      replay: () => ({ rotated: false, error: "already rotated" }),
    },
    { client: gate.svc },
  )
  if (!res.rotated) return { ok: false, error: res.error ?? "rotation refused" }
  return { ok: true, secret, previousValidUntil } // raw secret — shown once
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

// ─── Inbound workflow events (workflow_webhook_events reader) ───────────────
//
// READER (orphan doctrine §1.2). app/api/workflow/trigger/route.ts logs every
// inbound trigger POST here (source, event_type, contact_id, payload,
// received_at — schema-snapshot.ts:733) for audit, and nothing ever read the
// 5 columns back — a tenant who wired GHL/IDX/a QR scan into their own
// signing secret had no way to see whether an inbound trigger actually
// arrived, only whether the RESULTING sequence enrollment (a downstream
// effect) happened to exist. This is the same "developers" surface as the
// OUTBOUND webhook deliveries above — the inbound half of the same
// self-serve automation rail — gated the same way (principalGate, tenant
// from the SESSION, never a parameter).

export type InboundWorkflowEventView = InboundWorkflowEventViewShape

export async function listInboundWorkflowEvents(limit = 50): Promise<
  { ok: true; rows: InboundWorkflowEventView[] } | { ok: false; error: string }
> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can view inbound workflow events" }
  const { data, error } = await gate.svc
    .from("workflow_webhook_events")
    .select("id, source, event_type, contact_id, payload, received_at")
    .eq("brokerage_id", gate.brokerageId)
    .order("received_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)))
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    rows: ((data ?? []) as WorkflowWebhookEventDbRow[]).map(mapWorkflowWebhookEventRow),
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
  const id = (data as { id: string }).id
  await ledgerCredentialAction(gate, "api_credential.mint", id, { name: params.name.trim(), scopes: scopeCheck.scopes })
  return { ok: true, id, token: rawToken } // raw token — shown once
}

/**
 * LAW 5 evidence for a credential lifecycle step (wave 137A): who (the principal), what (mint /
 * rotate / revoke), which credential, which scopes — never the raw token. The step has already
 * happened when this runs; the ledger row records it.
 */
async function ledgerCredentialAction(gate: { svc: Svc; brokerageId: string; userId: string }, action: string, credentialId: string, detail: Record<string, unknown>): Promise<void> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  await withActionLedger(
    {
      brokerageId: gate.brokerageId, action, actor: { type: "user", userId: gate.userId },
      subject: { type: "agent_credentials", id: credentialId }, reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `${action} by the tenancy principal (app/settings/developers)`, riskClass: "LOW_RISK_WRITE",
      systemSource: "tenant-api-credentials", detail: { credential_id: credentialId, ...detail },
    },
    async () => ({ status: "executed" as const }),
    { settle: () => ({ status: "executed", outcome: action }), replay: () => ({ status: "executed" as const }) },
    { client: gate.svc },
  )
}

/**
 * Deactivate one of this brokerage's tokens. COUNTED (CLAUDE.md §3): an update matching nothing
 * resolves exactly like one that worked, so the rows that came back are read — a foreign tenant's
 * id or an already-revoked token is reported, never a silent success.
 */
async function deactivateTenantToken(gate: { svc: Svc; brokerageId: string }, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await gate.svc
    .from("agent_credentials")
    .update({ is_active: false })
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId) // tenant anchor — cannot touch platform or other-tenant tokens
    .eq("is_active", true)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: "No active token with that id in this brokerage" }
  return { ok: true }
}

/** Revoke (deactivate) one of this brokerage's tokens. */
export async function revokeTenantApiToken(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can revoke API tokens" }
  const r = await deactivateTenantToken(gate, id)
  if (!r.ok) return r
  await ledgerCredentialAction(gate, "api_credential.revoke", id, {})
  return { ok: true }
}

/**
 * ROTATE (wave 137A): mint a successor with the SAME name, scopes and expiry, then revoke the
 * predecessor — the raw successor token is returned once. Only an ACTIVE token of the caller's own
 * brokerage rotates; if the predecessor cannot be revoked the successor is revoked too, so a
 * rotation never leaves two live credentials behind.
 */
export async function rotateTenantApiToken(id: string): Promise<{ ok: true; id: string; token: string } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Only the tenancy principal can rotate API tokens" }
  const { data: old, error: readErr } = await gate.svc
    .from("agent_credentials")
    .select("id, name, scopes, expires_at, is_active")
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  const prior = old as { id: string; name: string; scopes: string[] | null; expires_at: string | null; is_active: boolean } | null
  if (!prior || !prior.is_active) return { ok: false, error: "No active token with that id in this brokerage" }
  const scopeCheck = validateTenantScopes(prior.scopes ?? [])
  if (!scopeCheck.ok) return { ok: false, error: `Cannot rotate: ${scopeCheck.error}` }

  const rawToken = generateAgentToken()
  const { data: next, error: insErr } = await gate.svc
    .from("agent_credentials")
    .insert({ name: prior.name, token_hash: hashAgentToken(rawToken), scopes: scopeCheck.scopes, brokerage_id: gate.brokerageId, created_by: gate.userId, expires_at: prior.expires_at })
    .select("id")
    .single()
  if (insErr || !next) return { ok: false, error: insErr?.message ?? "insert failed" }
  const nextId = (next as { id: string }).id
  const revoked = await deactivateTenantToken(gate, prior.id)
  if (!revoked.ok) {
    const undo = await deactivateTenantToken(gate, nextId)
    return { ok: false, error: `Rotation aborted — predecessor not revoked (${revoked.error}); successor ${undo.ok ? "revoked" : `NOT revoked: ${undo.error}`}` }
  }
  await ledgerCredentialAction(gate, "api_credential.rotate", nextId, { rotated_from: prior.id, scopes: scopeCheck.scopes })
  return { ok: true, id: nextId, token: rawToken } // raw token — shown once
}

// ─── Docs data for the Developers page (serializable — safe to pass to the client) ──

export interface DevelopersDocsData {
  catalog: Array<{ event: string; description: string }>
  samplePayloadJson: string
  signatureHeaderExample: string
  /**
   * A REAL, self-checked signature test vector the tenant can run their verifier
   * against — see the comment on getDevelopersDocsData.
   */
  signatureTestVector: {
    secret: string
    /** The exact bytes signed. Byte-for-byte: whitespace changes the HMAC. */
    rawBody: string
    /** The full X-Webhook-Signature header value for that secret + body. */
    header: string
    /** Unix seconds baked into the header, so the tolerance check can be pinned. */
    timestampSec: number
    /** Null when the vector verified; the reason when it did not. */
    error: string | null
  } | null
}

// A FIXED, PUBLISHED, NEVER-USED secret. It signs nothing but the documentation
// vector below: it is not minted, not stored, and matches no subscription — the
// real secrets are generated per-subscription by generateWebhookSecret() and
// shown once. Fixed rather than random so the vector is stable across page
// loads, which is what makes it usable as a regression fixture on the tenant's
// side.
const DOC_VECTOR_SECRET = "whsec_documentation_example_never_used_to_sign_real_traffic"
const DOC_VECTOR_TIMESTAMP = 1752857112

/**
 * Docs data for the Developers page.
 *
 * THE SIGNATURE EXAMPLE IS NOW REAL (orphan burn-down, lane E).
 *
 * `signatureHeaderExample` used to be a hand-typed string containing
 * `v1=5f2ab6…9c41` — an ellipsis. A tenant implementing verification could read
 * the scheme from it but could not TEST anything against it, so the first
 * evidence their HMAC code was wrong was a production endpoint rejecting every
 * real delivery, or worse, accepting them for the wrong reason. There is exactly
 * one thing a verifier author needs and this page did not give: a known-good
 * (secret, body, header) triple.
 *
 * So the header is now COMPUTED, by the same signWebhookPayload() that signs
 * every outbound delivery (lib/platform/tenant-webhooks.ts:64), over the sample
 * payload shown verbatim in the docs block — which means the documented example
 * cannot drift from the implementation the way a typed constant silently does.
 *
 * And it is CHECKED before it ships, with verifyWebhookSignature() — the
 * receiver-side half of the pair (lib/platform/tenant-webhooks-core.ts:217),
 * which had no caller anywhere in the tree. Its whole reason to exist is "what a
 * receiver runs"; running it here is the one place in this codebase that is a
 * receiver. If the two ever disagree — a change to the signing string, the digest,
 * or the header grammar that touches one and not the other — this returns the
 * failure instead of publishing a vector that cannot verify. A test vector nobody
 * verified is the same class of thing as the ellipsis it replaces.
 *
 * The timestamp is pinned rather than `now` so the vector is reproducible; that
 * makes it older than the 300s tolerance, which is exactly why the docs tell the
 * reader to check the HMAC alone against it. Tolerance is still mandatory on
 * real traffic and is stated as such next to it.
 */
export async function getDevelopersDocsData(): Promise<DevelopersDocsData> {
  const rawBody = JSON.stringify(SAMPLE_WEBHOOK_PAYLOAD)
  const header = signWebhookPayload(DOC_VECTOR_SECRET, rawBody, DOC_VECTOR_TIMESTAMP)
  const verified = verifyWebhookSignature(DOC_VECTOR_SECRET, rawBody, header, {
    nowSec: DOC_VECTOR_TIMESTAMP,
  })

  return {
    catalog: WEBHOOK_EVENT_CATALOG.map((d) => ({ event: d.event, description: d.description })),
    samplePayloadJson: JSON.stringify(SAMPLE_WEBHOOK_PAYLOAD, null, 2),
    signatureHeaderExample: `X-Webhook-Signature: ${header}`,
    signatureTestVector: {
      secret: DOC_VECTOR_SECRET,
      rawBody,
      header,
      timestampSec: DOC_VECTOR_TIMESTAMP,
      error: verified
        ? null
        : "This example failed our own verifier — do not test against it. Signing and verification have diverged; please report this.",
    },
  }
}
