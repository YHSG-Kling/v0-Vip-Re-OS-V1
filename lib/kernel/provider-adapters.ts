// lib/kernel/provider-adapters.ts
//
// THE PROVIDER ADAPTER CONTRACT (wave 137, lane 137C; OWNER LAW 3 "agents request capabilities, not
// vendors"). NOT a router and NOT a registry of its own: every adapter is DERIVED from the route
// tables the fabric already routes by —
//   · CONTACT_PROVIDER_ROUTES (lib/ai-isa/property-lookup-rail.ts) — the data capabilities, their
//     provider order (= the fallback) and their per-unit price;
//   · SYSTEM_DEFAULTS / SYSTEM_ONLY_TYPES (lib/kernel/providers.ts) — the channel provider types
//     (email, sms, esign, video, ai, …) and which tier pays;
//   · CONNECTOR_REGISTRY (lib/agentic-os/connector-registry.ts) — endpoint, auth, docs, SDK, MCP;
//   · PROVIDER_TENANCY (lib/providers/tenancy-matrix.ts) — who owns the vendor relationship;
//   · PLATFORM_VENDOR_RATES / VENDOR_PRICING — the price the ledger books;
//   · PROVIDER_HEALTH_POLICY + PROBE_SPECS — the health a call is judged by.
// What none of them carried — the API VERSION the code speaks, the gateway service keys and the usage
// booking — is the only thing ADAPTER_FACTS adds. The KNOWN ALTERNATES (a newer version, a different
// endpoint, an MCP route; CONFIG or CODE level) and a declared deprecation live on the connector
// survivor (CONNECTOR_REGISTRY[*].alternates / deprecatedAfter), which the gateway reads at egress. A new provider plugs in through a route-table row + one facts row;
// validateAdapterSet refuses a routed provider without a declaration, a declaration nobody routes,
// and a platform-paid adapter with no usage booking (constitution: no unmetered paid capability).
//
// The self-healing decision (owner, wave 137: "FIRST probe whether the provider is down; if it is
// UP, check whether its SDK / MCP / endpoint changed … apply the declared change, retry, record
// evidence; code-level changes become a connector healing proposal") is decideProviderHeal — PURE.
// The executor is lib/agentic-os/connector-healer.ts healProviderFailure; the config apply is
// lib/agentic-os/connector-auto-applier.ts applyDeclaredAlternate; the applied alternate reaches
// egress in lib/agentic-os/connector-gateway.ts callConnector (loadAppliedAlternate + applyAlternateToRequest
// there — the gateway reads the alternates from CONNECTOR_REGISTRY, a leaf, never this module's graph).

import { CONTACT_PROVIDER_ROUTES, routeCapability, type CapabilityRoute, type ProviderCapability } from "@/lib/ai-isa/property-lookup-rail"
import { SYSTEM_DEFAULTS, SYSTEM_ONLY_TYPES } from "@/lib/kernel/providers"
import { CONNECTOR_REGISTRY, type ConnectorAlternate } from "@/lib/agentic-os/connector-registry"
import { PROVIDER_TENANCY } from "@/lib/providers/tenancy-matrix"
import { PLATFORM_VENDOR_RATES, meterVendorSpend, type MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"
import { VENDOR_PRICING } from "@/lib/vendor-governance/cost-normalizer"
import { PROVIDER_HEALTH_POLICY } from "@/lib/agentic-os/connector-gateway"
import { PROBE_SPECS } from "@/lib/agentic-os/connector-probe"

// ─── the declaration ──────────────────────────────────────────────────────────

type AdapterPayer = "platform" | "tenant"
type UsageLedger = "vendor_usage_tracking" | "ai_tool_usage" | "tenant_account"

/** A KNOWN alternate — declared on the connector-registry survivor (CONNECTOR_REGISTRY[*].alternates). */
type AdapterAlternate = ConnectorAlternate

export interface ProviderAdapter {
  provider: string
  /** Data capabilities (CONTACT_PROVIDER_ROUTES) and/or channel provider types (SYSTEM_DEFAULTS). */
  capabilities: string[]
  inputs: string[]
  outputs: string
  cost: { payer: AdapterPayer; unitUsd: number; unit: string; priceSource: string; ledger: UsageLedger; booking: string }
  health: { serviceKeys: string[]; liveProbe: string | null; derivedFrom: "api_response_logs"; failingStreak: number; cooldownMs: number }
  rateLimits: { state: "rate_limited"; note: string }
  credential: { survivor: "platform_env" | "tenant_connection"; envVars: string[] }
  eligibility: { tenancyModels: string[]; geography: "us_nationwide" | "global" }
  /** Per data capability: the providers asked after this one (route-table order). */
  fallback: Record<string, string[]>
  provenance: string[]
  api: { transport: "rest" | "sdk" | "mcp" | "gateway"; version: string; baseUrl: string; docsUrl: string | null; sdk: string | null; mcp: string | null; deprecatedAfter: string | null; alternates: AdapterAlternate[] }
}

/** The facts no route table carried. Keyed by the provider name the route tables use. */
interface AdapterFacts {
  serviceKeys: string[]
  outputs: string
  transport: ProviderAdapter["api"]["transport"]
  version: string
  /** Only when CONNECTOR_REGISTRY has no entry (one spelling of a base URL — the validator holds it). */
  baseUrl?: string
  docsUrl?: string
  registryKey?: string
  tenancyKey?: string
  /** VENDOR_PRICING / PLATFORM_VENDOR_RATES key when the price is not in CONTACT_PROVIDER_ROUTES. */
  priceKey?: string
  ledger: UsageLedger
  booking: string
  envVars?: string[]
  geography?: "us_nationwide" | "global"
}

const ADAPTER_FACTS: Readonly<Record<string, AdapterFacts>> = {
  // ── data capabilities (CONTACT_PROVIDER_ROUTES) ──
  rentcast: { serviceKeys: ["rentcast"], outputs: "AVM point + range, property record", transport: "rest", version: "v1", ledger: "vendor_usage_tracking", booking: "meterCall (lib/property/rentcast.ts)" },
  batchdata: { serviceKeys: ["batchdata", "batchdata_skip_trace", "batchdata_smart_search", "batchdata_wallet"], outputs: "skip trace, DNC/TCPA, property facts, quicklists", transport: "rest", version: "v1", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/vendor-governance/meter-vendor.ts)" },
  peopledata: { serviceKeys: ["peopledata"], outputs: "person profile, contact points, email validation", transport: "rest", version: "v5", tenancyKey: "peoplesdata", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/vendor-governance/meter-vendor.ts)" },
  versium: { serviceKeys: ["versium"], outputs: "owner/person email + phone append, household financials", transport: "rest", version: "v2", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/vendor-governance/meter-vendor.ts)" },
  // ── platform channels (SYSTEM_ONLY_TYPES) ──
  anthropic: { serviceKeys: ["vercel-ai-gateway"], outputs: "model completions", transport: "gateway", version: "AI Gateway OpenAI-compatible v1", tenancyKey: "ai_gateway", priceKey: "anthropic_claude", ledger: "ai_tool_usage", booking: "logAIUsage (lib/ai/cost-tracking.ts)", geography: "global" },
  did: { serviceKeys: ["did"], registryKey: "d_id", outputs: "avatar video render", transport: "rest", version: "unversioned", priceKey: "did", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/did/index.ts)", geography: "global" },
  elevenlabs: { serviceKeys: ["elevenlabs"], outputs: "TTS audio, voice clone", transport: "rest", version: "v1", priceKey: "elevenlabs", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/voice/elevenlabs-tts.ts)", geography: "global" },
  twilio: { serviceKeys: ["twilio"], outputs: "SMS, voice calls", transport: "rest", version: "2010-04-01", priceKey: "twilio_sms", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/providers/dispatch.ts)" },
  lob: { serviceKeys: ["lob"], outputs: "printed + mailed piece, address verification", transport: "rest", version: "v1", priceKey: "lob", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/providers/dispatch.ts)" },
  apify: { serviceKeys: ["apify"], outputs: "scraped lead records", transport: "rest", version: "v2", tenancyKey: "scrapers", priceKey: "apify", ledger: "vendor_usage_tracking", booking: "planSourceSpendBooking (lib/lead-pipeline/source-cost-ledger.ts)", geography: "global" },
  // ── per-tenant channels (the cascade; BYO first) ──
  sendgrid: { serviceKeys: ["sendgrid"], outputs: "email send", transport: "rest", version: "v3", baseUrl: "https://api.sendgrid.com/v3", docsUrl: "https://www.twilio.com/docs/sendgrid/api-reference", priceKey: "sendgrid", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/providers/dispatch.ts)", envVars: ["SENDGRID_API_KEY"] },
  google: { serviceKeys: ["google_calendar", "gmail"], outputs: "calendar events, mail", transport: "rest", version: "v3", baseUrl: "https://www.googleapis.com/calendar/v3", docsUrl: "https://developers.google.com/calendar/api", ledger: "tenant_account", booking: "none — the user's own OAuth account", envVars: ["GOOGLE_OAUTH_CLIENT_ID"], geography: "global" },
  docusign: { serviceKeys: ["docusign"], outputs: "envelope send + completion", transport: "rest", version: "v2.1", baseUrl: "https://www.docusign.net/restapi", docsUrl: "https://developers.docusign.com/docs/esign-rest-api/", ledger: "tenant_account", booking: "none — the tenant's own DocuSign account", envVars: ["DOCUSIGN_OAUTH_HOST"], geography: "global" },
  dotloop: { serviceKeys: ["dotloop"], outputs: "loop / transaction sync", transport: "rest", version: "v2", baseUrl: "https://api-gateway.dotloop.com/public/v2", docsUrl: "https://dotloop.github.io/public-api/", ledger: "tenant_account", booking: "none — the tenant's own dotloop account", envVars: ["DOTLOOP_API_KEY"] },
  follow_up_boss: { serviceKeys: ["followupboss"], outputs: "CRM people / events sync", transport: "rest", version: "v1", baseUrl: "https://api.followupboss.com/v1", docsUrl: "https://docs.followupboss.com/", ledger: "tenant_account", booking: "none — the tenant's own FUB key" },
  quickbooks: { serviceKeys: ["quickbooks"], outputs: "invoices, purchases, journal entries", transport: "rest", version: "v3 minorversion=73", ledger: "tenant_account", booking: "none — the tenant's own QuickBooks company" },
  stripe: { serviceKeys: ["stripe"], outputs: "payments, transfers", transport: "sdk", version: "2026-02-25.clover", baseUrl: "https://api.stripe.com/v1", docsUrl: "https://docs.stripe.com/api", ledger: "tenant_account", booking: "none — the tenant's own Stripe account", envVars: ["STRIPE_SECRET_KEY"], geography: "global" },
  idxbroker: { serviceKeys: ["idxbroker"], outputs: "MLS/IDX listing feed", transport: "rest", version: "unversioned", baseUrl: "https://api.idxbroker.com", docsUrl: "https://middleware.idxbroker.com/docs/api/overview.php", ledger: "tenant_account", booking: "none — the tenant's own IDX account (platform fallback is a free tier)", envVars: ["IDXBROKER_API_KEY"] },
  buffer: { serviceKeys: ["buffer"], outputs: "social post scheduling", transport: "rest", version: "v1", baseUrl: "https://api.bufferapp.com/1", docsUrl: "https://buffer.com/developers/api", ledger: "tenant_account", booking: "none — the tenant's own Buffer account" },
}

// ─── derivation ────────────────────────────────────────────────────────────────

/** Every provider the fabric ROUTES: the data route table's providers ∪ the channel defaults.
 *  @proofSeam scripts/provider-adapter-guard.ts compares its count to the derived adapter count; the
 *  production reader is deriveProviderAdapters in this file. */
export function routedProviders(): string[] {
  const out = new Set<string>()
  for (const entries of Object.values(CONTACT_PROVIDER_ROUTES)) for (const e of entries) out.add(e.provider)
  for (const v of Object.values(SYSTEM_DEFAULTS)) out.add(v)
  return [...out].sort()
}

function priceFor(provider: string, facts: AdapterFacts): { unitUsd: number; unit: string; priceSource: string } {
  const routed = Object.values(CONTACT_PROVIDER_ROUTES).flat().filter((e) => e.provider === provider)
  if (routed.length) return { unitUsd: Math.min(...routed.map((e) => e.unitCostUsd)), unit: "call/match", priceSource: "CONTACT_PROVIDER_ROUTES" }
  const k = facts.priceKey
  const platform = k ? (PLATFORM_VENDOR_RATES as Record<string, { perUnit: number; unit: string }>)[k] : undefined
  if (platform) return { unitUsd: platform.perUnit, unit: platform.unit, priceSource: `PLATFORM_VENDOR_RATES.${k}` }
  const vp = k ? VENDOR_PRICING[k] : undefined
  if (vp) return { unitUsd: vp.costPerUnit, unit: vp.unitType, priceSource: `VENDOR_PRICING.${k}` }
  return { unitUsd: 0, unit: "n/a", priceSource: "tenant account (no platform price)" }
}

function deriveOne(provider: string, facts: AdapterFacts): ProviderAdapter {
  const dataCaps = (Object.keys(CONTACT_PROVIDER_ROUTES) as ProviderCapability[]).filter((c) => CONTACT_PROVIDER_ROUTES[c].some((e) => e.provider === provider))
  const channelTypes = Object.entries(SYSTEM_DEFAULTS).filter(([, v]) => v === provider).map(([t]) => t)
  const reg = CONNECTOR_REGISTRY[facts.registryKey ?? provider]
  const tenancy = PROVIDER_TENANCY.find((t) => t.provider === (facts.tenancyKey ?? provider)) ?? null
  const primaryModel = tenancy?.models[0] ?? null
  const payer: AdapterPayer = channelTypes.some((t) => SYSTEM_ONLY_TYPES.has(t)) || primaryModel === "platform_metered" || primaryModel === "platform_subaccount" || (dataCaps.length > 0 && !channelTypes.length)
    ? "platform" : "tenant"
  const fallback: Record<string, string[]> = {}
  for (const c of dataCaps) {
    const order = CONTACT_PROVIDER_ROUTES[c].map((e) => e.provider)
    fallback[c] = order.filter((p) => p !== provider)
  }
  const envVars = facts.envVars ?? (reg?.envKey ? [reg.envKey] : tenancy?.envVars ?? [])
  return {
    provider,
    capabilities: [...dataCaps, ...channelTypes],
    inputs: dataCaps.length ? [...new Set(dataCaps.flatMap((c) => CONTACT_PROVIDER_ROUTES[c].filter((e) => e.provider === provider).map((e) => e.keyedBy)))] : channelTypes.map((t) => `${t} request`),
    outputs: facts.outputs,
    cost: { payer, ...priceFor(provider, facts), ledger: facts.ledger, booking: facts.booking },
    health: { serviceKeys: facts.serviceKeys, liveProbe: facts.serviceKeys.find((k) => !!PROBE_SPECS[k]) ?? null, derivedFrom: "api_response_logs", failingStreak: PROVIDER_HEALTH_POLICY.failingStreak, cooldownMs: PROVIDER_HEALTH_POLICY.cooldownMs },
    rateLimits: { state: "rate_limited", note: "a 429 is the gateway's rate_limited outcome (deriveProviderHealth); GET retries once, a write never" },
    credential: { survivor: payer === "platform" ? "platform_env" : "tenant_connection", envVars },
    eligibility: { tenancyModels: tenancy?.models ?? [], geography: facts.geography ?? "us_nationwide" },
    fallback,
    provenance: [
      ...(dataCaps.length ? ["CONTACT_PROVIDER_ROUTES"] : []),
      ...(channelTypes.length ? ["SYSTEM_DEFAULTS"] : []),
      ...(reg ? ["CONNECTOR_REGISTRY"] : []),
      ...(tenancy ? ["PROVIDER_TENANCY"] : []),
      "ADAPTER_FACTS",
    ],
    api: {
      transport: facts.transport, version: facts.version,
      baseUrl: reg?.baseUrl ?? facts.baseUrl ?? "",
      docsUrl: reg?.docsUrl ?? facts.docsUrl ?? null,
      sdk: reg?.npmSdk ?? null,
      mcp: reg?.mcpServer?.url ?? reg?.mcpServer?.githubUrl ?? null,
      deprecatedAfter: reg?.deprecatedAfter ?? null,
      alternates: reg?.alternates ?? [],
    },
  }
}

/** Derive one adapter per routed provider. `missing` = routed with no facts row (a refusal).
 *  @proofSeam scripts/provider-adapter-guard.ts runs it over edited facts (the positive controls); the
 *  production reader is adapterFor in this file. */
export function deriveProviderAdapters(facts: Readonly<Record<string, AdapterFacts>> = ADAPTER_FACTS): { adapters: ProviderAdapter[]; missing: string[]; unrouted: string[] } {
  const routed = routedProviders()
  const adapters: ProviderAdapter[] = []
  const missing: string[] = []
  for (const p of routed) {
    const f = facts[p]
    if (!f) missing.push(p)
    else adapters.push(deriveOne(p, f))
  }
  const unrouted = Object.keys(facts).filter((p) => !routed.includes(p))
  return { adapters, missing, unrouted }
}

let cached: ProviderAdapter[] | null = null
/** The VALID adapter declared for a provider name OR a gateway service key (api_response_logs.service_key).
 *  An invalid declaration is not served (fail closed): the healer then only proposes, never applies. */
export function adapterFor(providerOrServiceKey: string): ProviderAdapter | null {
  if (!cached) {
    const derived = deriveProviderAdapters()
    const errs = validateAdapterSet(derived)
    if (errs.length) console.error(`[provider-adapters] ${errs.length} declaration fault(s) — those adapters are not served:`, errs.slice(0, 5).join(" | "))
    cached = derived.adapters.filter((a) => validateProviderAdapter(a).length === 0)
  }
  return cached.find((a) => a.provider === providerOrServiceKey || a.health.serviceKeys.includes(providerOrServiceKey)) ?? null
}

/** The CONFIG-level alternate a provider declares under this id (never a code-level one). */
export function declaredConfigAlternate(providerOrServiceKey: string, alternateId: string): { adapter: ProviderAdapter; alternate: AdapterAlternate } | null {
  const adapter = adapterFor(providerOrServiceKey)
  const alternate = adapter?.api.alternates.find((a) => a.id === alternateId && a.level === "config") ?? null
  return adapter && alternate ? { adapter, alternate } : null
}

// ─── validation ────────────────────────────────────────────────────────────────

/** PURE — what is wrong with ONE declaration ([] = valid).
 *  @proofSeam the guard refuses a forged unmetered adapter through it; production reader: adapterFor. */
export function validateProviderAdapter(a: ProviderAdapter): string[] {
  const errs: string[] = []
  if (!a.capabilities.length) errs.push("no capability — a provider no capability routes to is not an adapter")
  if (!a.api.version.trim()) errs.push("no API version declared")
  if (!/^https:\/\//.test(a.api.baseUrl)) errs.push("no https endpoint declared")
  if (!a.health.serviceKeys.length) errs.push("no health service key — its outcomes cannot be judged")
  if (a.credential.survivor === "platform_env" && !a.credential.envVars.length) errs.push("platform credential with no env var named")
  const paid = a.cost.payer === "platform" && a.cost.unitUsd > 0
  if (paid && (a.cost.ledger === "tenant_account" || !a.cost.booking.trim() || /^none\b/.test(a.cost.booking))) errs.push("UNMETERED PAID adapter — a platform-paid call must name its usage booking")
  if (a.cost.payer === "platform" && a.cost.unitUsd <= 0 && a.cost.ledger !== "ai_tool_usage") errs.push("platform-paid adapter with no declared price")
  const ids = new Set<string>()
  for (const alt of a.api.alternates) {
    if (ids.has(alt.id)) errs.push(`duplicate alternate ${alt.id}`)
    ids.add(alt.id)
    if (alt.level === "config" && !alt.version && !alt.baseUrl && !alt.query && !alt.headers) errs.push(`config alternate ${alt.id} changes nothing`)
    if (alt.baseUrl && !/^https:\/\//.test(alt.baseUrl)) errs.push(`alternate ${alt.id} endpoint is not https`)
    if (alt.level === "code" && !alt.route) errs.push(`code alternate ${alt.id} names no route module`)
  }
  return errs
}

/** PURE — the whole set against the routed providers.
 *  @proofSeam the guard asserts it clean + its positive controls; production reader: adapterFor. */
export function validateAdapterSet(derived: { adapters: ProviderAdapter[]; missing: string[]; unrouted: string[] }): string[] {
  const errs: string[] = []
  for (const p of derived.missing) errs.push(`${p}: ROUTED but no adapter declaration`)
  for (const p of derived.unrouted) errs.push(`${p}: declared but nothing routes to it — a provider plugs in through the route table`)
  for (const a of derived.adapters) for (const e of validateProviderAdapter(a)) errs.push(`${a.provider}: ${e}`)
  for (const a of derived.adapters) for (const [cap, next] of Object.entries(a.fallback)) for (const p of next) if (!derived.adapters.some((x) => x.provider === p)) errs.push(`${a.provider}: fallback ${p} for ${cap} has no adapter`)
  return errs
}

// ─── usage booking ─────────────────────────────────────────────────────────────

/**
 * ONE booking per EXECUTED adapter call; a refused/failed call books nothing (§: "a refused call books
 * none"). Platform-paid vendor adapters book through meterVendorSpend (vendor_usage_tracking); an AI
 * adapter books through logAIUsage at the gateway (not here); a tenant-account adapter books nothing.
 */
export async function bookAdapterUsage(
  adapter: ProviderAdapter,
  call: { brokerageId: string | null; executed: boolean; units?: number; systemSource: string; usageType: string },
  deps: { meter?: (input: MeterVendorInput) => Promise<boolean> } = {},
): Promise<boolean> {
  if (!call.executed) return false
  if (adapter.cost.ledger !== "vendor_usage_tracking" || adapter.cost.unitUsd <= 0) return false
  const units = call.units && call.units > 0 ? call.units : 1
  return (deps.meter ?? meterVendorSpend)({
    vendorName: adapter.provider, usageType: call.usageType, unitCount: units,
    cost: Math.round(adapter.cost.unitUsd * units * 10000) / 10000,
    brokerageId: call.brokerageId, systemSource: call.systemSource,
    metadata: { adapter_version: adapter.api.version, price_source: adapter.cost.priceSource },
  })
}

// ─── self-healing decision (PURE) ─────────────────────────────────────────────

export type ProbeVerdict = "ok" | "shape_drift" | "auth_failed" | "unreachable" | "not_configured" | null

export interface HealSignals {
  probe: ProbeVerdict
  derived: { state: string; routeAround: boolean; reason: string } | null
  /** connector_shape_memory diff (lib/kernel/schema-memory.ts loadRecentShapeChanges) for this connector. */
  shapeChange: { addedKeys: string[]; removedKeys: string[] } | null
  /** The declared alternate already applied (connector_healing_proposals declared_alternate, applied). */
  appliedAlternateId: string | null
  now: Date
}

export type HealDecision =
  | { step: "failover"; reason: string; routes: CapabilityRoute[] }
  | { step: "apply_declared"; reason: string; alternate: AdapterAlternate }
  | { step: "propose"; reason: string; proposalKind: "shape_update" | "endpoint_change" | "rotate_key" | "no_evidence" }
  | { step: "escalate"; reason: string }
  | { step: "none"; reason: string }

/**
 * PURE — the owner's order. 1) DOWN (the probe could not reach it, or its derived health is in a
 * `failing` cool-down) → FAILOVER through routeCapability; with no healthy alternate for any of its
 * capabilities → escalate (wave 137 approve-all: failover first, escalate only without one).
 * 2) UP: bad credentials → a rotate_key proposal (never auto). 3) UP + drift (probe shape drift, a
 * dropped key in shape memory, the declared version past its deprecation, or a declared alternate
 * that supersedes the current one) → APPLY the first config-level declared alternate not already
 * applied; with only code-level alternates (or none) → a proposal for platform staff. 4) UP, no drift
 * → nothing to heal (the gateway's own transient retry owns a blip).
 */
export function decideProviderHeal(adapter: ProviderAdapter, s: HealSignals): HealDecision {
  const down = s.probe === "unreachable" || !!s.derived?.routeAround
  if (down) {
    const dataCaps = adapter.capabilities.filter((c): c is ProviderCapability => c in CONTACT_PROVIDER_ROUTES)
    const health = { [adapter.provider]: { state: "failing", routeAround: true, reason: s.derived?.reason ?? `probe: ${s.probe}` } } as Parameters<typeof routeCapability>[1]
    const routes = dataCaps.map((c) => routeCapability(c, health))
    const served = routes.filter((r) => r.providers.length > 0)
    if (served.length) return { step: "failover", routes, reason: `${adapter.provider} is DOWN (${s.probe === "unreachable" ? "probe unreachable" : s.derived?.reason}) — routed around to ${served.map((r) => `${r.capability}→${r.providers[0]}`).join(", ")}` }
    return { step: "escalate", reason: `${adapter.provider} is DOWN and no capability it serves has a healthy alternate provider — a human decides` }
  }
  if (s.probe === "auth_failed") return { step: "propose", proposalKind: "rotate_key", reason: `${adapter.provider} is UP but refused the credential — a key rotation is never applied automatically` }
  // An applied alternate that supersedes the current declaration HAS answered the deprecation — not drift again.
  const answered = adapter.api.alternates.some((a) => a.id === s.appliedAlternateId && a.supersedesCurrent)
  const deprecated = !answered && !!adapter.api.deprecatedAfter && s.now.getTime() >= new Date(adapter.api.deprecatedAfter).getTime()
  const shapeDrift = s.probe === "shape_drift" || (s.shapeChange?.removedKeys.length ?? 0) > 0
  const superseding = adapter.api.alternates.filter((a) => a.supersedesCurrent && a.id !== s.appliedAlternateId)
  const drift = deprecated || shapeDrift || superseding.length > 0
  if (!drift) return { step: "none", reason: `${adapter.provider} is UP with no version/endpoint/shape drift — a transient fault; the gateway retry owns it` }
  const why = [deprecated && `declared version ${adapter.api.version} deprecated after ${adapter.api.deprecatedAfter}`, shapeDrift && "response shape drift", superseding.length > 0 && `declared alternate ${superseding[0].id} supersedes it`].filter(Boolean).join("; ")
  const configAlt = adapter.api.alternates.find((a) => a.level === "config" && a.id !== s.appliedAlternateId && (a.supersedesCurrent || deprecated || shapeDrift))
  if (configAlt) return { step: "apply_declared", alternate: configAlt, reason: `${adapter.provider} is UP but drifted (${why}) — applying declared config alternate ${configAlt.id}` }
  return { step: "propose", proposalKind: shapeDrift ? "shape_update" : "endpoint_change", reason: `${adapter.provider} is UP but drifted (${why}) and no config-level alternate is declared — a code-level change goes to platform staff` }
}
