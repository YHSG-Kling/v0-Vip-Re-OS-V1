// lib/intent/dataset-verification.ts
//
// C19 — DATASET VERIFICATION IN THE MARKET REGISTRY (wave 148, lane 148F; owner ruling 6, 2026-11-01: "create a dataset verification
// in the market registry"; "probate / deed-transfer / relocation / permit datasets verified before use").
//
// THE CONTRACT. Every dataset the OS may read a movement signal from carries ONE verification contract:
//
//   source · license · geography · coverage · freshness · last_verified_at · confidence · data_rights · drift · verified_by
//
// and the rule the owner asked for: A SOURCE THE REGISTRY MARKS UNVERIFIED CANNOT RAISE A SIGNAL ABOVE `unknown`. The rule is
// enforced at the ONE persistence chokepoint (lib/intent/movement-signals.ts recordMovementSignal — every C9 write, the watcher's
// pre-built records included, is re-validated there): a public-record record whose dataset is not `verified` is stored as
// `unknown` (weight 0 in the combination; the arbiter hook never reads it as a life change) or — for an intimate topic, which the
// database refuses to store as `unknown` (m892 movement_signals_no_intimate_inference) — refused with `dataset_unverified`.
//
// THE SURVIVORS (LAW 1 — no fourth registry):
//   the dataset entries   lib/external/socrata-market-registry.ts MARKETS (the permit sweep's coverage — each entry's verifiedOn /
//                         unavailable / license / lastDataAt) + MARKET_DATASET_CANDIDATES (probate / deed / street-use candidates,
//                         verified by id or marked). This module DERIVES one contract per dataset from them; it restates nothing.
//   the feed observation  lib/external/permit-signals.ts ingestPermitSignals → DatasetProbe per queried dataset (the "permitted
//                         feed" that already runs daily) → recordDatasetObservations here → market_dataset_verifications (m918):
//                         a refusal after a verified state is DRIFT; a served window with rows is FRESHNESS.
//   the store             market_dataset_verifications (m918) — an append-only verification log, platform-scoped (a dataset is
//                         public data, not a tenant's record), service-role writes, authenticated read. The latest row per dataset
//                         is overlaid on the code contract; the code contract (license, the live-row read) is never overwritten by
//                         an observation — a sweep can prove a feed is MOVING, never that the platform may USE it.
//
// STATUS (pure, `now` injectable — no proof pins wall-clock):
//   unavailable  the registry marks it unavailable (dead id, archival, non-residential, wrong provider);
//   unverified   no live row was ever read (`verifiedOn` absent), or the license was never read;
//   drifted      the latest observation contradicts the verified state (the feed refused / changed shape);
//   stale        the live-row read is older than VERIFICATION_TTL_DAYS, or the newest data is older than the dataset's maxLagDays;
//   verified     a live row was read, the license was read, the data is fresh and nothing drifted since.
// Only `verified` lends the `verified` ceiling; every other status lends `unknown`.
//
// NOT server-only: driven by scripts/movement-signals-guard.ts and scripts/life-event-engagement-guard.ts on an in-memory client.

import {
  MARKETS, MARKET_DATASET_CANDIDATES, INGESTIBLE_KINDS, isQueryableDataset, providerOf,
  type DatasetLicence, type PermitDatasetSpec, type SocrataDatasetKind,
} from "@/lib/external/socrata-market-registry"

type Svc = { from: (t: string) => any }
const DAY_MS = 86_400_000

/** A live-row read older than this is `stale` until someone (or the sweep's own verified read) refreshes it. */
export const VERIFICATION_TTL_DAYS = 180
/** The default freshness window when a dataset names none (publisher cadence + lag). */
export const DEFAULT_MAX_LAG_DAYS = 30

export const DATASET_VERIFICATION_STATUSES = Object.freeze(["verified", "stale", "drifted", "unverified", "unavailable"] as const)
export type DatasetVerificationStatus = (typeof DATASET_VERIFICATION_STATUSES)[number]
export const DATASET_VERIFICATION_METHODS = Object.freeze(["registry_seed", "live_row_read", "sweep_observation", "catalog_probe", "manual"] as const)
export type DatasetVerificationMethod = (typeof DATASET_VERIFICATION_METHODS)[number]
export type DatasetKind = SocrataDatasetKind | "change_of_address"
export type DatasetProvider = "socrata" | "arcgis" | "file" | "licensed_api"

/** THE C19 CONTRACT — one per dataset. */
export interface DatasetVerification {
  /** `${host}/${datasetId}` — the same key the permit sweep dedupes on. */
  datasetKey: string
  host: string
  datasetId: string
  provider: DatasetProvider
  kind: DatasetKind
  label: string
  /** Who publishes it (the host / agency). */
  source: string
  /** The territories the registry binds it to (`STATE:City`). */
  geography: { markets: string[] }
  /** What population it covers, in words. */
  coverage: string
  licence: DatasetLicence | null
  /** What the platform may do with what it reads. */
  dataRights: { storage: "derived_fact_only" | "contract_required"; republish: false; outreach: "per_consent" | "address_correction_only" | "none" }
  freshness: { lastDataAt: string | null; maxLagDays: number }
  lastVerifiedAt: string | null
  /** The epistemic CEILING this dataset may lend a record: only a verified dataset lends `verified`. */
  confidence: "verified" | "unknown"
  status: DatasetVerificationStatus
  drift: string | null
  verifiedBy: string
  method: DatasetVerificationMethod
  /** Why the status is what it is (each failed check named). */
  reasons: string[]
  /** The permit sweep reads it today (MARKETS + an ingestible kind + queryable). */
  ingested: boolean
}

export interface DatasetCeiling { datasetKey: string | null; ceiling: "verified" | "unknown"; status: DatasetVerificationStatus; reason: string }

const KIND_COVERAGE: Readonly<Record<DatasetKind, string>> = Object.freeze({
  permits: "issued building permits at an address (a structure fact, never a person)",
  code_violations: "code-violation notices at an address (pressure, not intent)",
  probate: "probate case filings (decedent / estate)",
  property_transfers: "recorded deeds and other property documents (a transfer of a property)",
  street_use_permits: "street-use / right-of-way permits at an address (a dumpster or moving container on the street)",
  change_of_address: "a mail-forwarding change of address for people a tenant already serves",
})

const keyOf = (s: Pick<PermitDatasetSpec, "host" | "datasetId">): string => `${s.host}/${s.datasetId}`
const isoOrNull = (v: unknown): string | null => { const t = v ? Date.parse(String(v)) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null }

/** PURE. The status of one contract at `now` (drift and freshness overlays already applied). */
function statusOf(c: Pick<DatasetVerification, "licence" | "lastVerifiedAt" | "freshness" | "drift"> & { unavailable: string | null }, now: Date): { status: DatasetVerificationStatus; reasons: string[] } {
  const reasons: string[] = []
  if (c.unavailable) return { status: "unavailable", reasons: [c.unavailable] }
  if (!c.lastVerifiedAt) reasons.push("no live row was ever read from it")
  if (!c.licence || c.licence.class === "unknown") reasons.push("its license / data rights were never read")
  if (reasons.length > 0) return { status: "unverified", reasons }
  if (c.drift) return { status: "drifted", reasons: [c.drift] }
  const verifiedAge = (now.getTime() - Date.parse(c.lastVerifiedAt!)) / DAY_MS
  if (verifiedAge > VERIFICATION_TTL_DAYS) reasons.push(`the live-row read is ${Math.floor(verifiedAge)} days old (more than ${VERIFICATION_TTL_DAYS})`)
  if (c.freshness.lastDataAt) {
    const dataAge = (now.getTime() - Date.parse(c.freshness.lastDataAt)) / DAY_MS
    if (dataAge > c.freshness.maxLagDays) reasons.push(`its newest data is ${Math.floor(dataAge)} days old (more than its ${c.freshness.maxLagDays}-day window)`)
  } else reasons.push("its data freshness was never measured")
  if (reasons.length > 0) return { status: "stale", reasons }
  return { status: "verified", reasons: ["live row read, license read, data fresh, no drift since"] }
}

function contractFor(spec: PermitDatasetSpec, markets: string[], ingested: boolean, now: Date): DatasetVerification {
  const base = {
    datasetKey: keyOf(spec), host: spec.host, datasetId: spec.datasetId, provider: providerOf(spec) as DatasetProvider, kind: spec.kind as DatasetKind, label: spec.label,
    source: spec.host, geography: { markets: [...new Set(markets)].sort() }, coverage: KIND_COVERAGE[spec.kind as DatasetKind],
    licence: spec.licence ?? null,
    dataRights: { storage: "derived_fact_only" as const, republish: false as const, outreach: "per_consent" as const },
    freshness: { lastDataAt: isoOrNull(spec.lastDataAt), maxLagDays: spec.maxLagDays ?? DEFAULT_MAX_LAG_DAYS },
    lastVerifiedAt: isoOrNull(spec.verifiedOn), drift: null as string | null,
    verifiedBy: spec.verifiedOn ? "registry: a live row read by id (lib/external/socrata-market-registry.ts)" : "nobody",
    method: (spec.verifiedOn ? "live_row_read" : "registry_seed") as DatasetVerificationMethod, ingested,
  }
  const st = statusOf({ ...base, unavailable: spec.unavailable ?? null }, now)
  return { ...base, status: st.status, reasons: st.reasons, confidence: st.status === "verified" ? "verified" : "unknown" }
}

/** Non-dataset candidates the movement registry names (each WAITING on a contract, never an open dataset). */
const CONTRACT_CANDIDATES: readonly DatasetVerification[] = Object.freeze([
  {
    datasetKey: "usps.ncoalink/processing-acknowledgement", host: "usps.ncoalink", datasetId: "processing-acknowledgement", provider: "licensed_api", kind: "change_of_address",
    label: "USPS NCOALink (via a licensed processor) — relocation for people a tenant already serves", source: "USPS NCOALink licensees (e.g. TrueNCOA)",
    geography: { markets: ["US:national"] }, coverage: KIND_COVERAGE.change_of_address,
    licence: { class: "unknown", text: "USPS NCOALink EULA v30 (2026-07-15): 'sole purpose … a mailing list correction tool … may not be used to create, generate, or maintain new movers lists'; a Processing Acknowledgement Form per list owner — no agreement held", readOn: "2026-10-31" },
    dataRights: { storage: "contract_required", republish: false, outreach: "address_correction_only" },
    freshness: { lastDataAt: null, maxLagDays: 90 }, lastVerifiedAt: null, confidence: "unknown", status: "unverified", drift: null,
    verifiedBy: "nobody — WAITING_EXTERNAL (lib/intent/movement-source-registry.ts we_usps_ncoa)", method: "registry_seed",
    reasons: ["no processing agreement (PAF) is held — contract required before any read", "address correction only — never a movers list"], ingested: false,
  },
])

/**
 * PURE. EVERY dataset contract, derived from the market registry at `now`: each MARKETS dataset once (a county dataset bound to ten
 * cities is ONE contract with ten markets), each candidate, and the contract-only candidates.
 */
function marketDatasetVerifications(now: Date = new Date()): DatasetVerification[] {
  const byKey = new Map<string, { spec: PermitDatasetSpec; markets: string[]; ingested: boolean }>()
  for (const [market, m] of Object.entries(MARKETS)) {
    for (const d of m.datasets) {
      const k = keyOf(d)
      const cur = byKey.get(k) ?? { spec: d, markets: [], ingested: false }
      cur.markets.push(market)
      cur.ingested = cur.ingested || (INGESTIBLE_KINDS.includes(d.kind) && isQueryableDataset(d))
      byKey.set(k, cur)
    }
  }
  for (const c of MARKET_DATASET_CANDIDATES) {
    const k = keyOf(c)
    const cur = byKey.get(k) ?? { spec: c, markets: [], ingested: false }
    cur.markets.push(c.market)
    byKey.set(k, cur)
  }
  return [...[...byKey.values()].map((v) => contractFor(v.spec, v.markets, v.ingested, now)), ...CONTRACT_CANDIDATES.map((c) => ({ ...c, reasons: [...c.reasons], geography: { markets: [...c.geography.markets] } }))]
}

/** The latest observation per dataset (m918), as overlaid on the code contract. */
interface DatasetObservationOverlay { status: DatasetVerificationStatus; drift: string | null; lastDataAt: string | null; lastVerifiedAt: string | null; method: DatasetVerificationMethod; verifiedBy: string }

/** PURE. A code contract + its latest observation → the contract now. An observation can prove MOVEMENT (freshness) or DRIFT; it never
 *  supplies a license or a live-row read the registry lacks (a sweep that ran is not a license). */
function applyObservation(c: DatasetVerification, o: DatasetObservationOverlay | null | undefined, now: Date): DatasetVerification {
  if (!o) return c
  const lastDataAt = [c.freshness.lastDataAt, o.lastDataAt].filter((x): x is string => !!x).sort().pop() ?? null
  const drift = o.status === "drifted" ? (o.drift ?? "the latest observation refused") : null
  const merged = { ...c, freshness: { ...c.freshness, lastDataAt }, drift }
  // A verified sweep read refreshes the live-row proof only when the registry already read one (columns + license).
  if (o.method === "sweep_observation" && o.status === "verified" && c.lastVerifiedAt && o.lastVerifiedAt && o.lastVerifiedAt > c.lastVerifiedAt) merged.lastVerifiedAt = o.lastVerifiedAt
  if (o.method !== "sweep_observation" && o.lastVerifiedAt && (!c.lastVerifiedAt || o.lastVerifiedAt > c.lastVerifiedAt)) merged.lastVerifiedAt = o.lastVerifiedAt
  const unavailable = c.status === "unavailable" ? c.reasons[0] ?? "unavailable" : null
  const st = statusOf({ ...merged, unavailable }, now)
  return { ...merged, status: st.status, reasons: st.reasons, confidence: st.status === "verified" ? "verified" : "unknown", verifiedBy: o.verifiedBy || c.verifiedBy, method: o.method }
}

/**
 * PURE. The ceiling a record citing `datasetKey` may carry. An unnamed or unregistered dataset is `unverified` (fail closed: a
 * public-record record that cannot say which dataset it came from cannot be verified).
 */
function datasetCeilingFor(datasetKey: string | null | undefined, opts: { now?: Date; overlay?: DatasetObservationOverlay | null } = {}): DatasetCeiling {
  const now = opts.now ?? new Date()
  if (!datasetKey) return { datasetKey: null, ceiling: "unknown", status: "unverified", reason: "the record names no dataset — a public record that cannot say where it came from is never verified" }
  const c = marketDatasetVerifications(now).find((x) => x.datasetKey === datasetKey)
  if (!c) return { datasetKey, ceiling: "unknown", status: "unverified", reason: `${datasetKey} is not in the market registry` }
  const v = applyObservation(c, opts.overlay ?? null, now)
  return { datasetKey, ceiling: v.confidence, status: v.status, reason: v.reasons.join("; ") }
}

// ── the store (m918 market_dataset_verifications) ────────────────────────────────────────────────────────────────────────────

interface VerificationRow { dataset_key: string; status: DatasetVerificationStatus; drift: string | null; freshness: { last_data_at?: string | null } | null; last_verified_at: string | null; method: DatasetVerificationMethod; verified_by: string; observed_at?: string }

const overlayOf = (r: VerificationRow): DatasetObservationOverlay => ({
  status: r.status, drift: r.drift ?? null, lastDataAt: isoOrNull(r.freshness?.last_data_at ?? null), lastVerifiedAt: isoOrNull(r.last_verified_at), method: r.method, verifiedBy: r.verified_by,
})

/** The latest observation per dataset key (or for `keys`). A refused read is returned as an error — the caller decides (never "no drift"). */
async function loadDatasetObservations(svc: Svc, keys?: readonly string[]): Promise<{ overlays: Map<string, DatasetObservationOverlay>; error: string | null }> {
  const overlays = new Map<string, DatasetObservationOverlay>()
  try {
    // Ordered by WHEN IT WAS OBSERVED (never by last_verified_at — a refusal today carries an older verification date and must
    // still be the latest word).
    let q = svc.from("market_dataset_verifications").select("dataset_key, status, drift, freshness, last_verified_at, method, verified_by, observed_at")
    if (keys && keys.length > 0) q = q.in("dataset_key", [...keys])
    const { data, error } = await q.order("observed_at", { ascending: false }).limit(keys && keys.length > 0 ? 20 * keys.length : 500)
    if (error) return { overlays, error: `market_dataset_verifications read refused: ${error.message}` }
    for (const r of (data ?? []) as VerificationRow[]) if (!overlays.has(r.dataset_key)) overlays.set(r.dataset_key, overlayOf(r))
    return { overlays, error: null }
  } catch (e) {
    return { overlays, error: `market_dataset_verifications read threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The ceiling for ONE dataset with its latest stored observation applied (the persistence chokepoint calls this). Never throws. */
export async function datasetCeilingWithObservations(svc: Svc, datasetKey: string | null | undefined, now: Date): Promise<DatasetCeiling & { blindSpot: string | null }> {
  if (!datasetKey) return { ...datasetCeilingFor(null, { now }), blindSpot: null }
  const obs = await loadDatasetObservations(svc, [datasetKey])
  // An unreadable observation log keeps the CODE contract (itself a dated verification) and says so — it never upgrades anything.
  return { ...datasetCeilingFor(datasetKey, { now, overlay: obs.overlays.get(datasetKey) ?? null }), blindSpot: obs.error }
}

/** The shape lib/external/permit-signals.ts DatasetProbe already reports per queried dataset (structural — no import of the sweep). */
export interface DatasetProbeLike { dataset: string; label?: string; provider?: string; status: number | null; ok: boolean; rows: number; truncated?: boolean; error: string | null }

/**
 * THE FEED OBSERVATION WRITER — the daily permit sweep's per-dataset probes → one m918 row per (dataset, day, outcome). A served
 * window WITH rows is freshness (the newest data is at least as new as the window's start — a conservative lower bound); a served
 * empty window changes nothing but the observation time; a REFUSAL after a verified state is DRIFT (the dataset lends `unknown`
 * until a later served read). One row per dataset per day per outcome (idempotency key) — the sweep runs per tenant and must not
 * write ten copies of one fact. Never throws; every refused insert is counted and named.
 */
export async function recordDatasetObservations(
  svc: Svc,
  a: { probes: readonly DatasetProbeLike[]; windowSinceIso: string; observedAt?: Date },
): Promise<{ recorded: number; replayed: number; drifted: string[]; errors: string[] }> {
  const out = { recorded: 0, replayed: 0, drifted: [] as string[], errors: [] as string[] }
  const now = a.observedAt ?? new Date()
  const day = now.toISOString().slice(0, 10)
  const contracts = new Map(marketDatasetVerifications(now).map((c) => [c.datasetKey, c]))
  for (const p of a.probes) {
    try {
      const c = contracts.get(p.dataset)
      if (!c) { out.errors.push(`${p.dataset}: not in the market registry — not recorded`); continue }
      const served = p.ok === true
      const drift = served ? null : `the feed refused on ${day}${p.status ? ` (HTTP ${p.status})` : ""}: ${String(p.error ?? "no reason given").slice(0, 300)}`
      const lastDataAt = served && p.rows > 0 ? isoOrNull(a.windowSinceIso) : null
      const observed = applyObservation(c, { status: served ? "verified" : "drifted", drift, lastDataAt, lastVerifiedAt: served && p.rows > 0 ? now.toISOString() : null, method: "sweep_observation", verifiedBy: "manager:data_steward (permit sweep observation)" }, now)
      const row = {
        dataset_key: c.datasetKey, host: c.host, dataset_id: c.datasetId, provider: c.provider, kind: c.kind, label: c.label.slice(0, 300),
        source: c.source, licence: c.licence, geography: c.geography, coverage: c.coverage, data_rights: c.dataRights,
        freshness: { last_data_at: observed.freshness.lastDataAt, max_lag_days: observed.freshness.maxLagDays, window_since: a.windowSinceIso, rows: p.rows, truncated: p.truncated === true },
        last_verified_at: observed.lastVerifiedAt, observed_at: now.toISOString(), confidence: observed.confidence, status: observed.status, drift: observed.drift,
        method: "sweep_observation" as const, verified_by: "manager:data_steward (permit sweep observation)",
        evidence: { http_status: p.status, ok: served, rows: p.rows, error: p.error ?? null, reasons: observed.reasons.slice(0, 5) },
        idempotency_key: `dataset_observation:${c.datasetKey}:${day}:${served ? "served" : "refused"}`,
      }
      const { error } = await svc.from("market_dataset_verifications").insert(row)
      if (error) {
        if (String((error as { code?: string }).code) === "23505") { out.replayed++; continue }
        out.errors.push(`${c.datasetKey}: market_dataset_verifications insert refused: ${error.message}`)
        continue
      }
      out.recorded++
      if (observed.status === "drifted") out.drifted.push(c.datasetKey)
    } catch (e) {
      out.errors.push(`${p.dataset}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

/**
 * The lead desk's read (app/actions/movement-signals.ts listMovementSignalsAction): every contract with its latest observation applied,
 * sorted so what cannot lend a signal is visible first. Read-only; the caller gates the seat first.
 */
export async function listMarketDatasetVerifications(svc: Svc, opts: { now?: Date } = {}): Promise<{ verifications: DatasetVerification[]; error: string | null }> {
  const now = opts.now ?? new Date()
  const obs = await loadDatasetObservations(svc)
  const rank: Record<DatasetVerificationStatus, number> = { drifted: 0, stale: 1, unverified: 2, unavailable: 3, verified: 4 }
  const verifications = marketDatasetVerifications(now).map((c) => applyObservation(c, obs.overlays.get(c.datasetKey) ?? null, now))
    .sort((x, y) => rank[x.status] - rank[y.status] || x.datasetKey.localeCompare(y.datasetKey))
  return { verifications, error: obs.error }
}
