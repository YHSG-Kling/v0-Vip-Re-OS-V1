// lib/providers/tenant-provider-connections.ts
//
// TENANT-OWNED ACQUISITION PROVIDER CONNECTIONS — route B of the two authorized provider routes (wave 151, lane 151F;
// directive 151F "Tenant-connected account", the 14-step setup / runtime contract). PURE where it decides and THIN where it
// writes: no client of its own, no network, no credential read, no `server-only`. Every I/O door is injected (`deps`), so the
// in-memory proofs drive the same code the webhook route runs.
//
// NOT A NEW CONNECTION SYSTEM (OS-CONSTITUTION LAW 1 / LAW 2). The survivors it composes, none re-spelled:
//   · the credential VAULT — platform_credentials (owner_type / owner_id scoped), written encrypted (lib/security/secret-crypto.ts
//     encryptSecret, FAIL CLOSED without SECRETS_ENCRYPTION_KEY), read back through the ownership cascade
//     (lib/connections/resolve-scoped.ts → lib/integrations/connection-manager.ts, a refused read STOPS the walk), watched by
//     lib/security/credential-rotation.ts; the tenant writer is app/actions/tenant-connections.ts on Settings → Integrations →
//     Lead sources (the surface the owner ruled is where a tenant finishes its OWN vendor connections);
//   · the provider REGISTRY / ROUTE TABLE — CONTACT_PROVIDER_ROUTES + PROVIDER_ACTIVATION (lib/ai-isa/property-lookup-rail.ts) and
//     the scorecard over them (lib/providers/provider-scorecard.ts). A provider the platform keeps DORMANT PENDING RIGHTS has no
//     transport in this repo, so a tenant cannot connect it either — the state says so honestly (`unsupported`), never a form
//     that stores a key nothing can use ("an adapter file or dummy response is not a working integration");
//   · the capability ADAPTER — lib/external/batchdata-client.ts (the ONE BatchData transport) now takes a tenant key by
//     parameter (`apiKey`) and never falls through to the platform key when a tenant key is named;
//   · the ONE RawData intake — lib/kernel/scraping.ts ingestRawSourceBatch (brokerageId = the tenant → source_origin 'brokerage';
//     the m961 scope-qualified idempotency key makes a replayed delivery ONE observation); the record's own rights derive from
//     the source key (source-intent-map sourceRightsFor), exactly as for a platform pull;
//   · the COST ledger — vendor_usage_tracking through meterVendorSpend with coverage 'tenant_paid' (lib/vendor-governance/
//     cost-normalizer.ts CostCoverage): a tenant-owned call is the tenant's expense with its provider, never a platform lead
//     purchase and never a platform-paid row;
//   · the inbound WEBHOOK contract — lib/providers/webhook-contract.ts; the push transport is the EXISTING
//     app/api/webhooks/batchdata-smart-search route, which now also serves a tenant's own subscription under
//     `?connection=<credential id>` verified against THAT connection's signing secret (minted by us at connect time, stored
//     encrypted, compared timing-safe) — a platform delivery and a tenant delivery never share a secret;
//   · the dead-letter — lib/kernel/ingress-continuity.ts parkIngressEvent (a delivery the provider cannot be asked about now
//     is PARKED with its external id, never dropped and never ingested unverified).
//
// WHAT IS NEVER HERE: a generic "paste any API" field (only the documented auth of a named provider), a platform credential
// (the platform's own BatchData account is env-held and reached by the cron / pooled lanes — route A), a price (the tenant's
// bill is its provider's), a second intake or a second ledger.

import { timingSafeEqual } from "node:crypto"
import { PROVIDER_ACTIVATION, type ScorecardProvider } from "@/lib/ai-isa/property-lookup-rail"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import type { IngestRawSourceBatchParams, IngestBatchResult } from "@/lib/kernel/scraping"
import type { MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"

// ─── the catalogue ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The documented ways a tenant may authorize a named provider. Never a free-text "any API" field. */
export type TenantProviderTransport = "api_key" | "signed_webhook" | "oauth" | "file_import"

/**
 * THE CONNECTION STATE VOCABULARY (directive step 11) — one spelling per idea (CLAUDE.md §6). Derived, never stored:
 *   unavailable               not an acquisition provider this OS knows — nothing to connect, no generic field offered
 *   unsupported               a known provider with NO transport in this repo (a dormant adapter is documentation, not ingestion)
 *   unconfigured              a connectable provider the tenant has not connected (or whose agreement is incomplete)
 *   sandbox                   connected against the provider's sandbox / test account — never a production source
 *   pending_owner_licensing   a transport exists but the platform keeps the provider dormant pending rights — a tenant key
 *                             is not offered until the owner's licensing decision (lib/ai-isa/property-lookup-rail.ts)
 *   healthy                   connected, agreement complete, the free health read answered under the tenant's own key
 *   degraded                  connected but the last verification failed for a reason that is not a revocation (quota,
 *                             unreachable, shape drift, not yet verified) — the queue is kept, polling retries
 *   revoked                   disconnected by the tenant, or the provider refused the credential (401/403) — nothing polls,
 *                             nothing is accepted on the webhook, history is kept
 */
/** @proofSeam the eight-member vocabulary as a VALUE for scripts/tenant-provider-connections-guard.ts (product code uses the type) */
export const TENANT_PROVIDER_CONNECTION_STATES = [
  "unavailable", "unsupported", "unconfigured", "sandbox", "pending_owner_licensing", "healthy", "degraded", "revoked",
] as const
export type TenantProviderConnectionState = (typeof TENANT_PROVIDER_CONNECTION_STATES)[number]

export interface TenantProviderField { key: string; label: string; secret?: boolean; required: boolean; placeholder?: string }

export interface TenantAcquisitionProvider {
  /** The platform_credentials.platform value (m975 admits it) — the SAME canonical provider id the route table uses. */
  provider: ScorecardProvider
  label: string
  /** Transports the adapter in THIS repo implements for a TENANT key. Empty = nothing can ingest (state `unsupported`). */
  transports: readonly TenantProviderTransport[]
  adapter: {
    state: "transport_built" | "no_transport"
    /** Repo-relative module of the transport, or the dormant documented-fields mapper. */
    module: string
    /** The parameter the transport takes the tenant key through — a SYMBOL the proof requires in stripped source. */
    tenantKeyParam: string | null
  }
  /** The DOCUMENTED credential fields (the provider's own vocabulary) — never a generic API field. */
  fields: readonly TenantProviderField[]
  /** Capabilities a tenant key may be spent on — route-table names, so the agreement's scopes are a closed set. */
  capabilities: readonly string[]
  /** The source keys ingested records ride (the producer derives rights + license from them). */
  sourceKeys: readonly string[]
  /** Step 4: how the key is verified without spend — by NAME (the function the connect action calls). */
  healthCheck: { kind: "free_account_read" | "none"; what: string }
  rights: { licenseId: string; retentionMaxDays: number | null; redistribution: "prohibited" }
  /** Documentation read (host/path, no scheme — evidence, never an endpoint this module calls). */
  docs: string
  pricing: { payer: "tenant"; note: string }
  /** The push door, when the provider pushes: the EXISTING route and the event kinds it accepts. */
  webhook: { path: string; eventKinds: readonly string[]; secretHeader: string } | null
  /** Why this provider sits where it does in the catalogue. */
  why: string
}

/** Where a tenant webhook delivery names its connection (the credential row id), verified against THAT row's secret. */
export const TENANT_WEBHOOK_CONNECTION_PARAM = "connection"
export const TENANT_WEBHOOK_SECRET_HEADER = "x-webhook-secret"

export const TENANT_ACQUISITION_PROVIDERS: Readonly<Record<string, TenantAcquisitionProvider>> = Object.freeze({
  batchdata: {
    provider: "batchdata",
    label: "BatchData (your own account)",
    transports: ["api_key", "signed_webhook"],
    adapter: { state: "transport_built", module: "lib/external/batchdata-client.ts", tenantKeyParam: "apiKey" },
    fields: [
      { key: "apiKey", label: "BatchData API token (server-side token from app.batchdata.io → API tokens)", secret: true, required: true },
      { key: "accountLabel", label: "Account label (shown to your staff — never the token)", required: false, placeholder: "Acme Realty BatchData" },
    ],
    capabilities: ["motivated_seller_list", "owner_contact", "property_facts", "dnc_tcpa"],
    sourceKeys: ["batchdata_smart_search", "batchdata_motivated"],
    healthCheck: { kind: "free_account_read", what: "wallet/balance GET under the tenant's token (fetchBatchDataWalletBalance({ apiKey })) — an account read, no record is bought" },
    rights: { licenseId: "batchdata_api_terms", retentionMaxDays: null, redistribution: "prohibited" },
    docs: "developer.batchdata.com (Property Search, Property Lookup, Smart Search push — read 2026-09-16 / 2026-11-09)",
    pricing: { payer: "tenant", note: "BatchData bills the tenant's own token per record / per match on its own plan; this OS books the tenant-paid units for the tenant's view and never a platform purchase" },
    webhook: { path: "/api/webhooks/batchdata-smart-search", eventKinds: ["smart-search-match"], secretHeader: TENANT_WEBHOOK_SECRET_HEADER },
    why: "The ONE acquisition provider with a real transport in this repo (lib/external/batchdata-client.ts). The platform account is a dormant survivor under owner ruling R9 (route A); a tenant that holds its OWN BatchData account connects it here (tenancy model tenant_optional_key — the IDX Broker mirror) and pays BatchData directly.",
  },
  propertyradar: {
    provider: "propertyradar",
    label: "PropertyRadar",
    transports: [],
    adapter: { state: "no_transport", module: "lib/providers/dormant-adapters.ts", tenantKeyParam: null },
    fields: [],
    capabilities: ["acquisition_preview", "seller_signal_score", "owner_contact"],
    sourceKeys: [],
    healthCheck: { kind: "none", what: "no transport — nothing to verify" },
    rights: { licenseId: "propertyradar_partner_terms_unverified", retentionMaxDays: null, redistribution: "prohibited" },
    docs: "owner-installed propertyradar-api playbook (read 2026-11-06)",
    pricing: { payer: "tenant", note: "credits on the tenant's PropertyRadar account; unpublished per-record price" },
    webhook: null,
    why: "Dormant pending rights (R9): only the documented-fields mapper exists; no request is built anywhere in this repo. Offering a key field would store a credential nothing can use.",
  },
  tracerfy: {
    provider: "tracerfy",
    label: "Tracerfy",
    transports: [],
    adapter: { state: "no_transport", module: "lib/providers/dormant-adapters.ts", tenantKeyParam: null },
    fields: [],
    capabilities: ["owner_contact", "dnc_tcpa", "seller_signal_score"],
    sourceKeys: [],
    healthCheck: { kind: "none", what: "no transport — nothing to verify" },
    rights: { licenseId: "tracerfy_tos_internal_use", retentionMaxDays: null, redistribution: "prohibited" },
    docs: "tracerfy.com/terms-of-service (effective 2026-01-03); tracerfy.com/faqs",
    pricing: { payer: "tenant", note: "credits on the tenant's Tracerfy account" },
    webhook: null,
    why: "Dormant pending rights (R9) — a pilot candidate with no transport until the matched pilot and written platform-use confirmation.",
  },
  datazapp: {
    provider: "datazapp",
    label: "DataZapp",
    transports: [],
    adapter: { state: "no_transport", module: "lib/providers/dormant-adapters.ts", tenantKeyParam: null },
    fields: [],
    capabilities: ["owner_contact", "online_presence", "seller_signal_score"],
    sourceKeys: [],
    healthCheck: { kind: "none", what: "no transport — nothing to verify" },
    rights: { licenseId: "datazapp_terms_no_written_license", retentionMaxDays: null, redistribution: "prohibited" },
    docs: "datazapp.com/termsandcondition; knowledgebase.datazapp.com/apis (read 2026-11-03)",
    pricing: { payer: "tenant", note: "prepaid API balance on the tenant's DataZapp account" },
    webhook: null,
    why: "Dormant pending rights (R9) — the Terms grant no license in writing; no transport is built.",
  },
})

/** PURE — the catalogue entry, or null for a provider this OS does not know as an acquisition source. */
export function tenantAcquisitionProvider(provider: string): TenantAcquisitionProvider | null {
  return TENANT_ACQUISITION_PROVIDERS[(provider ?? "").trim().toLowerCase()] ?? null
}

// ─── step 5: the agreement / authorization capture ──────────────────────────────────────────────────────────────────

/** What a tenant attests when it connects its OWN account. Stored verbatim at platform_credentials.config.agreement. */
export interface TenantProviderAgreement {
  /** Capabilities the tenant allows this key to be spent on — a subset of the catalogue's capabilities. */
  scopes: string[]
  /** The tenant holds its own account under the provider's terms and authorizes this OS to call it on its behalf. */
  license_acknowledged: true
  /** How long ingested provider records may be retained (days) — the tenant's own retention term. */
  retention_days: number
  /** Whether the AI managers may process the records (the AI ISA works the Lead; false = records land as RawData only). */
  ai_processing_permitted: boolean
  /** Provider records are never redistributed beyond this tenant. The only admitted value. */
  redistribution: "prohibited"
  /** The provider bills the tenant. The only admitted value — the platform never pays for a tenant-owned connection. */
  cost_payer: "tenant"
  accepted_by_user_id: string
  accepted_at: string
}

const MAX_RETENTION_DAYS = 3650

/**
 * PURE — validate the tenant's agreement for one provider. Refuses: an unknown provider, a scope outside the catalogue,
 * a missing attestation, a platform cost payer, any redistribution, a retention outside (0, 10 years] or above the
 * provider's own maximum, no accepting user. Never fills a field the tenant did not state.
 */
export function validateProviderAgreement(
  provider: string,
  input: unknown,
  ctx: { userId: string; now?: Date },
): { ok: true; agreement: TenantProviderAgreement } | { ok: false; problems: string[] } {
  const problems: string[] = []
  const p = tenantAcquisitionProvider(provider)
  if (!p) return { ok: false, problems: [`${provider}: not a supported acquisition provider`] }
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === "string") : []
  if (scopes.length === 0) problems.push("scopes: name at least one capability this key may be spent on")
  for (const s of scopes) if (!p.capabilities.includes(s)) problems.push(`scopes: "${s}" is not a capability ${p.label} sells (${p.capabilities.join(", ")})`)
  if (raw.license_acknowledged !== true) problems.push("license_acknowledged: the tenant must attest it holds its own account under the provider's terms")
  const retention = Number(raw.retention_days)
  if (!Number.isInteger(retention) || retention <= 0 || retention > MAX_RETENTION_DAYS) problems.push(`retention_days: a whole number of days between 1 and ${MAX_RETENTION_DAYS}`)
  else if (p.rights.retentionMaxDays !== null && retention > p.rights.retentionMaxDays) problems.push(`retention_days: ${p.label} permits at most ${p.rights.retentionMaxDays} days`)
  if (typeof raw.ai_processing_permitted !== "boolean") problems.push("ai_processing_permitted: state whether the AI managers may process these records")
  if (raw.redistribution !== "prohibited") problems.push("redistribution: provider records are never redistributed — the only admitted value is \"prohibited\"")
  if (raw.cost_payer !== "tenant") problems.push("cost_payer: a tenant-owned connection is billed by the provider to the tenant — the only admitted value is \"tenant\"")
  if (!ctx.userId) problems.push("accepted_by_user_id: no accepting user (the session actor)")
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    agreement: {
      scopes: Array.from(new Set(scopes)), license_acknowledged: true, retention_days: retention,
      ai_processing_permitted: raw.ai_processing_permitted === true, redistribution: "prohibited", cost_payer: "tenant",
      accepted_by_user_id: ctx.userId, accepted_at: (ctx.now ?? new Date()).toISOString(),
    },
  }
}

// ─── step 7: territory / frequency / rate limits ────────────────────────────────────────────────────────────────────

export type TenantProviderFrequency = "push" | "daily" | "weekly"
export const TENANT_PROVIDER_FREQUENCIES: readonly TenantProviderFrequency[] = ["push", "daily", "weekly"]

export interface TenantProviderTerritory { state: string; zip_codes: string[]; city: string | null }

/** PURE — a territory the tenant's records are gated by (the producer's own recordMatchesTerritory reads this shape). */
export function validateProviderTerritory(input: unknown): { ok: true; territory: TenantProviderTerritory } | { ok: false; problems: string[] } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const problems: string[] = []
  const state = typeof raw.state === "string" ? raw.state.trim().toUpperCase() : ""
  if (!/^[A-Z]{2}$/.test(state)) problems.push("territory.state: a two-letter state")
  const zips = Array.isArray(raw.zip_codes) ? raw.zip_codes.map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z)) : []
  if (zips.length === 0) problems.push("territory.zip_codes: at least one five-digit ZIP (a tenant-owned source is still territory-gated)")
  const city = typeof raw.city === "string" && raw.city.trim() ? raw.city.trim() : null
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, territory: { state, zip_codes: Array.from(new Set(zips)), city } }
}

// ─── the credential row (steps 3 + 6 + 7) ───────────────────────────────────────────────────────────────────────────

export interface TenantProviderConnectionConfig {
  agreement: TenantProviderAgreement
  territory: TenantProviderTerritory
  frequency: TenantProviderFrequency
  /** Records accepted per UTC day across the connection's doors (0 = no cap stated → the provider's own limits only). */
  rate_limit_per_day: number
  /** OUR signing secret for the push door, encrypted (enc:v1). null once disconnected (revoked) — nothing is accepted. */
  webhook_secret: string | null
  account_label: string | null
  cost_payer: "tenant"
  coverage: "tenant_paid"
  connected_via: "settings_lead_sources"
  sandbox: boolean
  disconnected_at: string | null
  /** The last free health read, by NAME and verdict — never a value. */
  last_health: { kind: string; status: TenantProviderProbeStatus; at: string; detail: string | null } | null
}

export type TenantProviderProbeStatus = "ok" | "auth_failed" | "quota" | "unreachable" | "shape_drift" | "not_configured"

/**
 * PURE — the platform_credentials row a tenant-owned connection writes. The caller passes the ENCRYPTOR (encryptSecret —
 * it throws without SECRETS_ENCRYPTION_KEY, so the connect action refuses before any row exists; this module never reads
 * env). `api_key`, and the webhook signing secret inside config, are the only secrets, and both are encrypted.
 */
export function buildTenantProviderCredentialRow(
  provider: TenantAcquisitionProvider,
  input: {
    brokerageId: string
    fields: Record<string, string>
    agreement: TenantProviderAgreement
    territory: TenantProviderTerritory
    frequency: TenantProviderFrequency
    rateLimitPerDay: number
    /** The plaintext signing secret this OS minted for the push door (null for a provider with no push). */
    webhookSecret: string | null
    sandbox: boolean
    encrypt: (plaintext: string) => string
    now?: Date
  },
): { ok: true; row: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (provider.adapter.state !== "transport_built") problems.push(`${provider.label}: no transport — a credential would be stored for nothing`)
  if (!TENANT_PROVIDER_FREQUENCIES.includes(input.frequency)) problems.push(`frequency: one of ${TENANT_PROVIDER_FREQUENCIES.join(" / ")}`)
  if (input.frequency === "push" && !provider.webhook) problems.push(`${provider.label} has no push door — choose daily or weekly`)
  if (!Number.isInteger(input.rateLimitPerDay) || input.rateLimitPerDay < 0) problems.push("rate_limit_per_day: a whole number ≥ 0")
  const values: Record<string, string> = {}
  for (const f of provider.fields) {
    const v = (input.fields[f.key] ?? "").trim()
    if (f.required && v.length < 6) problems.push(`${f.label}: required`)
    if (v) values[f.key] = v
  }
  if (problems.length > 0) return { ok: false, problems }
  const now = (input.now ?? new Date()).toISOString()
  const config: TenantProviderConnectionConfig = {
    agreement: input.agreement, territory: input.territory, frequency: input.frequency, rate_limit_per_day: input.rateLimitPerDay,
    webhook_secret: input.webhookSecret ? input.encrypt(input.webhookSecret) : null,
    account_label: values.accountLabel ?? null, cost_payer: "tenant", coverage: "tenant_paid", connected_via: "settings_lead_sources",
    sandbox: input.sandbox, disconnected_at: null, last_health: null,
  }
  return {
    ok: true,
    row: {
      brokerage_id: input.brokerageId, owner_type: "brokerage", owner_id: input.brokerageId, scope: "brokerage", agent_user_id: null,
      platform: provider.provider, api_key: input.encrypt(values.apiKey), account_name: values.accountLabel ?? null,
      config, is_active: true, test_status: "pending", updated_at: now,
    },
  }
}

/** PURE — the fields a disconnect writes (step 13): polls stop (inactive), our push secret is revoked, history stays. */
export function tenantProviderDisconnectPatch(config: Partial<TenantProviderConnectionConfig> | null, now: Date = new Date()): Record<string, unknown> {
  return {
    is_active: false, test_status: "fail", updated_at: now.toISOString(),
    config: { ...(config ?? {}), webhook_secret: null, disconnected_at: now.toISOString() },
  }
}

// ─── step 11: the derived connection state ──────────────────────────────────────────────────────────────────────────

export interface TenantProviderCredentialFacts {
  exists: boolean
  isActive: boolean
  testStatus: "pass" | "fail" | "pending" | null
  hasApiKey: boolean
  config: Partial<TenantProviderConnectionConfig> | null
}

export interface TenantProviderConnectionVerdict {
  state: TenantProviderConnectionState
  reason: string
  /** What the tenant (or the owner) can do about it, or null when nothing is owed. */
  actionable: string | null
  /** Whether a scheduled poll / a push delivery may be served RIGHT NOW. Only healthy and degraded serve. */
  mayIngest: boolean
}

/**
 * PURE — THE ONE derivation of a tenant provider connection's state (directive step 11). Order is the ruling:
 * unknown → unavailable; no transport → unsupported; transport but the platform keeps it pending rights →
 * pending_owner_licensing; no row → unconfigured; disconnected / inactive / provider refused the key → revoked;
 * sandbox → sandbox; agreement incomplete → unconfigured; last health quota / unreachable / drift / never verified →
 * degraded; verified → healthy.
 */
export function deriveTenantProviderConnectionState(provider: string, facts: TenantProviderCredentialFacts | null): TenantProviderConnectionVerdict {
  const p = tenantAcquisitionProvider(provider)
  if (!p) return { state: "unavailable", reason: `${provider} is not an acquisition provider this OS can connect — there is no generic API field`, actionable: null, mayIngest: false }
  if (p.adapter.state !== "transport_built" || p.transports.length === 0) {
    const a = PROVIDER_ACTIVATION[p.provider]
    return { state: "unsupported", reason: `${p.label}: no transport in this repo (${p.adapter.module} maps documented fields only; platform state ${a.state} — ${a.rights.summary})`, actionable: "an activation is a reviewed change: contract, measured incremental coverage, unit economics, a route row and a transport together", mayIngest: false }
  }
  const activation = PROVIDER_ACTIVATION[p.provider]
  if (activation.state === "dormant_pending_rights") {
    return { state: "pending_owner_licensing", reason: `${p.label}: the platform keeps this provider dormant pending rights (${activation.rights.status}) — a tenant key is not offered until the owner's licensing decision`, actionable: "owner decision on the provider's rights (docs/operations/OWNER-SQL.md)", mayIngest: false }
  }
  if (!facts || !facts.exists) return { state: "unconfigured", reason: `${p.label} is not connected for this brokerage`, actionable: "connect your own account under Settings → Integrations → Lead sources", mayIngest: false }
  const cfg = facts.config ?? null
  if (cfg?.disconnected_at || !facts.isActive) return { state: "revoked", reason: `${p.label} was disconnected${cfg?.disconnected_at ? ` on ${cfg.disconnected_at}` : ""} — polls stopped, the push door refuses, history kept`, actionable: "reconnect with a fresh token to resume", mayIngest: false }
  if (cfg?.last_health?.status === "auth_failed") return { state: "revoked", reason: `${p.label} refused the stored token (${cfg.last_health.at}) — the provider revoked or rotated it`, actionable: "rotate the token at the provider and reconnect", mayIngest: false }
  if (!facts.hasApiKey) return { state: "unconfigured", reason: `${p.label}: the row carries no token`, actionable: "reconnect", mayIngest: false }
  const agreement = cfg?.agreement ? validateProviderAgreement(p.provider, cfg.agreement, { userId: cfg.agreement.accepted_by_user_id }) : null
  if (!agreement || !agreement.ok) return { state: "unconfigured", reason: `${p.label}: the agreement is incomplete${agreement && !agreement.ok ? ` (${agreement.problems.join("; ")})` : ""}`, actionable: "reconnect and complete the agreement (scopes, retention, AI processing, cost payer)", mayIngest: false }
  if (cfg?.sandbox === true) return { state: "sandbox", reason: `${p.label} is connected to a sandbox / test account — records are test data, never a production source`, actionable: "connect the production token when ready", mayIngest: false }
  const h = cfg?.last_health ?? null
  if (!h || facts.testStatus === "pending") return { state: "degraded", reason: `${p.label}: saved, not yet verified against the provider (${p.healthCheck.what})`, actionable: "the next verification runs on connect / the connector-health sweep", mayIngest: true }
  if (h.status === "quota") return { state: "degraded", reason: `${p.label}: the provider reported a quota / balance limit (${h.at}) — the queue is kept and retried next cycle`, actionable: "top up or raise the limit at the provider", mayIngest: true }
  if (h.status === "unreachable") return { state: "degraded", reason: `${p.label}: unreachable at the last verification (${h.at}) — retried next cycle`, actionable: null, mayIngest: true }
  if (h.status === "shape_drift") return { state: "degraded", reason: `${p.label}: the response shape drifted (${h.at}) — the connector healer reviews it`, actionable: null, mayIngest: true }
  if (h.status === "not_configured" || facts.testStatus === "fail") return { state: "degraded", reason: `${p.label}: the last verification failed (${h.detail ?? h.status})`, actionable: "reconnect", mayIngest: false }
  return { state: "healthy", reason: `${p.label}: verified under your own token (${h.kind}, ${h.at})`, actionable: null, mayIngest: true }
}

// ─── step 8: the cost booking — the tenant's expense, never a platform purchase ─────────────────────────────────────

/**
 * PURE — the ledger booking for a tenant-owned provider call: coverage 'tenant_paid', pinned to the tenant, NEVER platformPaid.
 * The number is what the provider will bill the tenant (documented unit × units, cost_basis estimated) — it is the tenant's
 * expense shown accurately in settings, not a charge this platform raises. A caller that passes `usd` null books the units
 * with price_state 'unknown' rather than guessing. Called by ingestTenantWebhookDelivery below (the push door's booking).
 * @proofSeam scripts/tenant-provider-connections-guard.ts section D asserts the booking shape directly (coverage, pin, no platformPaid)
 */
export function tenantProviderSpendBooking(
  provider: TenantAcquisitionProvider,
  input: { brokerageId: string; connectionId: string; sourceKey: string; units: number; usd: number | null; idempotencyKey: string; systemSource?: string; metadata?: Record<string, unknown> },
): MeterVendorInput {
  return {
    vendorName: provider.provider,
    usageType: input.sourceKey,
    cost: input.usd ?? 0,
    unitCount: Math.max(1, Math.floor(input.units)),
    brokerageId: input.brokerageId,
    priceState: input.usd === null ? "unknown" : undefined,
    costBasis: "estimated",
    coverage: "tenant_paid",
    idempotencyKey: input.idempotencyKey,
    systemSource: input.systemSource ?? "tenant_provider_connection",
    metadata: { ...(input.metadata ?? {}), cost_payer: "tenant", connection_id: input.connectionId, credential_scope: "brokerage", source_key: input.sourceKey },
  }
}

// ─── step 12: error / expiry / quota — recover, notify, never leak ──────────────────────────────────────────────────

export interface TenantProviderFailureVerdict {
  probe: TenantProviderProbeStatus
  /** The connection state the failure implies (the derivation above reads it back from config.last_health). */
  state: Extract<TenantProviderConnectionState, "healthy" | "degraded" | "revoked">
  action: "none" | "retry_next_cycle" | "hold_queue" | "reconnect"
  notify: "tenant_admin" | "platform_staff" | null
  /** Safe to show the tenant / put in a notification — no secret, no platform internals. */
  tenantMessage: string
}

/** PURE — strip anything that looks like a credential from a provider error before it is stored or shown. */
export function redactProviderSecrets(text: string | null | undefined): string {
  if (!text) return ""
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(sk|key|token|secret)[-_=:\s]+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]")
    .replace(/enc:v1:[A-Za-z0-9+/=:]+/g, "enc:v1:[redacted]")
    .slice(0, 400)
}

/** PURE — classify one provider failure (an HTTP status, a transport error) into recovery + notification. */
export function classifyTenantProviderFailure(f: { httpStatus: number | null; networkError?: boolean; shapeDrift?: boolean; message?: string | null }, label = "the provider"): TenantProviderFailureVerdict {
  const msg = redactProviderSecrets(f.message)
  if (f.httpStatus === 401 || f.httpStatus === 403) {
    return { probe: "auth_failed", state: "revoked", action: "reconnect", notify: "tenant_admin", tenantMessage: `${label} refused your token (HTTP ${f.httpStatus}). Polling has stopped and pushed deliveries are refused until you reconnect with a valid token. Nothing was lost: queued deliveries are kept.` }
  }
  if (f.httpStatus === 402 || f.httpStatus === 429) {
    return { probe: "quota", state: "degraded", action: "hold_queue", notify: "tenant_admin", tenantMessage: `${label} reported a quota or balance limit (HTTP ${f.httpStatus}). Deliveries are held and retried next cycle; top up or raise the limit at ${label}.` }
  }
  if (f.networkError || f.httpStatus === null || f.httpStatus >= 500) {
    return { probe: "unreachable", state: "degraded", action: "retry_next_cycle", notify: null, tenantMessage: `${label} was unreachable${msg ? ` (${msg})` : ""}. The queue is kept and retried next cycle.` }
  }
  if (f.shapeDrift) {
    return { probe: "shape_drift", state: "degraded", action: "retry_next_cycle", notify: "platform_staff", tenantMessage: `${label} changed its response shape; platform staff are reviewing the connector. Deliveries are kept.` }
  }
  if (f.httpStatus >= 400) {
    return { probe: "unreachable", state: "degraded", action: "retry_next_cycle", notify: "platform_staff", tenantMessage: `${label} answered HTTP ${f.httpStatus}${msg ? ` (${msg})` : ""}. Deliveries are kept and retried.` }
  }
  return { probe: "ok", state: "healthy", action: "none", notify: null, tenantMessage: `${label} verified.` }
}

// ─── step 9: the signed push door ───────────────────────────────────────────────────────────────────────────────────

/** PURE — the connection id a tenant delivery names on the EXISTING route (`?connection=<credential id>`), or null (platform). */
export function tenantWebhookConnectionId(url: string | URL): string | null {
  try {
    const u = typeof url === "string" ? new URL(url) : url
    const v = (u.searchParams.get(TENANT_WEBHOOK_CONNECTION_PARAM) ?? "").trim()
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null
  } catch { return null }
}

/**
 * PURE — verify a presented secret against THE connection's own (decrypted) signing secret, timing-safe. A connection
 * without a secret (disconnected, or never minted) refuses everything — a missing secret is never "anything goes".
 */
export function verifyTenantWebhookSecret(expected: string | null | undefined, presented: string | null | undefined): "ok" | "no_secret_configured" | "mismatch" {
  if (!expected) return "no_secret_configured"
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(presented ?? "", "utf8")
  if (a.length === 0 || a.length !== b.length) return "mismatch"
  try { return timingSafeEqual(a, b) ? "ok" : "mismatch" } catch { return "mismatch" }
}

/** One documented BatchData Smart Search push event (ids only — the full record is a separate Property Lookup). */
export interface SmartSearchEvent {
  eventId?: string
  subscriberId?: string
  propertyId?: string
  parcelHash?: string
  addressHash?: string
  propertyChangedAt?: string
  addedToSubscriptionIds?: string[]
  removedFromSubscriptionIds?: string[]
}

/** PURE — an ids-only push event (carries neither of the full record's top-level shapes). */
export function isIdsOnlySmartSearchEvent(row: unknown): row is SmartSearchEvent {
  return !!row && typeof row === "object" && typeof (row as Record<string, unknown>).propertyId === "string" &&
    !(row as Record<string, unknown>).address && !(row as Record<string, unknown>).owner
}

/**
 * PURE — the event array out of any of the payload envelopes BatchData has shipped (documented ids-only events, plus the
 * inline-record fallbacks wave 65 kept). ONE reading for the platform door and the tenant door.
 */
export function extractSmartSearchEvents(payload: unknown): Array<Record<string, unknown>> {
  const p = payload as Record<string, unknown> | unknown[] | null
  const anyP = p as Record<string, any> | null
  return Array.isArray(anyP?.results?.properties) ? anyP!.results.properties
    : Array.isArray(anyP?.matches) ? anyP!.matches
      : Array.isArray(anyP?.events) ? anyP!.events
        : Array.isArray(anyP?.properties) ? anyP!.properties
          : Array.isArray(anyP?.results) ? anyP!.results
            : Array.isArray(p) ? (p as Array<Record<string, unknown>>)
              : p && typeof p === "object" ? [p as Record<string, unknown>]
                : []
}

export interface TenantProviderConnectionRow {
  id: string
  brokerage_id: string
  platform: string
  is_active: boolean
  test_status: "pass" | "fail" | "pending" | null
  /** DECRYPTED by the caller (resolve-scoped / decryptSecret) — this module never decrypts. */
  apiKey: string | null
  config: Partial<TenantProviderConnectionConfig> | null
}

export interface TenantWebhookIngestDeps {
  /** The tenant-keyed hydrate (lookupBatchDataPropertiesByIds with { apiKey, brokerageId }). */
  hydrate: (ids: string[], apiKey: string) => Promise<{ ok: boolean; properties: Array<Record<string, unknown>>; cost: number; error?: string; httpStatus?: number | null }>
  normalize: (raw: Record<string, unknown>, geo: { city: string | null; state: string | null }) => NormalizedScrapedRecord
  /** THE ONE RawData producer (lib/kernel/scraping.ts ingestRawSourceBatch). */
  ingest: (p: IngestRawSourceBatchParams) => Promise<IngestBatchResult>
  /** THE ONE vendor-spend gateway (meterVendorSpend). */
  book: (input: MeterVendorInput) => Promise<boolean>
  /** The dead-letter (parkIngressEvent). Absent = deliveries that cannot be hydrated are reported, not parked. */
  park?: (p: { provider: string; eventKind: string; externalRef: string; payload: Record<string, unknown> }) => Promise<{ parked: boolean }>
  now?: Date
}

export interface TenantWebhookIngestReport {
  ok: boolean
  connectionState: TenantProviderConnectionState
  received: number
  hydrated: number
  inserted: number
  replayed: number
  skippedTerritory: number
  parked: number
  held: number
  tenantPaidUsd: number
  /** Why nothing was ingested (a refused connection, a revoked token, a rate limit) — safe for the tenant. */
  refused: string | null
  /** What the row should record about this delivery's verification (the caller writes it; this module decides it). */
  healthPatch: { test_status: "pass" | "fail"; last_health: NonNullable<TenantProviderConnectionConfig["last_health"]> } | null
  notify: TenantProviderFailureVerdict["notify"]
}

type Svc = { from: (table: string) => any }

/**
 * THE TENANT PUSH INGEST (steps 9, 10, 12). Verified delivery → connection state must admit ingestion → the connection's own
 * rate limit → hydrate under the TENANT's key (a failure is classified: revoked → the row is marked and nothing is ingested;
 * quota / unreachable → the delivery is PARKED with its external id for the daily replay) → every record is normalized with
 * the provider's own event id as its idempotency anchor → THE ONE producer (brokerageId = the tenant, marketId null, the
 * connection's territory as the gate, actor webhook:tenant:<connection>) → the hydrate spend is booked tenant_paid.
 * A replayed delivery is ONE observation (the m961 key refuses the second row and counts it `replayed`).
 */
export async function ingestTenantWebhookDelivery(svc: Svc, connection: TenantProviderConnectionRow, events: Array<Record<string, unknown>>, deps: TenantWebhookIngestDeps): Promise<TenantWebhookIngestReport> {
  const now = deps.now ?? new Date()
  const p = tenantAcquisitionProvider(connection.platform)
  const facts: TenantProviderCredentialFacts = { exists: true, isActive: connection.is_active, testStatus: connection.test_status, hasApiKey: !!connection.apiKey, config: connection.config }
  const verdict = deriveTenantProviderConnectionState(connection.platform, facts)
  const base: TenantWebhookIngestReport = { ok: false, connectionState: verdict.state, received: events.length, hydrated: 0, inserted: 0, replayed: 0, skippedTerritory: 0, parked: 0, held: 0, tenantPaidUsd: 0, refused: null, healthPatch: null, notify: null }
  if (!p || !p.webhook) return { ...base, refused: `${connection.platform}: no push door` }
  if (!verdict.mayIngest || !connection.apiKey) return { ...base, refused: `connection ${verdict.state}: ${verdict.reason}` }
  if (events.length === 0) return { ...base, ok: true }

  const cfg = connection.config ?? {}
  const territory = cfg.territory ?? null
  if (!territory) return { ...base, refused: "the connection names no territory — a tenant-owned source is still territory-gated" }

  // Step 7 — the connection's own daily cap: rows this door already produced today for this tenant.
  const cap = typeof cfg.rate_limit_per_day === "number" && cfg.rate_limit_per_day > 0 ? Math.floor(cfg.rate_limit_per_day) : null
  if (cap !== null) {
    const dayStart = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString()
    const { data: todays, error: capErr } = await svc.from("raw_scraped_leads").select("id").eq("brokerage_id", connection.brokerage_id).eq("producer_actor_id", `tenant:${connection.id}`).gte("created_at", dayStart).limit(cap + 1)
    // A refused read is NOT "zero so far" — the cap cannot be judged, so the delivery is held (fail closed) and parked.
    if (capErr) {
      let parked = 0
      for (const e of events) { const ref = String(e.eventId ?? e.propertyId ?? ""); if (ref && deps.park) parked += (await deps.park({ provider: p.provider, eventKind: "smart-search-match", externalRef: `tenant:${connection.id}:${ref}`, payload: e })).parked ? 1 : 0 }
      return { ...base, held: events.length, parked, refused: `rate-limit ledger unreadable (${capErr.message}) — delivery held` }
    }
    if ((todays ?? []).length >= cap) {
      let parked = 0
      for (const e of events) { const ref = String(e.eventId ?? e.propertyId ?? ""); if (ref && deps.park) parked += (await deps.park({ provider: p.provider, eventKind: "smart-search-match", externalRef: `tenant:${connection.id}:${ref}`, payload: e })).parked ? 1 : 0 }
      return { ...base, ok: true, held: events.length, parked, refused: `daily cap of ${cap} records reached for this connection — delivery held for tomorrow` }
    }
  }

  const idsOnly = events.filter(isIdsOnlySmartSearchEvent) as unknown as SmartSearchEvent[]
  const inline = events.filter((e) => !isIdsOnlySmartSearchEvent(e))
  const additions = idsOnly.filter((e) => (e.addedToSubscriptionIds?.length ?? 0) > 0)
  const eventIdByProperty = new Map<string, string>()
  for (const e of additions) if (e.propertyId) eventIdByProperty.set(e.propertyId, e.eventId ?? `${e.propertyId}:${e.propertyChangedAt ?? ""}`)
  const additionIds = [...eventIdByProperty.keys()]

  let raws: Array<Record<string, unknown>> = [...inline]
  let hydrateCost = 0
  if (additionIds.length > 0) {
    const h = await deps.hydrate(additionIds, connection.apiKey)
    if (!h.ok) {
      const f = classifyTenantProviderFailure({ httpStatus: h.httpStatus ?? null, networkError: h.httpStatus === undefined || h.httpStatus === null, message: h.error ?? null }, p.label)
      const healthPatch: TenantWebhookIngestReport["healthPatch"] = { test_status: "fail", last_health: { kind: "hydrate", status: f.probe, at: now.toISOString(), detail: redactProviderSecrets(h.error) || null } }
      // EVERY failure keeps the delivery (step 12 "preserve queue and idempotency state"): revoked → the tenant reconnects and
      // the daily dead-letter replay re-asks; quota / unreachable → retried next cycle. Nothing is ingested unverified.
      let parked = 0
      for (const e of additions) { const ref = String(e.eventId ?? e.propertyId ?? ""); if (ref && deps.park) parked += (await deps.park({ provider: p.provider, eventKind: "smart-search-match", externalRef: `tenant:${connection.id}:${ref}`, payload: e as Record<string, unknown> })).parked ? 1 : 0 }
      return { ...base, connectionState: f.state, parked, held: additions.length, refused: f.tenantMessage, healthPatch, notify: f.notify }
    }
    raws = [...raws, ...h.properties]
    hydrateCost = h.cost
  }
  if (raws.length === 0) return { ...base, ok: true, hydrated: 0 }

  const geo = { city: territory.city ?? null, state: territory.state ?? null, zip_codes: territory.zip_codes ?? [] }
  const records = raws.map((raw) => {
    const r = deps.normalize(raw, { city: geo.city, state: geo.state })
    const propertyId = typeof raw.propertyId === "string" ? raw.propertyId : typeof (raw as Record<string, any>)._id === "string" ? (raw as Record<string, any>)._id : null
    const eventId = propertyId ? eventIdByProperty.get(propertyId) ?? null : (typeof raw.eventId === "string" ? raw.eventId : null)
    return { ...r, envelope: { ...(r.envelope ?? {}), externalEventId: eventId ?? r.envelope?.externalEventId ?? null, externalIds: { ...(r.envelope?.externalIds ?? {}), ...(propertyId ? { batchdata_property_id: propertyId } : {}) }, evidence: { ...(r.envelope?.evidence ?? {}), cost_payer: "tenant", connection_id: connection.id } } } as NormalizedScrapedRecord
  })

  const res = await deps.ingest({
    brokerageId: connection.brokerage_id, // the TENANT's own source → source_origin 'brokerage', owned at once
    marketId: null,
    source: "batchdata_smart_search", sourceFamily: "motivated_seller", sourceChannel: "batchdata_smart_search",
    records, executionId: null, marketGeo: geo,
    // cost_per_record is the PLATFORM's recorded scrape cost (lane 88B) — a tenant-paid hydrate is never written there.
    batchCostUsd: null,
    actor: { type: "webhook", id: `tenant:${connection.id}` },
    client: svc as never,
  })

  let tenantPaidUsd = 0
  if (hydrateCost > 0) {
    const booked = await deps.book(tenantProviderSpendBooking(p, {
      brokerageId: connection.brokerage_id, connectionId: connection.id, sourceKey: "batchdata_smart_search", units: additionIds.length, usd: hydrateCost,
      idempotencyKey: `tenant_webhook:${connection.id}:${[...eventIdByProperty.values()].sort().join(",").slice(0, 200)}`,
      metadata: { door: "batchdata_smart_search_push" },
    }))
    if (booked) tenantPaidUsd = hydrateCost
  }
  return {
    ...base, ok: true, hydrated: additionIds.length, inserted: res.inserted, replayed: res.replayed, skippedTerritory: res.skipped_territory, tenantPaidUsd,
    healthPatch: { test_status: "pass", last_health: { kind: "hydrate", status: "ok", at: now.toISOString(), detail: null } },
  }
}
