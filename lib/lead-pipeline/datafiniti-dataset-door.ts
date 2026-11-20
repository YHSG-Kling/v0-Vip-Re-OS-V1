// lib/lead-pipeline/datafiniti-dataset-door.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DATAFINITI DATASET DOOR — property · people · business · product, decided BEFORE a single credit (wave 155, lane 155I;
// owner R11 "datafinity is more than a person"; directive §155I I1–I3).
//
// NOT A SECOND PROVIDER (OS-CONSTITUTION law 1 / 2): the transport is the one Datafiniti client
// (lib/external/datafiniti-client.ts callDatafinitiTool — the documented MCP endpoint, the same token, credits and permissions
// as REST); people stay on THEIR established door (lib/lead-pipeline/datafiniti-people-producer.ts runDatafinitiPeoplePull →
// the RawData producer → the Raw Lead gate) — this door decides for people and never buys one. Law 3: caller → capability
// (a dataset need) → this router → the provider.
//
// THE ORDER, as code (the first refusal stops everything; nothing charged runs before step 9):
//   1 rights      the platform activation (PROVIDER_ACTIVATION.datafiniti) or the tenant connection's verdict, AND the source-
//                 rights registry for every use the need declares (multi-tenant + storage always) — LICENSE unresolved → ZERO
//                 calls, free ones included (the same rule as the people producer).
//   2 schema      df_get_schema (FREE), cached per credential scope + data_type; a regenerated tenant token is a new scope; an
//                 unknown_field / invalid_field answer or a 401 invalidates it.
//   3 query       TYPED terms checked against the REAL schema (no hard-coded field may reach `query`); the documented rental-status
//                 trap (a rental status on mostRecentStatus returns ZERO with no error) is refused before any call.
//   4 count       df_count (FREE) — zero matches is a success and ends the path.
//   5 overlap     an ACTIVE incumbent (RentCast / tenant IDX for property, Versium for people) covering the need blocks the spend,
//                 unless the need names gap fields the schema has.
//   6 decide      people → the established gates; product → not needed unless justified (optional, non-core); credits estimated
//                 from the count (USD unknown unless a plan price was measured — never invented).
//   7 approval    an explicit credit ceiling from a named approver.
//   8 once        the charge-once key (tenant + data_type + request id) — a booked key never buys again; an unreadable ledger
//                 refuses (fail closed). A canonical-domain writer must exist: nothing is bought that cannot land.
//   9 charge      df_search (num_records EXPLICIT, ≤ 50) · df_get_record (1 credit) · df_start_download (async) — the download
//                 checkpoint is read FIRST (tenant-pinned) and resumed with the free df_download_status, never a second job.
//  10 land        typed observations with provenance (vendor row id, dateUpdated → source age, retrieved_at, query, credit share)
//                 into the CANONICAL domain — never Raw Lead; held values win a mismatch (recorded, never overwritten).
// Every I/O is injected (`deps`) so scripts/datafiniti-connector-guard.ts §N drives this exact code with zero network.
// LIVE-VERIFIED: none. Every proof is SIMULATED.

import { PROVIDER_ACTIVATION, PROVIDER_FIELD_SCORECARD, type ProviderActivation } from "@/lib/providers/provider-scorecard"
import type { DatafinitiCredential, DatafinitiClientOptions, DatafinitiDataType, DatafinitiFailure } from "@/lib/external/datafiniti-client"
import type { TenantProviderConnectionVerdict } from "@/lib/providers/tenant-provider-connections"
import type { MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"

const VENDOR = "datafiniti"
const DATAFINITI_DATASET_DOWNLOAD_JOB_TYPE = "datafiniti_dataset_download"
/** Cache policy (ours, not the vendor's — the docs state no schema version signal): a schema is re-read after a day. */
const SCHEMA_TTL_MS = 24 * 3_600_000

// ─── I1 · the four datasets (fields ONLY as the docs name them; df_get_schema is the field authority) ───────────────────

export type DatafinitiUse = "multi_tenant" | "storage" | "enrichment" | "ai_processing" | "export" | "outreach"
type RightState = "permitted" | "prohibited" | "not_stated"
export type DatafinitiUseRights = Readonly<Record<DatafinitiUse, RightState>> & { readonly retentionDays: number | null; readonly source: string }

/** THE SOURCE-RIGHTS REGISTRY for the platform's own account. Every use is "not_stated" because the documentation read does not
 *  state licensing (digest 2026-11-19). The owner's licensing decision edits THIS row and PROVIDER_ACTIVATION.datafiniti together. */
export const DATAFINITI_SOURCE_RIGHTS: DatafinitiUseRights = Object.freeze({
  multi_tenant: "not_stated", storage: "not_stated", enrichment: "not_stated", ai_processing: "not_stated", export: "not_stated", outreach: "not_stated",
  retentionDays: null,
  source: "docs.datafiniti.co mcp-server · property / business / people MCP pages · reference/search-and-downloads (read 2026-11-19): licensing, storage, redistribution, retention NOT stated",
})

type Category = "property_facts" | "sale_listing_fact" | "rental_listing_fact" | "person_contact" | "local_business" | "product_trend"

interface DatasetCapability {
  dataType: DatafinitiDataType
  /** Fields the documentation pages NAME (not the schema — a live df_get_schema answer is the authority). */
  documentedFields: readonly string[]
  categories: readonly Category[]
  canonicalDomain: string
  /** Inferences this dataset must never be used to make. */
  never: readonly string[]
  core: boolean
}

export const DATAFINITI_DATASET_CAPABILITIES: Readonly<Record<DatafinitiDataType, DatasetCapability>> = Object.freeze({
  property: {
    dataType: "property", core: true,
    documentedFields: ["address", "city", "province", "postalCode", "propertyType", "mostRecentStatus", "mostRecentRentalStatus", "mostRecentPriceAmount", "numBedroom", "numBathroom"],
    categories: ["property_facts", "sale_listing_fact", "rental_listing_fact"],
    canonicalDomain: "property — a conflicting-or-new OBSERVATION beside RentCast's survivor (lib/avm/provider-chain.ts getPropertyRecordWithFallback); held values win",
    never: ["a vendor value / estimate is not an appraisal (never reaches a licensed appraiser)", "an asking / most-recent listed price is not a sold price (never a sold comp)", "a property row is never a person or a Raw Lead"],
  },
  people: {
    dataType: "people", core: true,
    documentedFields: ["name", "title", "company", "emails", "phones", "city", "province"],
    categories: ["person_contact"],
    canonicalDomain: "RawData ONLY through the established gates (runDatafinitiPeoplePull → ingestRawSourceBatch → Raw Lead gate → Lead → AI ISA); never a Contact",
    never: ["no moving / selling intent inferred from an address or demographics (intent stays unknown)", "no outreach list built from a purchase"],
  },
  business: {
    dataType: "business", core: true,
    documentedFields: ["name", "address", "city", "province", "postalCode", "phones", "categories", "revenue"],
    categories: ["local_business"],
    canonicalDomain: "market — AGGREGATE neighborhood demand by category / postal code (market research or a genuine B2B use); never Raw Lead",
    never: ["a business record is never a Raw Lead", "a headquarters move informs aggregate demand — never named employees", "person-identifying fields are dropped"],
  },
  product: {
    dataType: "product", core: false,
    documentedFields: ["prices (nested)", "descriptions", "reviews"],
    categories: ["product_trend"],
    canonicalDomain: "research — idea evidence for the ONE topic intake (content_topic_bank); never bought to say four datasets were done",
    never: ["optional and non-core: no purchase without a stated need"],
  },
})

/** Incumbent coverage per category — derived from the survivors (scorecard rows / activation), never re-typed as a status. */
function incumbentsFor(category: Category, tenantIdxConnected: boolean): string[] {
  const active = (p: string) => p !== VENDOR && (PROVIDER_ACTIVATION as Record<string, ProviderActivation>)[p]?.state === "active"
  const fromScorecard = (cap: string) => [...new Set(PROVIDER_FIELD_SCORECARD.filter((r) => r.capability === cap && active(r.provider)).map((r) => r.provider))]
  if (category === "property_facts") return [...fromScorecard("property_facts"), ...(tenantIdxConnected ? ["tenant_idx"] : [])]
  // RentCast's vendored OpenAPI carries /listings/sale and /listings/rental/long-term (lib/external/_generated/rentcast-openapi.ts).
  if (category === "sale_listing_fact") return [...(active("rentcast") ? ["rentcast"] : []), ...(tenantIdxConnected ? ["tenant_idx"] : [])]
  if (category === "rental_listing_fact") return active("rentcast") ? ["rentcast"] : []
  if (category === "person_contact") return fromScorecard("owner_contact")
  return []
}

// ─── the decision (PURE — shared by the runtime door and the selection result) ───────────────────────────────────────

type Verdict = "license_held" | "route_people_gates" | "not_needed" | "blocked_overlap" | "no_records" | "needs_approval" | "over_approval" | "approved"

function decide(f: { dataType: DatafinitiDataType; licenseGaps: string[]; overlap: string[]; gapFields: string[]; count: number | null; credits: number | null; maxCredits: number | null; justified: boolean }): { verdict: Verdict; why: string } {
  if (f.licenseGaps.length) return { verdict: "license_held", why: `LICENSE-HELD — ${f.licenseGaps.join("; ")}` }
  if (f.dataType === "people") return { verdict: "route_people_gates", why: "people records are bought ONLY through runDatafinitiPeoplePull (pre-pull dedup, spend gate, grounded mapper, RawData producer)" }
  if (f.dataType === "product" && !f.justified) return { verdict: "not_needed", why: "product is optional and non-core — no stated need, nothing bought" }
  if (f.overlap.length && f.gapFields.length === 0) return { verdict: "blocked_overlap", why: `already covered by ${f.overlap.join(", ")} — a duplicate spend is blocked (name the gap fields to ask for a field-gap fill)` }
  if (f.count === 0) return { verdict: "no_records", why: "df_count found 0 — a success; nothing to buy" }
  if (f.maxCredits === null) return { verdict: "needs_approval", why: `${f.credits ?? "unknown"} credit(s) estimated — an approver must set a credit ceiling` }
  if (f.credits === null || f.credits > f.maxCredits) return { verdict: "over_approval", why: `${f.credits ?? "unknown"} credit(s) estimated exceeds the approved ceiling ${f.maxCredits}` }
  return { verdict: "approved", why: `${f.credits} credit(s) within the approved ceiling ${f.maxCredits}` }
}

function rightsGaps(rights: DatafinitiUseRights, uses: readonly DatafinitiUse[]): string[] {
  return [...new Set<DatafinitiUse>(["multi_tenant", "storage", ...uses])].filter((u) => rights[u] !== "permitted").map((u) => `${u} ${rights[u].replace("_", " ")}`)
}

// ─── I3 · the provider selection result (read by lib/providers/provider-capability-matrix.ts) ────────────────────────

/**
 * PURE — one row per dataset: the need, the incumbent that serves it, Datafiniti's selection (primary / conditional gap-fill /
 * dormant / not needed) and whether it is LICENSE-held, with the per-record cost where MEASURED (the people plan prices read
 * from the public page) and "unknown" otherwise. ~50,000 records a month is a model scenario, never permission.
 */
export function datafinitiDatasetSelection(facts: { activation?: ProviderActivation; rights?: DatafinitiUseRights; tenantIdxConnected?: boolean } = {}) {
  const activation = facts.activation ?? PROVIDER_ACTIVATION.datafiniti
  const rights = facts.rights ?? DATAFINITI_SOURCE_RIGHTS
  // The people figure is the scorecard's own row (the published plan ceiling) — derived, never re-typed.
  const peopleUnit = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === VENDOR && r.field === "owner_phone")?.unitUsd ?? null
  return (Object.values(DATAFINITI_DATASET_CAPABILITIES) as DatasetCapability[]).map((c) => {
    const incumbents = [...new Set(c.categories.flatMap((k) => incumbentsFor(k, facts.tenantIdxConnected ?? false)))]
    const licenseGaps = [...(activation.state === "active" ? [] : [`activation ${activation.state} (${activation.rights.status})`]), ...rightsGaps(rights, ["enrichment"])]
    const would = decide({ dataType: c.dataType, licenseGaps: [], overlap: incumbents, gapFields: [], count: null, credits: null, maxCredits: null, justified: false })
    const selection = c.dataType === "product" ? "not_needed" : c.dataType === "people" ? "conditional_gap_fill" : would.verdict === "blocked_overlap" ? "dormant" : "conditional_gap_fill"
    return {
      dataType: c.dataType,
      need: c.categories.join(" · "),
      documentedFields: c.documentedFields,
      canonicalDomain: c.canonicalDomain,
      never: c.never,
      incumbents,
      selection,
      selectionWhy: selection === "not_needed" ? "optional, non-core — bought only for a stated need"
        : selection === "dormant" ? `${incumbents.join(" + ")} already serve it — Datafiniti only for a named field gap`
        : c.dataType === "people" ? `behind ${incumbents.join(" + ") || "no active incumbent"} — gap-fill through the established people gates only`
        : "no active incumbent documents it — a conditional source, after rights and a count",
      licenseHeld: licenseGaps.length > 0,
      licenseGaps,
      perRecordCost: c.dataType === "people" && peopleUnit !== null ? `$${peopleUnit} ceiling / record returned (scorecard row: published people plans, read 2026-11-16)` : "unknown — no plan price read for this dataset (charged per record returned)",
      allowedTenantUse: licenseGaps.length ? "none until the licensing decision (multi-tenant, storage, enrichment, AI processing, export, outreach, retention)" : "per the recorded rights",
      liveState: "dormant — no live call on record",
    }
  })
}

// ─── the schema cache (per credential scope + data_type) ─────────────────────────────────────────────────────────────

const SCHEMA_CACHE = new Map<string, { fields: Map<string, string>; at: number }>()

/** A non-reversible scope key: a tenant token is FINGERPRINTED (FNV-1a), never stored — a regenerated token is a new scope. */
function scopeKey(cred: DatafinitiCredential): string {
  if (cred.owner === "platform") return "platform"
  let h = 0x811c9dc5
  for (const ch of cred.token ?? "") { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return `tenant:${cred.brokerageId}:${cred.connectionId}:${h.toString(16)}`
}

/** PURE — flatten a df_get_schema answer (field → type, nested objects in dot notation). null = not a schema. */
function flattenSchema(payload: Record<string, unknown>): Map<string, string> | null {
  const root = (payload.schema ?? payload.fields ?? payload) as unknown
  if (!root || typeof root !== "object" || Array.isArray(root)) return null
  const out = new Map<string, string>()
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === "data_type" || out.size > 5000) continue
      const name = prefix ? `${prefix}.${k}` : k
      if (typeof v === "string") out.set(name, v)
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        const t = (v as Record<string, unknown>).type
        if (typeof t === "string") out.set(name, t)
        if (depth < 4) walk((((v as Record<string, unknown>).properties ?? (typeof t === "string" ? {} : v)) as Record<string, unknown>), name, depth + 1)
      }
    }
  }
  walk(root as Record<string, unknown>, "", 0)
  return out.size ? out : null
}

// ─── the typed query (checked against the REAL schema) ───────────────────────────────────────────────────────────────

export type DatafinitiQueryTerm =
  | { field: string; op: "eq"; value: string | number | boolean }
  | { field: string; op: "any"; values: string[] }
  | { field: string; op: "range"; from: string | number | null; to: string | number | null }

function buildQuery(dataType: DatafinitiDataType, schema: Map<string, string>, terms: readonly DatafinitiQueryTerm[]): { ok: true; query: string; fields: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = []
  const parts: string[] = []
  if (!Array.isArray(terms) || terms.length === 0) return { ok: false, problems: ["no term — a match-everything query is refused"] }
  if (terms.length > 12) return { ok: false, problems: ["more than 12 terms"] }
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  const typed = (type: string, v: unknown, field: string): string | null => {
    if (/int|long|float|double|number|decimal/i.test(type)) return typeof v === "number" && Number.isFinite(v) ? String(v) : (problems.push(`${field}: a number (schema type ${type})`), null)
    if (/date|time/i.test(type)) return typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : (problems.push(`${field}: an ISO date (schema type ${type})`), null)
    if (/bool/i.test(type)) return typeof v === "boolean" ? String(v) : (problems.push(`${field}: true / false (schema type ${type})`), null)
    return typeof v === "string" && v.trim() && v.length <= 120 && !/[\u0000-\u001f]/.test(v) ? quote(v.trim()) : (problems.push(`${field}: a short text value`), null)
  }
  for (const t of terms) {
    const type = schema.get(t?.field)
    if (!t || typeof t.field !== "string" || type === undefined) { problems.push(`${String(t?.field)}: not a field in the ${dataType} schema (df_get_schema) — no hard-coded field reaches the query`); continue }
    // THE DOCUMENTED TRAP — a rental status on the SALE status field (or the reverse) returns ZERO with no error.
    const said: string[] = t.op === "eq" ? [String(t.value)] : t.op === "any" ? t.values.map(String) : []
    if (dataType === "property" && t.field === "mostRecentStatus" && said.some((s) => /rent|lease/i.test(s))) { problems.push("mostRecentStatus: a RENTAL status belongs on mostRecentRentalStatus — on the sale field it returns ZERO with no error (documented trap)"); continue }
    if (dataType === "property" && t.field === "mostRecentRentalStatus" && said.some((s) => /sale|sold/i.test(s))) { problems.push("mostRecentRentalStatus: a SALE status belongs on mostRecentStatus (documented trap)"); continue }
    if (t.op === "eq") { const v = typed(type, t.value, t.field); if (v !== null) parts.push(`${t.field}:${v}`) }
    else if (t.op === "any") {
      const values: unknown[] = Array.isArray(t.values) ? t.values : []
      if (values.length === 0 || values.length > 20) { problems.push(`${t.field}: 1–20 values`); continue }
      const vs = values.map((v: unknown) => typed(type, v, t.field))
      if (vs.every((v: string | null) => v !== null)) parts.push(`${t.field}:(${vs.join(" OR ")})`)
    } else if (t.op === "range") {
      if (!/int|long|float|double|number|decimal|date|time/i.test(type)) { problems.push(`${t.field}: a range needs a numeric or date field (schema type ${type})`); continue }
      const lo = t.from === null ? "*" : typed(type, t.from, t.field), hi = t.to === null ? "*" : typed(type, t.to, t.field)
      if (lo !== null && hi !== null) parts.push(`${t.field}:[${lo} TO ${hi}]`)
    } else problems.push(`${String((t as { field: string }).field)}: unknown operator`)
  }
  if (problems.length) return { ok: false, problems }
  return { ok: true, query: parts.join(" AND "), fields: terms.map((t) => t.field) }
}

// ─── observations (typed, provenance-carrying, canonical-domain bound) ───────────────────────────────────────────────

export interface DatafinitiObservation {
  dataType: DatafinitiDataType
  domain: "property" | "market" | "research"
  brokerageId: string
  vendorRecordId: string | null
  fields: Record<string, unknown>
  labels: Record<string, string>
  dropped: string[]
  mismatches: Array<{ field: string; held: unknown; vendor: unknown; resolution: string }>
  provenance: { vendor: "datafiniti"; query: string; retrievedAt: string; dateUpdated: string | null; sourceAgeDays: number | null; creditShare: number | null; costUsd: number | null }
  rawLead: false
}

const PERSON_KEYS = /^(people|persons?|employees?|contacts?|owners?|firstName|lastName|middleName|personalEmails|professionalEmails|jobTitle)$/i

function observe(dataType: DatafinitiDataType, rec: Record<string, unknown>, ctx: { brokerageId: string; query: string; now: Date; creditShare: number | null; held: Record<string, unknown> | null }): DatafinitiObservation {
  const fields: Record<string, unknown> = {}, labels: Record<string, string> = {}, dropped: string[] = []
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined || k === "id") continue
    if (dataType === "business" && PERSON_KEYS.test(k)) { dropped.push(k); continue }
    fields[k] = v
    if (/price/i.test(k)) labels[k] = "a listed / most-recent price — NEVER a sold price"
    if (/valu|estimat|avm/i.test(k)) labels[k] = "a vendor figure — NOT an appraisal"
  }
  const updated = typeof rec.dateUpdated === "string" && Number.isFinite(Date.parse(rec.dateUpdated)) ? new Date(Date.parse(rec.dateUpdated)).toISOString() : null
  const mismatches = ctx.held ? Object.entries(ctx.held).filter(([k, h]) => k in fields && h !== null && h !== undefined && String(h) !== String(fields[k]))
    .map(([k, h]) => ({ field: k, held: h, vendor: fields[k], resolution: "held value kept; the vendor value is recorded as a conflicting observation for review — never an overwrite" })) : []
  return {
    dataType, domain: dataType === "property" ? "property" : dataType === "business" ? "market" : "research", brokerageId: ctx.brokerageId,
    vendorRecordId: typeof rec.id === "string" || typeof rec.id === "number" ? String(rec.id) : null, fields, labels, dropped, mismatches,
    provenance: { vendor: "datafiniti", query: ctx.query, retrievedAt: ctx.now.toISOString(), dateUpdated: updated, sourceAgeDays: updated ? Math.floor((ctx.now.getTime() - Date.parse(updated)) / 86_400_000) : null, creditShare: ctx.creditShare, costUsd: null },
    rawLead: false,
  }
}

// ─── the door ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Client = { from: (t: string) => any }

export interface DatafinitiDatasetNeed {
  dataType: DatafinitiDataType
  terms: DatafinitiQueryTerm[]
  /** The uses the result is bought for (multi-tenant + storage are always required). */
  uses: DatafinitiUse[]
  /** Fields the incumbent lacks (a field-gap fill) — each must exist in the schema. */
  gapFields?: string[]
  /** product only: the stated need that makes an optional dataset worth a credit. */
  justification?: string | null
  delivery: "search" | "record" | "download"
  numRecords?: number
  recordId?: string
  view?: string[]
}

export interface DatafinitiDatasetDoorInput {
  mode: "discover" | "preflight" | "execute"
  /** The tenant — from the SESSION or the owning row, never a body value. */
  brokerageId: string
  route: "platform" | "tenant"
  /** rights: the tenant's own agreement as use rights — required for preflight / execute (discover reads schemas only). */
  tenantConnection?: { id: string; brokerageId: string; token: string | null; verdict: TenantProviderConnectionVerdict; rights?: DatafinitiUseRights | null } | null
  dataTypes?: DatafinitiDataType[]
  need?: DatafinitiDatasetNeed
  requestId?: string
  approval?: { approvedBy: string; maxCredits: number } | null
  now?: Date
}

interface Checkpoint { id: string; metadata: { download_id?: string; request_id?: string; data_type?: string; query?: string; charge_key?: string } | null }

export interface DatafinitiDatasetDoorDeps {
  client?: DatafinitiClientOptions
  activation?: ProviderActivation
  rights?: DatafinitiUseRights
  tenantIdxConnected?: boolean
  /** Held values for the subject (property mismatch resolution). */
  held?: (dataType: DatafinitiDataType, rec: Record<string, unknown>) => Record<string, unknown> | null
  /** The service client for the default checkpoint (lead_scraping_jobs) and charge-once (vendor_usage_tracking) reads. */
  db?: Client
  checkpoints?: {
    read: (scope: { brokerageId: string; dataType: DatafinitiDataType; requestId: string }) => Promise<{ ok: true; row: Checkpoint | null } | { ok: false; reason: string }>
    write: (scope: { brokerageId: string; dataType: DatafinitiDataType; requestId: string }, meta: Record<string, unknown>) => Promise<boolean>
    close: (scope: { brokerageId: string; id: string }, status: "completed" | "cancelled") => Promise<boolean>
  }
  chargeBooked?: (key: string) => Promise<boolean | null>
  book?: (input: MeterVendorInput) => Promise<boolean>
  fetchDownloadFile?: (url: string) => Promise<Array<Record<string, unknown>> | null>
  /** THE canonical-domain writer for the observations. Absent → nothing is bought (it could not land). */
  deliver?: (observations: DatafinitiObservation[]) => Promise<boolean>
}

export interface DatafinitiDatasetDoorReport {
  ok: boolean
  mode: DatafinitiDatasetDoorInput["mode"]
  stage: "rights" | "schema" | "query" | "count" | "decide" | "approval" | "charge_once" | "charge" | "download_pending" | "land" | "done"
  refused: string | null
  verdict: Verdict | null
  schemas: Array<{ dataType: DatafinitiDataType; ok: boolean; fieldCount: number; cached: boolean; reason: string | null }>
  query: string | null
  count: number | null
  estimatedCredits: number | null
  overlap: string[]
  calls: { free: number; charged: number }
  creditsCharged: number | null
  downloadId: string | null
  resumed: boolean
  observations: DatafinitiObservation[]
  delivered: boolean | null
  booked: boolean
  failure: DatafinitiFailure | null
}

/**
 * THE DOOR. `discover` reads the four schemas (free) for a credential — the tenant settings connect step uses it once the
 * licensing decision admits the connection; `preflight` runs rights → schema → query → count → decide with ZERO charged calls;
 * `execute` continues through approval → charge once → ONE charged step (or a resume) → canonical landing. Never throws.
 */
export async function runDatafinitiDatasetDoor(input: DatafinitiDatasetDoorInput, deps: DatafinitiDatasetDoorDeps = {}): Promise<DatafinitiDatasetDoorReport> {
  const now = input.now ?? new Date()
  const rep: DatafinitiDatasetDoorReport = { ok: false, mode: input.mode, stage: "rights", refused: null, verdict: null, schemas: [], query: null, count: null, estimatedCredits: null, overlap: [], calls: { free: 0, charged: 0 }, creditsCharged: null, downloadId: null, resumed: false, observations: [], delivered: null, booked: false, failure: null }
  const refuse = (stage: DatafinitiDatasetDoorReport["stage"], why: string, failure: DatafinitiFailure | null = null) => ({ ...rep, stage, refused: why, failure })
  try {
    const dc = await import("@/lib/external/datafiniti-client")
    // 1 · RIGHTS — before any call, free ones included.
    if (!input.brokerageId) return refuse("rights", "no tenant — every Datafiniti result is attributed to a tenant")
    let cred: DatafinitiCredential
    let rights: DatafinitiUseRights
    if (input.route === "tenant") {
      const c = input.tenantConnection ?? null
      if (!c) return refuse("rights", "a tenant route names no tenant connection")
      if (c.brokerageId !== input.brokerageId) return refuse("rights", "the connection belongs to another tenant — a tenant's key never serves another tenant")
      const held = ["pending_owner_licensing", "unsupported", "unavailable", "revoked"].includes(c.verdict.state)
      if (held || (input.mode !== "discover" && !c.verdict.mayIngest)) return refuse("rights", `LICENSE-HELD — tenant connection ${c.verdict.state}: ${c.verdict.reason}`)
      cred = { owner: "tenant", brokerageId: input.brokerageId, connectionId: c.id, token: c.token }
      if (!c.rights && input.mode !== "discover") return refuse("rights", "LICENSE-HELD — the tenant connection carries no recorded use rights")
      rights = c.rights ?? DATAFINITI_SOURCE_RIGHTS
    } else {
      const activation = deps.activation ?? PROVIDER_ACTIVATION.datafiniti
      if (activation.state !== "active") return refuse("rights", `LICENSE-HELD — Datafiniti is ${activation.state} (${activation.rights.status}); nothing is called, not even the free schema / count, until the owner's licensing decision`)
      cred = { owner: "platform" }
      rights = deps.rights ?? DATAFINITI_SOURCE_RIGHTS
    }
    const need = input.need ?? null
    if (input.mode !== "discover") {
      if (!need || !dc.DATAFINITI_DATA_TYPES.includes(need.dataType)) return refuse("rights", "a preflight / execute names no dataset need")
      const gaps = rightsGaps(rights, need.uses ?? [])
      if (gaps.length) { rep.verdict = "license_held"; return refuse("rights", `LICENSE-HELD — the source-rights registry does not permit: ${gaps.join("; ")} (${rights.source})`) }
    }

    // 2 · SCHEMA (free, cached per scope + data_type).
    const scope = scopeKey(cred)
    const schemaFor = async (dt: DatafinitiDataType) => {
      const key = `${scope}|${dt}`
      const hit = SCHEMA_CACHE.get(key)
      if (hit && now.getTime() - hit.at < SCHEMA_TTL_MS) { rep.schemas.push({ dataType: dt, ok: true, fieldCount: hit.fields.size, cached: true, reason: null }); return hit.fields }
      const r = await dc.callDatafinitiTool(cred, "df_get_schema", { data_type: dt }, deps.client)
      rep.calls.free += r.attempts
      if (!r.ok) {
        if (r.kind === "auth_failed") for (const k of [...SCHEMA_CACHE.keys()]) if (k.startsWith(`${scope}|`)) SCHEMA_CACHE.delete(k)
        rep.failure = r
        rep.schemas.push({ dataType: dt, ok: false, fieldCount: 0, cached: false, reason: `${r.kind}${r.code ? ` ${r.code}` : ""}: ${r.message}` })
        return null
      }
      const fields = flattenSchema(r.payload)
      if (!fields) { rep.schemas.push({ dataType: dt, ok: false, fieldCount: 0, cached: false, reason: "df_get_schema answered no field map (shape drift)" }); return null }
      SCHEMA_CACHE.set(key, { fields, at: now.getTime() })
      rep.schemas.push({ dataType: dt, ok: true, fieldCount: fields.size, cached: false, reason: null })
      return fields
    }
    if (input.mode === "discover") {
      for (const dt of input.dataTypes?.length ? input.dataTypes : dc.DATAFINITI_DATA_TYPES) { await schemaFor(dt); if (rep.failure?.kind === "auth_failed") break }
      const any = rep.schemas.some((s) => s.ok)
      return { ...rep, ok: any, stage: any ? "done" : "schema", refused: any ? null : rep.schemas.map((s) => s.reason).filter(Boolean).join(" · ") || "no schema read" }
    }
    const n = need!
    const schema = await schemaFor(n.dataType)
    if (!schema) return refuse("schema", `the ${n.dataType} schema could not be read — no query is built blind`, rep.failure)

    // 3 · TYPED QUERY from the real schema.
    const q = buildQuery(n.dataType, schema, n.terms)
    if (!q.ok) return refuse("query", `query refused: ${q.problems.join("; ")}`)
    const missingGap = (n.gapFields ?? []).filter((f) => !schema.has(f))
    if (missingGap.length) return refuse("query", `gap field(s) not in the ${n.dataType} schema: ${missingGap.join(", ")}`)
    rep.query = q.query

    // 4 · COUNT (free). Zero is a success.
    const c = await dc.callDatafinitiTool(cred, "df_count", { data_type: n.dataType, query: q.query }, deps.client)
    rep.calls.free += c.attempts
    if (!c.ok) {
      if (c.code === "unknown_field" || c.code === "invalid_field") SCHEMA_CACHE.delete(`${scope}|${n.dataType}`)
      return refuse("count", `df_count failed (${c.kind}${c.code ? ` ${c.code}` : ""}): ${c.message}`, c)
    }
    const found = typeof c.payload.num_found === "number" ? c.payload.num_found : Number(c.payload.num_found)
    if (!Number.isFinite(found) || found < 0) return refuse("count", "df_count answered without num_found (shape drift)")
    rep.count = found

    // 5 · OVERLAP + 6 · DECIDE (credits estimated from the count; USD unknown — no plan price is invented).
    const cap = DATAFINITI_DATASET_CAPABILITIES[n.dataType]
    rep.overlap = [...new Set(cap.categories.flatMap((k) => incumbentsFor(k, deps.tenantIdxConnected ?? false)))]
    const requested = n.delivery === "record" ? 1 : Math.floor(n.numRecords ?? NaN)
    if (n.delivery !== "record" && !(requested >= 1)) return refuse("decide", "numRecords must be set explicitly (≥ 1)")
    if (n.delivery === "search" && requested > dc.DATAFINITI_MCP_SEARCH_MAX_RECORDS) return refuse("decide", `a search returns at most ${dc.DATAFINITI_MCP_SEARCH_MAX_RECORDS} records per call — use a download`)
    rep.estimatedCredits = Math.min(requested, found)
    const d = decide({ dataType: n.dataType, licenseGaps: [], overlap: rep.overlap, gapFields: n.gapFields ?? [], count: found, credits: rep.estimatedCredits, maxCredits: input.mode === "execute" ? input.approval?.maxCredits ?? null : null, justified: !!(n.justification ?? "").trim() })
    rep.verdict = d.verdict
    if (input.mode === "preflight" || d.verdict === "no_records") return { ...rep, ok: true, stage: d.verdict === "no_records" ? "done" : "decide", refused: ["route_people_gates", "not_needed", "blocked_overlap"].includes(d.verdict) ? d.why : null }
    if (d.verdict !== "approved") return refuse(d.verdict === "needs_approval" || d.verdict === "over_approval" ? "approval" : "decide", d.why)
    if (!input.approval?.approvedBy) return refuse("approval", "the approval names no approver")

    // 7/8 · CHARGE ONCE + a canonical landing must exist.
    if (!deps.deliver) return refuse("charge_once", `no canonical-domain writer for ${n.dataType} observations is wired — nothing is bought that cannot land`)
    const requestId = (input.requestId ?? "").trim()
    if (!requestId) return refuse("charge_once", "no request id — the charge-once key cannot be formed")
    const chargeKey = `datafiniti:${n.dataType}:${input.brokerageId}:${requestId}`
    const ckScope = { brokerageId: input.brokerageId, dataType: n.dataType, requestId }
    const checkpoints = deps.checkpoints ?? (deps.db ? dbCheckpoints(deps.db) : null)
    let open: Checkpoint | null = null
    if (n.delivery === "download") {
      if (!checkpoints) return refuse("charge_once", "no checkpoint store — a download is never started without a resume checkpoint")
      const cp = await checkpoints.read(ckScope)
      if (!cp.ok) return refuse("charge_once", `the download checkpoint could not be read — nothing is started blind (${cp.reason})`)
      open = cp.row
    }
    const chargeBooked = deps.chargeBooked ?? (deps.db ? dbChargeBooked(deps.db) : null)
    if (!open) {
      if (!chargeBooked) return refuse("charge_once", "no spend-ledger read — the charge-once check cannot run")
      const seen = await chargeBooked(chargeKey)
      if (seen === null) return refuse("charge_once", "the spend ledger could not be read — never bought blind")
      if (seen) return refuse("charge_once", `already bought under ${chargeKey} and no checkpoint is open — nothing re-bought; reconcile from the spend ledger`)
    }
    const book = deps.book ?? (async (i: MeterVendorInput) => (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend(i))
    const booking = (credits: number | null, note: string): MeterVendorInput => ({
      vendorName: VENDOR, usageType: `datafiniti_${n.dataType}`, cost: 0, unitCount: Math.max(1, Math.floor(credits ?? rep.estimatedCredits ?? 1)),
      brokerageId: input.brokerageId, priceState: "unknown", costBasis: "estimated", coverage: input.route === "tenant" ? "tenant_paid" : "platform_covered",
      idempotencyKey: chargeKey, systemSource: "datafiniti_dataset_door",
      metadata: { data_type: n.dataType, delivery: n.delivery, credits, credits_basis: credits === null ? "estimated_from_count" : "response_total_cost", approved_by: input.approval!.approvedBy, max_credits: input.approval!.maxCredits, download_id: rep.downloadId, note, ...(input.route === "tenant" ? { cost_payer: "tenant", connection_id: input.tenantConnection?.id ?? null } : {}) },
    })
    const view = n.view?.length ? { view: n.view } : {}

    // 9 · ONE CHARGED STEP (or a resume).
    let records: Array<Record<string, unknown>> = []
    let totalCost: number | null = null
    if (n.delivery === "download") {
      let downloadId = typeof open?.metadata?.download_id === "string" ? open.metadata.download_id : null
      if (open && !downloadId) return refuse("charge_once", `checkpoint ${open.id} carries no download id — held for a person (never re-bought)`)
      if (downloadId) rep.resumed = true
      else {
        const s = await dc.callDatafinitiTool(cred, "df_start_download", { data_type: n.dataType, query: q.query, format: "JSON", ...view }, deps.client)
        rep.calls.charged += s.attempts
        if (!s.ok) return refuse("charge", `df_start_download failed (${s.kind}${s.code ? ` ${s.code}` : ""}): ${s.message}${s.kind === "outcome_unknown" ? " — OUTCOME UNKNOWN: not re-sent; reconcile before any re-ask" : ""}`, s)
        const dl = s.payload.download && typeof s.payload.download === "object" ? (s.payload.download as Record<string, unknown>) : s.payload
        const id = dl.id ?? dl.download_id
        downloadId = typeof id === "number" || (typeof id === "string" && /^\d{1,20}$/.test(id)) ? String(id) : null
        if (!downloadId) return refuse("charge", "df_start_download answered no download id (shape drift) — held for a person", null)
        rep.downloadId = downloadId
        const written = await checkpoints!.write(ckScope, { download_id: downloadId, request_id: requestId, data_type: n.dataType, query: q.query, charge_key: chargeKey, route: input.route })
        rep.booked = await book(booking(typeof s.payload.total_cost === "number" ? s.payload.total_cost : null, "download_started"))
        if (!written) return refuse("charge", `download ${downloadId} started but its checkpoint was NOT written — booked under ${chargeKey}, so it is never re-bought; a person resumes it`)
      }
      rep.downloadId = downloadId
      const st = await dc.datafinitiDownloadStatus(cred, downloadId, deps.client)
      rep.calls.free += st.attempts
      if (!st.ok) return refuse("download_pending", `download status unreadable (${st.kind}): ${st.message} — resume with download_id ${downloadId}`, st)
      if (st.status === "cancelled") { if (open) await checkpoints!.close({ brokerageId: input.brokerageId, id: open.id }, "cancelled"); return refuse("download_pending", "the download was cancelled") }
      if (st.status !== "completed") return { ...rep, ok: true, stage: "download_pending" }
      const fetchFile = deps.fetchDownloadFile ?? (async (url: string) => (await (await import("@/lib/lead-pipeline/datafiniti-territory-door")).readDatafinitiDownloadFile()(url)) as Array<Record<string, unknown>> | null)
      for (const link of st.links) {
        const part = await fetchFile(link)
        if (part === null) return refuse("download_pending", "a result file could not be read (expired after 7 days, refused, or unreadable) — the checkpoint stays open; re-run the download only by a person's decision")
        records.push(...part)
      }
    } else {
      const s = n.delivery === "record"
        ? await dc.callDatafinitiTool(cred, "df_get_record", { data_type: n.dataType, id: String(n.recordId ?? "") }, deps.client)
        : await dc.callDatafinitiTool(cred, "df_search", { data_type: n.dataType, query: q.query, num_records: requested, ...view }, deps.client)
      rep.calls.charged += s.attempts
      if (!s.ok) return refuse("charge", `${n.delivery} failed (${s.kind}${s.code ? ` ${s.code}` : ""}): ${s.message}${s.kind === "outcome_unknown" ? " — OUTCOME UNKNOWN: not re-sent; reconcile before any re-ask" : ""}`, s)
      totalCost = typeof s.payload.total_cost === "number" ? s.payload.total_cost : n.delivery === "record" ? 1 : null
      const rs = n.delivery === "record" ? [s.payload.record ?? s.payload] : s.payload.records
      records = Array.isArray(rs) ? rs.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : []
      rep.creditsCharged = totalCost
      rep.booked = await book(booking(totalCost, n.delivery))
    }

    // 10 · LAND — typed observations into the canonical domain (never Raw Lead), provenance + credit share kept.
    const share = totalCost !== null && records.length ? Math.round((totalCost / records.length) * 1e6) / 1e6 : null
    rep.observations = records.map((r) => observe(n.dataType, r, { brokerageId: input.brokerageId, query: q.query, now, creditShare: share, held: deps.held ? deps.held(n.dataType, r) : null }))
    rep.delivered = await deps.deliver(rep.observations)
    if (!rep.delivered) return refuse("land", "the canonical-domain writer refused the observations — the checkpoint (if any) stays open")
    if (n.delivery === "download") {
      const cp = open ?? (await checkpoints!.read(ckScope).then((r) => (r.ok ? r.row : null)))
      if (cp) await checkpoints!.close({ brokerageId: input.brokerageId, id: cp.id }, "completed")
    }
    return { ...rep, ok: true, stage: "done" }
  } catch (e) {
    return refuse("done", `the Datafiniti dataset door threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── production seams (tenant-pinned; every write COUNTED) ───────────────────────────────────────────────────────────

function dbCheckpoints(db: Client): NonNullable<DatafinitiDatasetDoorDeps["checkpoints"]> {
  return {
    read: async (s) => {
      const { data, error } = await db.from("lead_scraping_jobs").select("id, metadata").eq("job_type", DATAFINITI_DATASET_DOWNLOAD_JOB_TYPE)
        .eq("brokerage_id", s.brokerageId).eq("status", "running").eq("metadata->>request_id", s.requestId).eq("metadata->>data_type", s.dataType).limit(1)
      if (error) return { ok: false, reason: `lead_scraping_jobs: ${error.message ?? String(error)}` }
      return { ok: true, row: Array.isArray(data) ? ((data[0] as Checkpoint | undefined) ?? null) : null }
    },
    write: async (s, meta) => {
      const { data, error } = await db.from("lead_scraping_jobs").insert({ job_type: DATAFINITI_DATASET_DOWNLOAD_JOB_TYPE, source: `datafiniti_${s.dataType}`, status: "running", brokerage_id: s.brokerageId, market_id: null, leads_found: 0, leads_created: 0, started_at: new Date().toISOString(), metadata: meta }).select("id")
      return !error && Array.isArray(data) && data.length === 1
    },
    close: async (s, status) => {
      const { data, error } = await db.from("lead_scraping_jobs").update({ status, completed_at: new Date().toISOString() }).eq("id", s.id).eq("brokerage_id", s.brokerageId).eq("job_type", DATAFINITI_DATASET_DOWNLOAD_JOB_TYPE).select("id")
      return !error && Array.isArray(data) && data.length === 1
    },
  }
}

function dbChargeBooked(db: Client): (key: string) => Promise<boolean | null> {
  return async (key) => {
    const { data, error } = await db.from("vendor_usage_tracking").select("id").eq("vendor_name", VENDOR).eq("request_metadata->>idempotency_key", key).limit(1)
    if (error) return null
    return Array.isArray(data) && data.length > 0
  }
}
