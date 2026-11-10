"use server"

// app/actions/tenant-connections.ts — TENANT-FINISHED vendor connections.
// The brokerage holds the vendor relationship (their MLS board, their ListHub
// account, their ShowingTime subscription, their portal lead sources); the
// platform provides the rail: a credential slot per vendor + the portal-lead
// forwarding address + honest status per connection (including "wired,
// awaiting vendor partner verification" where that's the truth).

import { createServiceClient } from "@/lib/supabase/service"
// ★ ACT-AS SEAM — TWO ENTRY POINTS, ONE GATE ★ resolveActingContext for the
// read, resolveWriteContext for the credential write. See requireAdmin below.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

// TENANT ADMIN GATE (kept inline, tenant credentials — deliberately no team_lead):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage.
const ADMIN_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

import { TENANT_CONNECTION_SLOTS } from "@/lib/settings/tenant-connection-slots"
import { CONFIG_SECRET_KEYS } from "@/lib/connections/credential-secret"
import { encryptSecret } from "@/lib/security/secret-crypto"

/**
 * ONE gate, TWO channels (§6).
 *
 * WHY `mode` EXISTS. The act-as merge routed BOTH exports through the WRITE
 * entry point, which refuses a 'read_only' impersonation grant. That is right for
 * saveTenantConnectionAction (it stores a tenant's vendor credential) and wrong
 * for getTenantConnectionsAction, which only reports which slots are filled and
 * how many portal leads arrived. §5: a grant walks the account and never exceeds
 * it — a read-only support session that cannot SEE the connection status is not
 * walking the account.
 *
 * NOTHING IS WIDENED: resolveActingContext hands back the same service client
 * under an active grant, and ADMIN_TYPES is evaluated on the same impersonated
 * identity. The read path admits exactly one extra caller class (read_only) and
 * no extra tenant, table or column.
 *
 * TOMBSTONE (§1.3) — the `createClient()` + `auth.getUser()` pre-check that
 * stood at the top of this gate is removed, not lost: both entry points resolve
 * through getAgentContext and return ok:false for an unauthenticated caller
 * (lib/platform/acting-context.ts:141 and :212), so the extra cookie-client
 * round trip asked a question the seam had already answered — and asked it about
 * the STAFF user rather than the acting identity.
 */
async function requireAdmin(
  mode: "read" | "write",
): Promise<{ brokerageId: string; userId: string } | null> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return null
  if (!ctx.brokerageId) return null
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return null
  return { brokerageId: ctx.brokerageId, userId: ctx.userId }
}

export async function saveTenantConnectionAction(input: {
  platform: string
  apiKey?: string
  /** The secret half of an api-key pair (Vibe client_secret). Stored in
   *  config under the key lib/connections/credential-secret.ts secretFromConfig
   *  reads first, so the resolver hands it back as apiSecret. */
  apiSecret?: string
  apiUrl?: string
  accountId?: string
}): Promise<{ ok: boolean; error?: string }> {
  // WRITE — stores a tenant vendor credential. read_only refused in the gate.
  const ctx = await requireAdmin("write")
  if (!ctx) return { ok: false, error: "Unauthorized" }
  const slot = TENANT_CONNECTION_SLOTS.find((s) => s.key === input.platform)
  if (!slot) return { ok: false, error: "Unknown connection" }
  const apiKey = input.apiKey?.trim()
  if (!apiKey || apiKey.length < 6) return { ok: false, error: "A valid key/credential is required" }

  const svc = createServiceClient()
  const { data: existing } = await svc.from("platform_credentials").select("id")
    .eq("brokerage_id", ctx.brokerageId).eq("platform", input.platform).maybeSingle()
  const apiSecret = input.apiSecret?.trim() || null
  if ((slot.fields as readonly string[]).includes("api_secret") && !apiSecret) return { ok: false, error: `${slot.label} needs the secret half of the pair too` }
  const row = {
    brokerage_id: ctx.brokerageId, platform: input.platform,
    api_key: encryptSecret(apiKey), api_url: input.apiUrl?.trim() || null, account_id: input.accountId?.trim() || null,
    owner_type: "brokerage", owner_id: ctx.brokerageId, is_active: true,
    ...(apiSecret ? { config: { [CONFIG_SECRET_KEYS[0]]: apiSecret } } : {}),
  }
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as any).id)
    : await svc.from("platform_credentials").insert(row)
  if (error) return { ok: false, error: error.message }

  // IMMEDIATE POST-CONDITION (wave 141B — provider_connection): re-read the credential row ON THIS
  // TENANT and verify it is active; evidence lands on lifecycle_events, a failed verify is routed to
  // the owning manager NOW and returned as a failure — never "saved" when the row did not verify.
  // Tenant-owned credential → the tenant sees the actionable sentence (no platform internals).
  const { verifyCredentialRow, reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
  const verified = await verifyCredentialRow(svc, { brokerageId: ctx.brokerageId, platform: input.platform })
  await reportOperationOutcome(svc, {
    operation: "provider_connection", brokerageId: ctx.brokerageId, ok: verified.ok,
    subjectType: "platform_credentials", subjectId: (verified.evidence.rowId as string | undefined) ?? null, actorUserId: ctx.userId, source: "ui",
    evidence: { slot: slot.key, label: slot.label, ...verified.evidence }, error: verified.error,
    tenantFacing: verified.ok ? null : `your ${slot.label} credential was saved but could not be verified as active — re-enter it from Settings › Connections`,
  })
  if (!verified.ok) return { ok: false, error: `${slot.label} was saved but did not verify as an active connection: ${verified.error}` }
  return { ok: true }
}

export interface TenantConnectionStatus {
  key: string
  label: string
  note: string
  fields: readonly string[]
  connected: boolean
}

export async function getTenantConnectionsAction(): Promise<{
  ok: boolean
  connections: TenantConnectionStatus[]
  /** Portal-lead intake: recent counts per portal (proof the forwarding works). */
  portalLeads: Array<{ portal: string; last30d: number }>
}> {
  // READ — slot status + portal-lead counts. A read_only grant may see them (§5).
  const ctx = await requireAdmin("read")
  if (!ctx) return { ok: false, connections: [], portalLeads: [] }
  const svc = createServiceClient()
  const { data: creds } = await svc.from("platform_credentials").select("platform")
    .eq("brokerage_id", ctx.brokerageId)
    .in("platform", TENANT_CONNECTION_SLOTS.map((s) => s.key)).eq("is_active", true)
  const connectedSet = new Set(((creds ?? []) as any[]).map((c) => c.platform))

  // Portal leads land as CONTACTS assigned to the receiving agent (owner's
  // rule) — count by consent provenance (portal_inquiry:<portal>).
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: portalContacts } = await svc.from("contacts").select("tcpa_consent_source")
    .eq("brokerage_id", ctx.brokerageId).like("tcpa_consent_source", "portal_inquiry:%")
    .gte("created_at", since).limit(1000)
  const counts = new Map<string, number>()
  for (const r of (portalContacts ?? []) as any[]) {
    const p = String(r.tcpa_consent_source ?? "").split(":")[1] || "unknown"
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }

  return {
    ok: true,
    connections: TENANT_CONNECTION_SLOTS.map((s) => ({
      key: s.key, label: s.label, note: s.note, fields: s.fields, connected: connectedSet.has(s.key),
    })),
    portalLeads: [...counts.entries()].map(([portal, last30d]) => ({ portal, last30d })),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TENANT-OWNED ACQUISITION PROVIDERS — route B (wave 151, lane 151F; directive 151F steps 1–14).
// The tenant chooses a SUPPORTED provider from the catalogue (lib/providers/tenant-provider-connections.ts — never a generic
// "paste any API" field), authenticates with that provider's documented fields, attests the agreement (scopes, LICENSE,
// retention, AI processing, redistribution prohibited, cost payer tenant), names a territory / frequency / rate limit, and the
// row lands ENCRYPTED in the existing vault (platform_credentials, owner_type brokerage) through the same gate every tenant
// credential write uses here (requireAdmin("write") — the tenant comes from the SESSION, never a body). The key is verified by
// the provider's FREE account read under the tenant's own token (step 4); the push door's signing secret is minted here and
// shown ONCE. Disconnect stops polls (inactive), revokes our push secret, keeps lawful history (step 13).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

import { randomBytes } from "node:crypto"
import { isEncryptionConfigured } from "@/lib/security/secret-crypto"
import {
  TENANT_ACQUISITION_PROVIDERS,
  TENANT_PROVIDER_FREQUENCIES,
  TENANT_WEBHOOK_CONNECTION_PARAM,
  buildTenantProviderCredentialRow,
  classifyTenantProviderFailure,
  deriveTenantProviderConnectionState,
  tenantAcquisitionProvider,
  tenantProviderDisconnectPatch,
  validateProviderAgreement,
  validateProviderTerritory,
  type TenantProviderConnectionConfig,
  type TenantProviderConnectionState,
  type TenantProviderFrequency,
} from "@/lib/providers/tenant-provider-connections"

export interface TenantAcquisitionProviderStatus {
  key: string
  label: string
  state: TenantProviderConnectionState
  reason: string
  actionable: string | null
  /** The documented transports and fields (empty for an unsupported provider — no form is offered). */
  transports: readonly string[]
  fields: ReadonlyArray<{ key: string; label: string; secret?: boolean; required: boolean; placeholder?: string }>
  capabilities: readonly string[]
  docs: string
  pricingNote: string
  why: string
  /** For a connected push provider: the URL path the tenant pastes at the provider (the secret is never re-shown). */
  webhookPath: string | null
  /** The non-secret half of the stored connection (never a token, never the signing secret). */
  connection: { accountLabel: string | null; territory: TenantProviderConnectionConfig["territory"] | null; frequency: TenantProviderFrequency | null; rateLimitPerDay: number | null; agreement: Omit<TenantProviderConnectionConfig["agreement"], "accepted_by_user_id"> | null; lastHealth: TenantProviderConnectionConfig["last_health"]; disconnectedAt: string | null } | null
}

/** Every catalogue provider with its DERIVED state for this tenant (read_only grant may see it — §5, like the slots above). */
export async function getTenantAcquisitionProvidersAction(): Promise<{ ok: true; providers: TenantAcquisitionProviderStatus[]; encryptionConfigured: boolean } | { ok: false; error: string }> {
  const ctx = await requireAdmin("read")
  if (!ctx) return { ok: false, error: "Brokerage admin access required." }
  const svc = createServiceClient()
  const keys = Object.keys(TENANT_ACQUISITION_PROVIDERS)
  const { data: rows, error } = await svc.from("platform_credentials")
    .select("id, platform, api_key, config, is_active, test_status")
    .eq("owner_type", "brokerage").eq("owner_id", ctx.brokerageId).in("platform", keys)
  // A refused read is said, never rendered as "nothing connected" (CLAUDE.md §3).
  if (error) return { ok: false, error: `connections could not be read: ${error.message}` }
  // The sealed token is read as a PRESENCE BIT only (`!!r.api_key`) — the state derivation needs to know a key is stored,
  // never what it is; the value is not carried past this loop (test:credential-migration adjudicates this reader by name).
  const byProvider = new Map<string, { id: string; hasApiKey: boolean; config: Partial<TenantProviderConnectionConfig> | null; is_active: boolean; test_status: "pass" | "fail" | "pending" | null }>()
  for (const r of (rows ?? []) as Array<{ id: string; platform: string; api_key: string | null; config: unknown; is_active: boolean | null; test_status: string | null }>) {
    byProvider.set(r.platform, { id: r.id, hasApiKey: !!r.api_key, config: (r.config ?? null) as Partial<TenantProviderConnectionConfig> | null, is_active: r.is_active === true, test_status: (r.test_status as "pass" | "fail" | "pending" | null) ?? null })
  }
  const providers = keys.map((key): TenantAcquisitionProviderStatus => {
    const p = TENANT_ACQUISITION_PROVIDERS[key]
    const row = byProvider.get(key) ?? null
    const v = deriveTenantProviderConnectionState(key, row ? { exists: true, isActive: row.is_active, testStatus: row.test_status, hasApiKey: row.hasApiKey, config: row.config } : null)
    const cfg = row?.config ?? null
    const agreement = cfg?.agreement ? { scopes: cfg.agreement.scopes, license_acknowledged: cfg.agreement.license_acknowledged, retention_days: cfg.agreement.retention_days, ai_processing_permitted: cfg.agreement.ai_processing_permitted, redistribution: cfg.agreement.redistribution, cost_payer: cfg.agreement.cost_payer, accepted_at: cfg.agreement.accepted_at } : null
    return {
      key, label: p.label, state: v.state, reason: v.reason, actionable: v.actionable, transports: p.transports, fields: p.fields, capabilities: p.capabilities, docs: p.docs, pricingNote: p.pricing.note, why: p.why,
      webhookPath: row && p.webhook && row.is_active && cfg?.webhook_secret ? `${p.webhook.path}?${TENANT_WEBHOOK_CONNECTION_PARAM}=${row.id}` : null,
      connection: row ? { accountLabel: cfg?.account_label ?? null, territory: cfg?.territory ?? null, frequency: cfg?.frequency ?? null, rateLimitPerDay: typeof cfg?.rate_limit_per_day === "number" ? cfg.rate_limit_per_day : null, agreement, lastHealth: cfg?.last_health ?? null, disconnectedAt: cfg?.disconnected_at ?? null } : null,
    }
  })
  return { ok: true, providers, encryptionConfigured: isEncryptionConfigured() }
}

export interface ConnectTenantAcquisitionProviderInput {
  provider: string
  fields: Record<string, string>
  agreement: unknown
  territory: unknown
  frequency: TenantProviderFrequency
  rateLimitPerDay: number
  sandbox?: boolean
}

/**
 * Connect (or rotate) the tenant's OWN account for a supported acquisition provider. Refuses: a non-admin seat, an unknown or
 * unsupported provider, an incomplete agreement or territory, a missing encryption key (FAIL CLOSED — never plaintext; the
 * platform incident is raised). Verifies the token by the provider's free account read and records the honest result on the
 * row; returns the push signing secret ONCE (it is stored encrypted and never re-shown).
 */
export async function connectTenantAcquisitionProviderAction(input: ConnectTenantAcquisitionProviderInput): Promise<
  | { ok: true; state: TenantProviderConnectionState; reason: string; webhookPath: string | null; webhookSecretOnce: string | null }
  | { ok: false; error: string; state?: TenantProviderConnectionState }
> {
  const ctx = await requireAdmin("write")
  if (!ctx) return { ok: false, error: "Unauthorized" }
  const p = tenantAcquisitionProvider(input?.provider ?? "")
  if (!p) return { ok: false, error: `${String(input?.provider)} is not a supported acquisition provider — there is no generic API connection`, state: "unavailable" }
  const preState = deriveTenantProviderConnectionState(p.provider, null)
  if (preState.state === "unsupported" || preState.state === "pending_owner_licensing") return { ok: false, error: preState.reason, state: preState.state }
  if (!TENANT_PROVIDER_FREQUENCIES.includes(input.frequency)) return { ok: false, error: `frequency: one of ${TENANT_PROVIDER_FREQUENCIES.join(" / ")}` }
  const agreement = validateProviderAgreement(p.provider, input.agreement, { userId: ctx.userId })
  if (!agreement.ok) return { ok: false, error: `agreement incomplete — ${agreement.problems.join("; ")}` }
  const territory = validateProviderTerritory(input.territory)
  if (!territory.ok) return { ok: false, error: territory.problems.join("; ") }

  const svc = createServiceClient()
  // FAIL CLOSED on the encryption key (owner, wave 139): no key → no row, and the platform incident is raised.
  if (!isEncryptionConfigured()) {
    const { raiseSecretStorageIncident } = await import("@/lib/security/credential-rotation")
    await raiseSecretStorageIncident(svc, { surface: "tenant acquisition provider connect", brokerageId: ctx.brokerageId, code: "secrets_key_missing" })
    return { ok: false, error: "Secret storage is not configured on this deployment — your token was NOT stored (never in plaintext). Platform staff have been notified." }
  }
  const webhookSecret = p.webhook ? randomBytes(24).toString("base64url") : null
  const built = buildTenantProviderCredentialRow(p, {
    brokerageId: ctx.brokerageId, fields: input.fields ?? {}, agreement: agreement.agreement, territory: territory.territory, frequency: input.frequency,
    rateLimitPerDay: Number(input.rateLimitPerDay ?? 0), webhookSecret, sandbox: input.sandbox === true, encrypt: encryptSecret,
  })
  if (!built.ok) return { ok: false, error: built.problems.join("; ") }

  const { data: existing, error: existingErr } = await svc.from("platform_credentials").select("id")
    .eq("owner_type", "brokerage").eq("owner_id", ctx.brokerageId).eq("platform", p.provider).maybeSingle()
  if (existingErr) return { ok: false, error: `existing connection could not be read: ${existingErr.message} — nothing written` }
  const apiKey = (input.fields?.apiKey ?? "").trim()
  // The write site SHOWS the secret column sealed: the pure builder already sealed api_key with encryptSecret, and the row
  // written here re-seals it explicitly after the spread (test:credential-migration adjudicates `builtRow` by name).
  const builtRow = built.row
  const row = { ...builtRow, api_key: encryptSecret(apiKey) }
  const write = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as { id: string }).id).eq("brokerage_id", ctx.brokerageId).select("id")
    : await svc.from("platform_credentials").insert(row).select("id")
  if (write.error) return { ok: false, error: write.error.message }
  const rowId = ((write.data ?? []) as Array<{ id: string }>)[0]?.id ?? (existing as { id: string } | null)?.id ?? null
  if (!rowId) return { ok: false, error: "the connection row did not land (the write matched no row) — nothing is connected" }

  // Step 4 — verify LIVE under the tenant's own token: the provider's free account read, never a record purchase, never the
  // platform key. The verdict is written on the row; the state the tenant sees is derived from it.
  let health: NonNullable<TenantProviderConnectionConfig["last_health"]>
  if (p.healthCheck.kind === "free_account_read" && p.provider === "batchdata") {
    const { fetchBatchDataWalletBalance } = await import("@/lib/external/batchdata-client")
    const r = await fetchBatchDataWalletBalance({ apiKey, brokerageId: ctx.brokerageId })
    const f = r.ok ? classifyTenantProviderFailure({ httpStatus: 200 }, p.label) : classifyTenantProviderFailure({ httpStatus: r.httpStatus ?? null, networkError: r.httpStatus === null || r.httpStatus === undefined, message: r.error ?? null }, p.label)
    health = { kind: "wallet_balance", status: f.probe, at: new Date().toISOString(), detail: r.ok ? null : f.tenantMessage }
  } else {
    health = { kind: "none", status: "not_configured", at: new Date().toISOString(), detail: "no free health read for this provider" }
  }
  const { data: stamped, error: stampErr } = await svc.from("platform_credentials")
    .update({ test_status: health.status === "ok" ? "pass" : "fail", last_tested_at: health.at, config: { ...(built.row.config as object), last_health: health }, updated_at: new Date().toISOString() })
    .eq("id", rowId).eq("brokerage_id", ctx.brokerageId).select("id")
  if (stampErr || (stamped ?? []).length !== 1) console.error("[tenant-connections] acquisition connection health NOT stamped:", stampErr?.message ?? "update matched no row")

  // IMMEDIATE POST-CONDITION (wave 141B — provider_connection): the same survivor the slots use.
  const { verifyCredentialRow, reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
  const verified = await verifyCredentialRow(svc, { brokerageId: ctx.brokerageId, platform: p.provider })
  const state = deriveTenantProviderConnectionState(p.provider, { exists: verified.ok, isActive: verified.ok, testStatus: health.status === "ok" ? "pass" : "fail", hasApiKey: true, config: { ...(built.row.config as TenantProviderConnectionConfig), last_health: health } })
  await reportOperationOutcome(svc, {
    operation: "provider_connection", brokerageId: ctx.brokerageId, ok: verified.ok && state.state !== "revoked",
    subjectType: "platform_credentials", subjectId: rowId, actorUserId: ctx.userId, source: "ui",
    evidence: { provider: p.provider, state: state.state, health: health.status, scopes: agreement.agreement.scopes, cost_payer: "tenant", ...verified.evidence }, error: verified.ok ? (state.state === "revoked" ? health.detail : null) : verified.error,
    tenantFacing: verified.ok ? (state.state === "revoked" ? health.detail : null) : `your ${p.label} connection was saved but could not be verified as active — re-enter it from Settings › Integrations › Lead sources`,
  })
  if (!verified.ok) return { ok: false, error: `${p.label} was saved but did not verify as an active connection: ${verified.error}` }
  return { ok: true, state: state.state, reason: state.reason, webhookPath: p.webhook && webhookSecret ? `${p.webhook.path}?${TENANT_WEBHOOK_CONNECTION_PARAM}=${rowId}` : null, webhookSecretOnce: webhookSecret }
}

/** Disconnect (step 13): polls stop, our push secret is revoked, lawful history stays. Counted; a no-match is a failure. */
export async function disconnectTenantAcquisitionProviderAction(provider: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireAdmin("write")
  if (!ctx) return { ok: false, error: "Unauthorized" }
  const p = tenantAcquisitionProvider(provider)
  if (!p) return { ok: false, error: "Unknown provider" }
  const svc = createServiceClient()
  const { data: row, error: readErr } = await svc.from("platform_credentials").select("id, config")
    .eq("owner_type", "brokerage").eq("owner_id", ctx.brokerageId).eq("platform", p.provider).maybeSingle()
  if (readErr) return { ok: false, error: `connection could not be read: ${readErr.message}` }
  if (!row) return { ok: false, error: `${p.label} is not connected` }
  // The patch is the PURE function's (one definition); the write site names the four non-secret columns it carries so the
  // credential-store census can see no secret column is written here (the push secret is revoked INSIDE config).
  const patch = tenantProviderDisconnectPatch(((row as { config?: unknown }).config ?? null) as Partial<TenantProviderConnectionConfig> | null)
  const { data: moved, error } = await svc.from("platform_credentials")
    .update({ is_active: patch.is_active, test_status: patch.test_status, updated_at: patch.updated_at, config: patch.config })
    .eq("id", (row as { id: string }).id).eq("brokerage_id", ctx.brokerageId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((moved ?? []).length !== 1) return { ok: false, error: "the disconnect matched no row — nothing changed" }
  const { reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
  await reportOperationOutcome(svc, {
    operation: "provider_connection", brokerageId: ctx.brokerageId, ok: true, subjectType: "platform_credentials", subjectId: (row as { id: string }).id, actorUserId: ctx.userId, source: "ui",
    evidence: { provider: p.provider, action: "disconnect", polls_stopped: true, push_secret_revoked: true, history_kept: true }, error: null, tenantFacing: null,
  })
  return { ok: true }
}
