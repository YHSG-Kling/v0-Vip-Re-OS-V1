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
// THE tenant-facing presenter (wave 152, lane 152A): every error / status sentence this file hands a person is composed
// there — no raw database text, no internal state reason, no "brokerage" payer wording unless the tenant IS one.
import { presentTenantError, presentTenantMessage, resolveTenantPayer, tenantProviderAttestation, type TenantConnectionView } from "@/lib/errors"

/** The refusal every admin-gated door here returns — actor-neutral (a solo agent's or a team's owner is the admin). */
function adminOnly(what: string): string {
  return presentTenantMessage({ what, affects: "Only an admin on this account can do this", next: "account_admin" }).sentence
}

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
}): Promise<{ ok: boolean; error?: string; message?: string }> {
  // WRITE — stores a tenant vendor credential. read_only refused in the gate.
  const ctx = await requireAdmin("write")
  if (!ctx) return { ok: false, error: adminOnly("This connection wasn't changed") }
  const slot = TENANT_CONNECTION_SLOTS.find((s) => s.key === input.platform)
  if (!slot) return { ok: false, error: "That connection can't be set up here." }
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
  if (error) return { ok: false, error: presentTenantError({ what: `${slot.label} couldn't be saved`, raw: error, work: { state: "not_saved" }, context: "tenant-connections.save" }).sentence }

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
  if (!verified.ok) return { ok: false, error: presentTenantError({ what: `${slot.label} was saved but couldn't be confirmed as active`, raw: verified.error, next: "you", action: { label: "Re-enter it" }, context: "tenant-connections.save.verify" }).sentence }
  // Saved and active — NOT "connected": nothing on this door tests the credential with the vendor, so the person is
  // told exactly that (a failed or untested provider action never reads "Connected").
  return { ok: true, message: presentTenantMessage({ what: `${slot.label} details saved`, affects: "They haven't been tested with the provider yet", next: "you" }).text }
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
  presentTenantProviderConnection,
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
  /** The provider's name as a tenant reads it (no catalogue annotation). */
  label: string
  /** The INTERNAL state — the panel's logic only (which buttons apply); the person reads `view`. */
  state: TenantProviderConnectionState
  /** THE presenter's three truths: availability (label + message), who controls the credentials, cost and authority. */
  view: TenantConnectionView
  /** The first-person attestation, worded for THIS account's verified business kind (never "my brokerage" for a solo agent). */
  attestation: string
  /** The documented transports and fields (empty for an unsupported provider — no form is offered). */
  transports: readonly string[]
  fields: ReadonlyArray<{ key: string; label: string; secret?: boolean; required: boolean; placeholder?: string }>
  capabilities: readonly string[]
  /** For a connected push provider: the URL path the tenant pastes at the provider (the secret is never re-shown). */
  webhookPath: string | null
  /** The non-secret half of the stored connection (never a token, never the signing secret, never an internal probe code). */
  connection: { accountLabel: string | null; territory: TenantProviderConnectionConfig["territory"] | null; frequency: TenantProviderFrequency | null; rateLimitPerDay: number | null; agreement: Omit<TenantProviderConnectionConfig["agreement"], "accepted_by_user_id"> | null; lastCheckedAt: string | null; disconnectedAt: string | null } | null
}

/** The tenant's name for a catalogue provider ("BatchData", never "BatchData (your own account)"). */
function tenantProviderName(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim() || label
}

/** Every catalogue provider with its DERIVED state for this tenant (read_only grant may see it — §5, like the slots above). */
export async function getTenantAcquisitionProvidersAction(): Promise<{ ok: true; providers: TenantAcquisitionProviderStatus[]; encryptionConfigured: boolean } | { ok: false; error: string }> {
  const ctx = await requireAdmin("read")
  if (!ctx) return { ok: false, error: adminOnly("These connections can't be shown to you") }
  const svc = createServiceClient()
  const keys = Object.keys(TENANT_ACQUISITION_PROVIDERS)
  const { data: rows, error } = await svc.from("platform_credentials")
    .select("id, platform, api_key, config, is_active, test_status")
    .eq("owner_type", "brokerage").eq("owner_id", ctx.brokerageId).in("platform", keys)
  // A refused read is said, never rendered as "nothing connected" (CLAUDE.md §3) — and said WITHOUT the database text.
  if (error) return { ok: false, error: presentTenantError({ what: "Your provider connections couldn't be loaded right now", raw: error, work: { state: "unchanged" }, context: "tenant-connections.acquisition.read" }).sentence }
  // The payer wording follows THIS tenant's verified business kind (its own plan tier, read on the session tenant).
  const payer = await resolveTenantPayer(svc, ctx.brokerageId)
  // The sealed token is read as a PRESENCE BIT only (`!!r.api_key`) — the state derivation needs to know a key is stored,
  // never what it is; the value is not carried past this loop (test:credential-migration adjudicates this reader by name).
  const byProvider = new Map<string, { id: string; hasApiKey: boolean; config: Partial<TenantProviderConnectionConfig> | null; is_active: boolean; test_status: "pass" | "fail" | "pending" | null }>()
  for (const r of (rows ?? []) as Array<{ id: string; platform: string; api_key: string | null; config: unknown; is_active: boolean | null; test_status: string | null }>) {
    byProvider.set(r.platform, { id: r.id, hasApiKey: !!r.api_key, config: (r.config ?? null) as Partial<TenantProviderConnectionConfig> | null, is_active: r.is_active === true, test_status: (r.test_status as "pass" | "fail" | "pending" | null) ?? null })
  }
  const providers = keys.map((key): TenantAcquisitionProviderStatus => {
    const p = TENANT_ACQUISITION_PROVIDERS[key]
    const row = byProvider.get(key) ?? null
    const facts = row ? { exists: true, isActive: row.is_active, testStatus: row.test_status, hasApiKey: row.hasApiKey, config: row.config } : null
    const v = deriveTenantProviderConnectionState(key, facts)
    const cfg = row?.config ?? null
    const agreement = cfg?.agreement ? { scopes: cfg.agreement.scopes, license_acknowledged: cfg.agreement.license_acknowledged, retention_days: cfg.agreement.retention_days, ai_processing_permitted: cfg.agreement.ai_processing_permitted, redistribution: cfg.agreement.redistribution, cost_payer: cfg.agreement.cost_payer, accepted_at: cfg.agreement.accepted_at } : null
    const name = tenantProviderName(p.label)
    return {
      key, label: name, state: v.state, view: presentTenantProviderConnection(key, v, facts, payer), attestation: tenantProviderAttestation(name, payer),
      transports: p.transports, fields: p.fields, capabilities: p.capabilities,
      webhookPath: row && p.webhook && row.is_active && cfg?.webhook_secret ? `${p.webhook.path}?${TENANT_WEBHOOK_CONNECTION_PARAM}=${row.id}` : null,
      connection: row ? { accountLabel: cfg?.account_label ?? null, territory: cfg?.territory ?? null, frequency: cfg?.frequency ?? null, rateLimitPerDay: typeof cfg?.rate_limit_per_day === "number" ? cfg.rate_limit_per_day : null, agreement, lastCheckedAt: cfg?.last_health?.at ?? null, disconnectedAt: cfg?.disconnected_at ?? null } : null,
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
/** The agreement / territory / field problems the pure validators name by FIELD, said the way a person fills the form. */
const FORM_PROBLEM: ReadonlyArray<[RegExp, string]> = [
  [/^scopes/, "choose at least one use for this account"],
  [/^license_acknowledged/, "confirm you hold this account under the provider's own terms and license"],
  [/^retention_days/, "set how many days records are kept (1 to 3,650)"],
  [/^ai_processing_permitted/, "say whether the AI may work these records"],
  [/^(?:redistribution|cost_payer)/, "the fixed agreement terms can't be changed"],
  [/^accepted_by_user_id/, "sign in again"],
  [/^territory\.state/, "enter a two-letter state"],
  [/^territory\.zip_codes/, "enter at least one five-digit ZIP code"],
  [/^frequency/, "choose how new data arrives"],
  [/^rate_limit_per_day/, "enter a whole number of records per day (0 for no limit of your own)"],
  [/: required$/, "fill in every required field"],
]
function formProblems(problems: readonly string[]): string {
  const said = [...new Set(problems.map((x) => FORM_PROBLEM.find(([re]) => re.test(x))?.[1] ?? "check the highlighted fields"))]
  return `Please ${said.join("; ")}.`
}

export async function connectTenantAcquisitionProviderAction(input: ConnectTenantAcquisitionProviderInput): Promise<
  | { ok: true; state: TenantProviderConnectionState; view: TenantConnectionView; webhookPath: string | null; webhookSecretOnce: string | null }
  | { ok: false; error: string; state?: TenantProviderConnectionState }
> {
  const ctx = await requireAdmin("write")
  if (!ctx) return { ok: false, error: adminOnly("Nothing was connected") }
  const p = tenantAcquisitionProvider(input?.provider ?? "")
  if (!p) return { ok: false, error: "That provider can't be connected here. Choose one from the list.", state: "unavailable" }
  const preState = deriveTenantProviderConnectionState(p.provider, null)
  const svc = createServiceClient()
  const payer = await resolveTenantPayer(svc, ctx.brokerageId)
  if (preState.state === "unsupported" || preState.state === "pending_owner_licensing") return { ok: false, error: presentTenantProviderConnection(p.provider, preState, null, payer).message.sentence, state: preState.state }
  if (!TENANT_PROVIDER_FREQUENCIES.includes(input.frequency)) return { ok: false, error: formProblems(["frequency"]) }
  const agreement = validateProviderAgreement(p.provider, input.agreement, { userId: ctx.userId })
  if (!agreement.ok) return { ok: false, error: formProblems(agreement.problems) }
  const territory = validateProviderTerritory(input.territory)
  if (!territory.ok) return { ok: false, error: formProblems(territory.problems) }

  // FAIL CLOSED on the encryption key (owner, wave 139): no key → no row, and the platform incident is raised.
  if (!isEncryptionConfigured()) {
    const { raiseSecretStorageIncident } = await import("@/lib/security/credential-rotation")
    const incident = await raiseSecretStorageIncident(svc, { surface: "tenant acquisition provider connect", brokerageId: ctx.brokerageId, code: "secrets_key_missing" })
    // "Support has been told" only when the incident actually notified someone (a deduped or failed raise says nothing).
    return { ok: false, error: presentTenantMessage({
      what: "Connecting your own provider account isn't available yet",
      affects: `Nothing you entered was stored, and your other sources keep working${incident.raised ? ". Platform support has been told" : ""}`,
      next: "platform_support", action: { label: "Contact support" },
    }).sentence }
  }
  const webhookSecret = p.webhook ? randomBytes(24).toString("base64url") : null
  const built = buildTenantProviderCredentialRow(p, {
    brokerageId: ctx.brokerageId, fields: input.fields ?? {}, agreement: agreement.agreement, territory: territory.territory, frequency: input.frequency,
    rateLimitPerDay: Number(input.rateLimitPerDay ?? 0), webhookSecret, sandbox: input.sandbox === true, encrypt: encryptSecret,
  })
  if (!built.ok) return { ok: false, error: formProblems(built.problems) }

  const name = tenantProviderName(p.label)
  const { data: existing, error: existingErr } = await svc.from("platform_credentials").select("id")
    .eq("owner_type", "brokerage").eq("owner_id", ctx.brokerageId).eq("platform", p.provider).maybeSingle()
  if (existingErr) return { ok: false, error: presentTenantError({ what: `Your ${name} connection couldn't be saved`, raw: existingErr, work: { state: "not_saved" }, context: "tenant-connections.acquisition.connect.read" }).sentence }
  const apiKey = (input.fields?.apiKey ?? "").trim()
  // The write site SHOWS the secret column sealed: the pure builder already sealed api_key with encryptSecret, and the row
  // written here re-seals it explicitly after the spread (test:credential-migration adjudicates `builtRow` by name).
  const builtRow = built.row
  const row = { ...builtRow, api_key: encryptSecret(apiKey) }
  const write = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as { id: string }).id).eq("brokerage_id", ctx.brokerageId).select("id")
    : await svc.from("platform_credentials").insert(row).select("id")
  if (write.error) return { ok: false, error: presentTenantError({ what: `Your ${name} connection couldn't be saved`, raw: write.error, work: { state: "not_saved" }, context: "tenant-connections.acquisition.connect.write" }).sentence }
  const rowId = ((write.data ?? []) as Array<{ id: string }>)[0]?.id ?? (existing as { id: string } | null)?.id ?? null
  if (!rowId) return { ok: false, error: presentTenantError({ what: `Your ${name} connection wasn't saved, so nothing is connected`, raw: "the write matched no row", work: { state: "not_saved" }, context: "tenant-connections.acquisition.connect.write" }).sentence }

  // Step 4 — verify LIVE under the tenant's own token: the provider's free account read, never a record purchase, never the
  // platform key. The verdict is written on the row; the state the tenant sees is derived from it.
  let health: NonNullable<TenantProviderConnectionConfig["last_health"]>
  if (p.healthCheck.kind === "free_account_read" && p.provider === "batchdata") {
    const { fetchBatchDataWalletBalance } = await import("@/lib/external/batchdata-client")
    const r = await fetchBatchDataWalletBalance({ apiKey, brokerageId: ctx.brokerageId })
    const f = r.ok ? classifyTenantProviderFailure({ httpStatus: 200 }, p.label) : classifyTenantProviderFailure({ httpStatus: r.httpStatus ?? null, networkError: r.httpStatus === null || r.httpStatus === undefined, message: r.error ?? null }, p.label)
    // The row keeps the INTERNAL detail (status + redacted provider text) for staff; the tenant reads the presenter's view.
    health = { kind: "wallet_balance", status: f.probe, at: new Date().toISOString(), detail: r.ok ? null : f.detail }
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
  const facts = { exists: verified.ok, isActive: verified.ok, testStatus: (health.status === "ok" ? "pass" : "fail") as "pass" | "fail", hasApiKey: true, config: { ...(built.row.config as TenantProviderConnectionConfig), last_health: health } }
  const state = deriveTenantProviderConnectionState(p.provider, facts)
  const view = presentTenantProviderConnection(p.provider, state, facts, payer)
  // Wave 152 (lane 152A): the post-condition is "the connection is CONFIRMED", not "a row exists". Before this a
  // degraded connect (the free account read unreachable / quota / failed) reported ok:true, and the tenant's feed read
  // "Provider connection completed and verified." Now ok only when the provider confirmed it (healthy) or the tenant
  // deliberately connected a test account (sandbox); anything else is routed to the owner with the presenter's sentence,
  // and the owner re-reads THIS row (lib/kernel/immediate-operations.ts recheckCredentialRow) until it holds or a human is told.
  const confirmed = verified.ok && (state.state === "healthy" || state.state === "sandbox")
  await reportOperationOutcome(svc, {
    operation: "provider_connection", brokerageId: ctx.brokerageId, ok: confirmed,
    subjectType: "platform_credentials", subjectId: rowId, actorUserId: ctx.userId, source: "ui",
    evidence: { provider: p.provider, state: state.state, health: health.status, health_detail: health.detail, scopes: agreement.agreement.scopes, cost_payer: "tenant", ...verified.evidence }, error: confirmed ? null : (verified.ok ? `${state.state}: ${state.reason}` : verified.error),
    tenantFacing: confirmed ? null : verified.ok ? view.message.text : `your ${name} connection was saved but could not be confirmed as active — re-enter it from Settings › Integrations › Lead sources`,
  })
  if (!verified.ok) return { ok: false, error: presentTenantError({ what: `Your ${name} connection was saved but couldn't be confirmed as active`, raw: verified.error, next: "you", action: { label: "Update connection" }, context: "tenant-connections.acquisition.connect.verify" }).sentence }
  return { ok: true, state: state.state, view, webhookPath: p.webhook && webhookSecret ? `${p.webhook.path}?${TENANT_WEBHOOK_CONNECTION_PARAM}=${rowId}` : null, webhookSecretOnce: webhookSecret }
}

/** Disconnect (step 13): polls stop, our push secret is revoked, lawful history stays. Counted; a no-match is a failure. */
export async function disconnectTenantAcquisitionProviderAction(provider: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireAdmin("write")
  if (!ctx) return { ok: false, error: adminOnly("Nothing was disconnected") }
  const p = tenantAcquisitionProvider(provider)
  if (!p) return { ok: false, error: "That provider isn't one you can manage here." }
  const name = tenantProviderName(p.label)
  const svc = createServiceClient()
  const { data: row, error: readErr } = await svc.from("platform_credentials").select("id, config")
    .eq("owner_type", "brokerage").eq("owner_id", ctx.brokerageId).eq("platform", p.provider).maybeSingle()
  if (readErr) return { ok: false, error: presentTenantError({ what: `Your ${name} connection couldn't be disconnected right now`, raw: readErr, work: { state: "unchanged" }, context: "tenant-connections.acquisition.disconnect.read" }).sentence }
  if (!row) return { ok: false, error: `${name} isn't connected on this account, so there's nothing to disconnect.` }
  // The patch is the PURE function's (one definition); the write site names the four non-secret columns it carries so the
  // credential-store census can see no secret column is written here (the push secret is revoked INSIDE config).
  const patch = tenantProviderDisconnectPatch(((row as { config?: unknown }).config ?? null) as Partial<TenantProviderConnectionConfig> | null)
  const { data: moved, error } = await svc.from("platform_credentials")
    .update({ is_active: patch.is_active, test_status: patch.test_status, updated_at: patch.updated_at, config: patch.config })
    .eq("id", (row as { id: string }).id).eq("brokerage_id", ctx.brokerageId).select("id")
  if (error) return { ok: false, error: presentTenantError({ what: `Your ${name} connection couldn't be disconnected right now`, raw: error, work: { state: "unchanged" }, context: "tenant-connections.acquisition.disconnect.write" }).sentence }
  if ((moved ?? []).length !== 1) return { ok: false, error: presentTenantError({ what: `Your ${name} connection couldn't be disconnected right now`, raw: "the disconnect matched no row", work: { state: "unchanged" }, context: "tenant-connections.acquisition.disconnect.write" }).sentence }
  const { reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
  await reportOperationOutcome(svc, {
    operation: "provider_connection", brokerageId: ctx.brokerageId, ok: true, subjectType: "platform_credentials", subjectId: (row as { id: string }).id, actorUserId: ctx.userId, source: "ui",
    evidence: { provider: p.provider, action: "disconnect", polls_stopped: true, push_secret_revoked: true, history_kept: true }, error: null, tenantFacing: null,
  })
  return { ok: true }
}
