// lib/providers/provider-scorecard.ts
//
// THE ONE COST / RIGHTS SCORECARD (wave 150, lane 150HIAB — directive 150I / 150AB, contract C39). PURE: no client, no
// network, no credential read, no `server-only`.
//
// C39: "One capability router (routeCapability + CONTACT_PROVIDER_ROUTES) and one cost/rights scorecard per provider ×
// capability × field; adapters dormant until contract + measurable incremental coverage + unit economics." This file is
// the SCORECARD half. It is NOT a second router: the live provider ORDER is still CONTACT_PROVIDER_ROUTES, asked through
// routeCapability (lib/ai-isa/property-lookup-rail.ts — OS-CONSTITUTION law 3). What the router never carried, and what
// this file adds, is (a) each provider's ACTIVATION / LICENSING state with its rights and credential recorded BY NAME, (b)
// the FIELD-level price / rights / documentation rows — which is what lets a waterfall ask only for the field that is
// actually missing — and (c) the seller-score fields, each in its OWN vendor-defined unit.
//
// OWNER RULING R9 (2026-11-06): "RentCast + Versium + ONE owner-contact/seller-score provider decided by a matched pilot:
// Tracerfy vs DataZapp … BatchData and PeopleData become DORMANT survivor adapters (never deleted; activation needs proven
// incremental coverage and rights) … Data Axle only for market-level employer events / licensed acquisition lists if a gap
// is proven." A dormant-pending-rights provider is NOT in the route table (there is nothing to route to: no transport is
// built), so live routing cannot reach it by construction; activation is a reviewed change that adds its route row, its
// adapter facts and its transport together — never a flag a manager or the self-healer can flip (money; constitution law 4).
//
// Every vendor fact below is cited to the page it was read from (docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md §10,
// read 2026-11-03; the PropertyRadar playbook installed by the owner, read 2026-11-06). A price nobody published is `null`
// (UNKNOWN), never 0 and never a guess. Citations are written host/path without a scheme on purpose — they are evidence,
// not endpoints, and nothing here calls them.

import { CONTACT_PROVIDER_ROUTES, routeCapability, PROVIDER_ACTIVATION, type ContactDataProvider, type ProviderCapability, type CapabilityProviderHealth, type ScorecardProvider, type ActivationState, type RightsStatus, type ProviderActivation } from "@/lib/ai-isa/property-lookup-rail"

// ─── activation / licensing state lives beside the route table (lib/ai-isa/property-lookup-rail.ts PROVIDER_ACTIVATION); re-exported here ──
export { PROVIDER_ACTIVATION }
export type { ScorecardProvider, ActivationState, RightsStatus, ProviderActivation }


/**
 * PURE — may this provider be ACTIVATED (live calls)? Licence unknown blocks ACTIVATION, never offline testing
 * (directive canary 9): `offlineTestAllowed` is true for every provider — a simulation spends nothing and calls nothing.
 */
export function activationVerdict(provider: ScorecardProvider): { mayActivate: boolean; offlineTestAllowed: true; blockers: string[] } {
  const a = PROVIDER_ACTIVATION[provider]
  if (a.state === "active") return { mayActivate: true, offlineTestAllowed: true, blockers: [] }
  const blockers: string[] = []
  if (a.rights.status === "none_stated" || a.rights.status === "not_read" || a.rights.status === "api_page_statement_only") blockers.push(`rights: ${a.rights.status} — ${a.rights.summary}`)
  if (!a.activationEvidence.contract) blockers.push("no contract / written platform-use confirmation on record")
  if (!a.activationEvidence.incrementalCoverage) blockers.push("no measured incremental coverage (the matched pilot has not run on real data)")
  if (!a.activationEvidence.unitEconomics) blockers.push("no unit economics from a measured test")
  if (a.credential.envVars.length === 0) blockers.push("no credential name — no product chosen")
  return { mayActivate: blockers.length === 0, offlineTestAllowed: true, blockers }
}

// ─── the field-level scorecard (provider × capability × field) ────────────────────────────────────────────────────

/** The fields a person / property record can be missing — the waterfall asks only for these. */
export type ScoreField =
  | "owner_phone" | "owner_email" | "dnc_status" | "mailing_address" | "property_facts" | "home_value"
  | "length_of_residence" | "seller_signal" | "distress_signal" | "demographics" | "employment" | "online_audience_ids" | "preview_count"

/** A capability the router routes, or one only dormant providers sell today (no route row until one is activated). */
type ScorecardCapability = ProviderCapability | "seller_signal_score" | "acquisition_preview"

interface ScorecardRow {
  provider: ScorecardProvider
  capability: ScorecardCapability
  field: ScoreField
  /** The vendor's own field / product name exactly as documented; null = the documentation read did not name it. */
  vendorField: string | null
  documented: boolean
  /** USD per unit; null = UNKNOWN (unpublished / unconfirmed). */
  unitUsd: number | null
  unit: "per_match" | "per_request" | "per_record" | "per_phone" | "per_attribute" | "free"
  /** The bulk price is for batched queues only (Tracerfy: an instant single lookup is 5×). */
  batchOnly?: boolean
  /** The route table's unit is a cost ORDER (one credit); the bill is credits × the published weight. */
  creditWeight?: number
  source: string
}

export const PROVIDER_FIELD_SCORECARD: readonly ScorecardRow[] = Object.freeze([
  // RentCast — the property survivor (R9).
  { provider: "rentcast", capability: "property_facts", field: "property_facts", vendorField: "/properties", documented: true, unitUsd: 0.074, unit: "per_request", source: "rentcast.io/api; lib/property/rentcast.ts RENTCAST_USD_PER_REQUEST" },
  { provider: "rentcast", capability: "property_valuation", field: "home_value", vendorField: "/avm/value", documented: true, unitUsd: 0.074, unit: "per_request", source: "rentcast.io/api" },
  { provider: "rentcast", capability: "property_facts", field: "mailing_address", vendorField: "owner.mailingAddress", documented: true, unitUsd: 0.074, unit: "per_request", source: "comparison §10.7 F7" },
  { provider: "rentcast", capability: "property_facts", field: "length_of_residence", vendorField: "history (last sale date)", documented: true, unitUsd: 0.074, unit: "per_request", source: "comparison §10.5 leg 3" },
  // Versium — the existing contracted identity provider (R9).
  { provider: "versium", capability: "owner_contact", field: "owner_phone", vendorField: "Contact Append (phone)", documented: true, unitUsd: 0.05, unit: "per_match", source: "versium.com/pricing; VERSIUM_MATCH_CREDIT_USD" },
  { provider: "versium", capability: "owner_contact", field: "owner_email", vendorField: "Contact Append (email)", documented: true, unitUsd: 0.05, unit: "per_match", source: "versium.com/pricing" },
  { provider: "versium", capability: "online_presence", field: "demographics", vendorField: "full_demographic", documented: true, unitUsd: 0.15, unit: "per_match", creditWeight: 3, source: "VERSIUM_CREDIT_WEIGHTS.full_demographic (3 credits)" },
  { provider: "versium", capability: "online_audience_match", field: "online_audience_ids", vendorField: "Online Audience Append", documented: true, unitUsd: 0.05, unit: "per_match", source: "api-documentation.versium.com" },
  { provider: "versium", capability: "audience_estimate", field: "preview_count", vendorField: "B2C ListGen Estimates", documented: true, unitUsd: 0, unit: "free", source: "api-documentation.versium.com/reference/estimates-api" },
  // BatchData — dormant survivor (R9).
  { provider: "batchdata", capability: "owner_contact", field: "owner_phone", vendorField: "skip-trace v3", documented: true, unitUsd: 0.07, unit: "per_match", source: "batchdata.io/pricing; BATCHDATA_SKIP_TRACE_COST_USD" },
  { provider: "batchdata", capability: "owner_contact", field: "owner_email", vendorField: "skip-trace v3", documented: true, unitUsd: 0.07, unit: "per_match", source: "batchdata.io/pricing" },
  { provider: "batchdata", capability: "dnc_tcpa", field: "dnc_status", vendorField: "check_dnc_status (MCP)", documented: true, unitUsd: 0.05, unit: "per_request", source: "MCP_TOOL_CALL_COST_USD" },
  { provider: "batchdata", capability: "motivated_seller_list", field: "distress_signal", vendorField: "quickLists", documented: true, unitUsd: 0.05, unit: "per_record", source: "BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD" },
  { provider: "batchdata", capability: "seller_signal_score", field: "seller_signal", vendorField: "intel.salePropensity", documented: true, unitUsd: null, unit: "per_record", source: "lib/external/batchdata-client.ts (BatchRank add-on, $2,500/mo plan — comparison §10.4)" },
  // PeopleData — dormant survivor (R9).
  { provider: "peopledata", capability: "person_profile", field: "employment", vendorField: "Person Enrichment", documented: true, unitUsd: 0.25, unit: "per_match", source: "PEOPLEDATA_MATCH_COST_USD" },
  { provider: "peopledata", capability: "owner_contact", field: "owner_email", vendorField: "Person Enrichment", documented: true, unitUsd: 0.25, unit: "per_match", source: "PEOPLEDATA_MATCH_COST_USD" },
  // Tracerfy — pilot candidate (R9), dormant pending rights.
  { provider: "tracerfy", capability: "owner_contact", field: "owner_phone", vendorField: "Normal Trace", documented: true, unitUsd: 0.02, unit: "per_match", batchOnly: true, source: "tracerfy.com/pricing (1 credit a hit; misses free; instant lookup 5 credits)" },
  { provider: "tracerfy", capability: "owner_contact", field: "owner_email", vendorField: "Normal Trace", documented: true, unitUsd: 0.02, unit: "per_match", batchOnly: true, source: "tracerfy.com/pricing" },
  { provider: "tracerfy", capability: "dnc_tcpa", field: "dnc_status", vendorField: "DNC scrub", documented: true, unitUsd: 0.02, unit: "per_phone", source: "tracerfy.com/pricing (charged per phone checked)" },
  { provider: "tracerfy", capability: "seller_signal_score", field: "seller_signal", vendorField: null, documented: false, unitUsd: 0.1, unit: "per_record", source: "tracerfy.com/pricing (Property Data + TraceAI, 5 credits a delivered record; the score's JSON field name is not documented in the pages read)" },
  // DataZapp — pilot candidate (R9), dormant pending rights.
  { provider: "datazapp", capability: "owner_contact", field: "owner_email", vendorField: "Email Append API", documented: true, unitUsd: 0.03, unit: "per_match", source: "datazapp.com/email-append; knowledgebase.datazapp.com email-append-api" },
  { provider: "datazapp", capability: "owner_contact", field: "owner_phone", vendorField: "Phone Append", documented: true, unitUsd: 0.03, unit: "per_match", source: "datazapp.com/phone-append (≤ 50,000)" },
  { provider: "datazapp", capability: "online_presence", field: "length_of_residence", vendorField: "LOR", documented: true, unitUsd: 0.0075, unit: "per_attribute", source: "knowledgebase.datazapp.com/apis/demography-append-api" },
  { provider: "datazapp", capability: "seller_signal_score", field: "seller_signal", vendorField: "Signal_Seller_Score", documented: true, unitUsd: null, unit: "per_attribute", source: "knowledgebase.datazapp.com/apis/demography-append-api (0x–4x); the seller-score price is unconfirmed" },
  // PropertyRadar — methodology used without purchase; dormant pending rights.
  { provider: "propertyradar", capability: "acquisition_preview", field: "preview_count", vendorField: "totalResultCount (Purchase=0)", documented: true, unitUsd: 0, unit: "free", source: "propertyradar-api playbook references/endpoints.md (Purchase=0 consumes no record quota)" },
  { provider: "propertyradar", capability: "seller_signal_score", field: "distress_signal", vendorField: "DistressScore", documented: true, unitUsd: null, unit: "per_record", source: "propertyradar-api playbook references/endpoints.md (0–100 rollup; may be preview-gated)" },
  { provider: "propertyradar", capability: "owner_contact", field: "owner_phone", vendorField: "POST /v1/persons/{PersonKey}/Phone?Purchase=1", documented: true, unitUsd: null, unit: "per_match", source: "propertyradar-api playbook references/endpoints.md (spends credits; price unpublished)" },
  // Data Axle — only for a proven market-level gap; nothing documented at field level yet.
  { provider: "data_axle", capability: "person_profile", field: "demographics", vendorField: null, documented: false, unitUsd: null, unit: "per_record", source: "data-axle.com (advertised from $25 / 1k standard consumer — fields unconfirmed)" },
])

// ─── seller-score fields: each in its OWN vendor-defined unit (never cross-ranked, never a probability) ─────────────

interface SellerSignalField {
  provider: ScorecardProvider
  /** The key lib/intent/moving-moments.ts VENDOR_SCORE_UNITS labels it by — ONE vocabulary (CLAUDE.md §6). */
  vendorKey: string
  product: string
  scale: string
  domain: { kind: "range"; min: number; max: number } | { kind: "labels"; labels: readonly string[] } | { kind: "undocumented" }
}

/** The stored names (raw_scraped_leads.evidence.seller_signals.<name>) — one per vendor field, never merged. */
export const SELLER_SIGNAL_FIELDS = Object.freeze({
  tracerfy_lead_builder_seller_score: { provider: "tracerfy", vendorKey: "tracerfy:seller_score", product: "Lead Builder / Property Data + TraceAI (NOT the ordinary skip trace, which returns no score)", scale: "Tracerfy's own scale — the numeric range is not published", domain: { kind: "undocumented" } },
  datazapp_signal_seller_score: { provider: "datazapp", vendorKey: "datazapp:Signal_Seller_Score", product: "Demography Append API", scale: "an ordinal LABEL 0x–4x — never a number on Tracerfy's or PropertyRadar's scale", domain: { kind: "labels", labels: ["0x", "1x", "2x", "3x", "4x"] } },
  propertyradar_distress_score: { provider: "propertyradar", vendorKey: "propertyradar:DistressScore", product: "Property search / detail (Overview fieldset)", scale: "0–100 rollup of distress signals — a rank for investors, not a likely-listing score", domain: { kind: "range", min: 0, max: 100 } },
  propertyradar_likely_listing_score: { provider: "propertyradar", vendorKey: "propertyradar:LikelyListingScore", product: "named in the REI playbook; not in the installed API reference", scale: "undocumented — verify on a live account before use", domain: { kind: "undocumented" } },
  propertyradar_likely_purchase_score: { provider: "propertyradar", vendorKey: "propertyradar:LikelyPurchaseScore", product: "named in the REI playbook; not in the installed API reference", scale: "undocumented — verify on a live account before use", domain: { kind: "undocumented" } },
  batchdata_sale_propensity: { provider: "batchdata", vendorKey: "batchdata:salePropensity", product: "BatchRank add-on (intel.salePropensity / salePropensityCategory)", scale: "BatchData's own propensity scale (the add-on is not on the platform account)", domain: { kind: "undocumented" } },
} satisfies Record<string, SellerSignalField>)

export type SellerSignalName = keyof typeof SELLER_SIGNAL_FIELDS

export interface LabelledSellerSignal {
  name: SellerSignalName
  provider: ScorecardProvider
  vendorKey: string
  value: number | string
  scale: string
  label: string
  /** ALWAYS null — a vendor score is never a chance of a move until calibrated against outcomes (C37). */
  probability: null
  observedAt: string
}

/**
 * PURE — a raw vendor value → the labelled signal stored under ITS OWN name, or a refusal when the value is outside the
 * vendor's documented domain (a "5x" DataZapp label, a DistressScore of 140). An undocumented-scale field is kept
 * verbatim and labelled as such — never coerced onto another vendor's scale.
 */
export function labelSellerSignal(name: SellerSignalName, raw: unknown, observedAt: string): { ok: true; signal: LabelledSellerSignal } | { ok: false; reason: string } {
  const f: SellerSignalField = SELLER_SIGNAL_FIELDS[name]
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: `${name}: no value` }
  let value: number | string
  if (f.domain.kind === "labels") {
    const s = String(raw).trim().toLowerCase()
    if (!f.domain.labels.includes(s)) return { ok: false, reason: `${name}: "${String(raw)}" is not one of ${f.domain.labels.join(" / ")}` }
    value = s
  } else if (f.domain.kind === "range") {
    const n = typeof raw === "number" ? raw : Number(raw)
    if (!Number.isFinite(n) || n < f.domain.min || n > f.domain.max) return { ok: false, reason: `${name}: ${String(raw)} is outside ${f.domain.min}–${f.domain.max}` }
    value = n
  } else {
    value = typeof raw === "number" ? raw : String(raw)
  }
  return {
    ok: true,
    signal: {
      name, provider: f.provider, vendorKey: f.vendorKey, value, scale: f.scale,
      label: `${f.vendorKey} ${String(value)} — ${f.scale}; a provider signal in its own units, never a probability of a move`,
      probability: null, observedAt,
    },
  }
}

/**
 * PURE — order two seller signals, or REFUSE (null) when they are not the same vendor field. A Tracerfy score is never
 * "higher" than a DataZapp label, and a DataZapp label is ordered only by its own documented label order.
 */
export function compareSellerSignals(a: LabelledSellerSignal, b: LabelledSellerSignal): number | null {
  if (a.name !== b.name) return null
  const f: SellerSignalField = SELLER_SIGNAL_FIELDS[a.name]
  if (f.domain.kind === "labels") return f.domain.labels.indexOf(String(a.value)) - f.domain.labels.indexOf(String(b.value))
  if (f.domain.kind === "range") return Number(a.value) - Number(b.value)
  return null // an undocumented scale has no documented order
}

// ─── the field-level overlap / gap matrix ─────────────────────────────────────────────────────────────────────────

interface FieldMatrixCell { provider: ScorecardProvider; state: ActivationState; unitUsd: number | null; unit: ScorecardRow["unit"]; rights: RightsStatus; documented: boolean }

/**
 * PURE — per FIELD: every provider that sells it (with state, unit price, rights and whether the field is documented),
 * whether ≥ 2 sell it (an OVERLAP — the cheaper licensed one is asked first, never both), and whether NO active provider
 * documents it (a GAP — only a pilot or an activation can close it). Read by the platform connector-healing console
 * (app/dashboard/superadmin/connector-healing/page.tsx) and by the provider-scorecard proof, which asserts the comparison
 * doc's §11 matrix agrees with it.
 */
export function providerFieldMatrix(): Array<{ field: ScoreField; cells: FieldMatrixCell[]; overlap: boolean; gap: boolean }> {
  const byField = new Map<ScoreField, FieldMatrixCell[]>()
  for (const r of PROVIDER_FIELD_SCORECARD) {
    const a = PROVIDER_ACTIVATION[r.provider]
    const cells = byField.get(r.field) ?? []
    if (!cells.some((c) => c.provider === r.provider)) cells.push({ provider: r.provider, state: a.state, unitUsd: r.unitUsd, unit: r.unit, rights: a.rights.status, documented: r.documented })
    byField.set(r.field, cells)
  }
  return [...byField.entries()].map(([field, cells]) => ({
    field, cells,
    overlap: cells.length >= 2,
    gap: !cells.some((c) => c.state === "active" && c.documented),
  }))
}

// ─── the capability-first waterfall ───────────────────────────────────────────────────────────────────────────────

export interface WaterfallStep {
  provider: ScorecardProvider
  fields: ScoreField[]
  unitUsd: number | null
  unit: ScorecardRow["unit"]
  /** route_table = CONTACT_PROVIDER_ROUTES order (live-callable); dormant_candidate = scorecard only (offline simulation). */
  source: "route_table" | "dormant_candidate"
  mayCallLive: boolean
  why: string
}

export interface ProviderWaterfall {
  capability: ScorecardCapability
  steps: WaterfallStep[]
  skipped: Array<{ provider: string; reason: string }>
  /** Set when NO call is planned at all — with the reason (nothing missing / nothing licensed sells it). */
  noCallReason: string | null
}

/**
 * PURE — THE CAPABILITY-FIRST WATERFALL (C39). A caller names a CAPABILITY and the FIELDS the record is actually missing
 * ("for every person ask which field is actually missing and whether action requires it"). The live order is the router's
 * (routeCapability over CONTACT_PROVIDER_ROUTES, failing providers routed around); a provider that sells none of the
 * missing fields is skipped; a dormant survivor stays live only while its doors wait on the owner (survivorDoors), never
 * once closed. Dormant-pending-rights providers appear ONLY in `offline_simulation` mode, with `mayCallLive: false` —
 * licence unknown blocks activation, not offline testing. Deterministic: no vendor call decides the plan.
 */
export function planProviderWaterfall(req: {
  capability: ScorecardCapability
  missingFields: readonly ScoreField[]
  health?: Partial<Record<ContactDataProvider, CapabilityProviderHealth | null>>
  mode: "live" | "offline_simulation"
}): ProviderWaterfall {
  const missing = new Set(req.missingFields)
  const out: ProviderWaterfall = { capability: req.capability, steps: [], skipped: [], noCallReason: null }
  if (missing.size === 0) { out.noCallReason = "nothing is missing — no provider is asked"; return out }
  const rowsFor = (p: ScorecardProvider) => PROVIDER_FIELD_SCORECARD.filter((r) => r.provider === p && r.capability === req.capability && missing.has(r.field))
  const routed = new Set<string>()
  if (req.capability in CONTACT_PROVIDER_ROUTES) {
    const route = routeCapability(req.capability as ProviderCapability, req.health ?? {})
    for (const s of route.skipped) out.skipped.push(s)
    for (const p of route.providers) {
      routed.add(p)
      const a = (PROVIDER_ACTIVATION as Partial<Record<string, ProviderActivation>>)[p]
      const sp = p as ScorecardProvider
      const rows = a ? rowsFor(sp) : []
      if (!a) { out.skipped.push({ provider: p, reason: "outside the C39 acquisition stack — routed by its own caller" }); continue }
      if (a.state === "dormant_survivor" && a.survivorDoors === "closed") { out.skipped.push({ provider: p, reason: "dormant survivor (R9) — its doors are closed until activation evidence is recorded" }); continue }
      if (rows.length === 0) { out.skipped.push({ provider: p, reason: "sells none of the missing fields" }); continue }
      out.steps.push({
        provider: sp, fields: rows.map((r) => r.field), unitUsd: rows[0].unitUsd, unit: rows[0].unit, source: "route_table", mayCallLive: true,
        why: a.state === "dormant_survivor" ? "dormant survivor (R9) — live only until the owner confirms its doors close" : "active and in the route table",
      })
    }
  }
  for (const p of Object.keys(PROVIDER_ACTIVATION) as ScorecardProvider[]) {
    if (routed.has(p)) continue
    const rows = rowsFor(p)
    if (rows.length === 0) continue
    const a = PROVIDER_ACTIVATION[p]
    if (a.state !== "dormant_pending_rights") { out.skipped.push({ provider: p, reason: `${a.state} — not in this capability's route row (reached through its own door, e.g. the property-lookup rungs)` }); continue }
    if (req.mode === "live") { out.skipped.push({ provider: p, reason: `${a.state} — not in the route table; licence / rights unverified blocks activation` }); continue }
    out.steps.push({ provider: p, fields: rows.map((r) => r.field), unitUsd: rows[0].unitUsd, unit: rows[0].unit, source: "dormant_candidate", mayCallLive: false, why: `${a.state} — offline simulation only (no transport, no spend)` })
  }
  if (out.steps.length === 0) out.noCallReason = req.mode === "live" ? "no active, licensed provider sells the missing fields" : "no provider sells the missing fields"
  return out
}
