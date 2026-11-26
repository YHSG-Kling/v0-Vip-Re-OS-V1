// lib/intent/public-record-facts.ts
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC-RECORD PROPERTY FACTS — the NYC ACRIS deed reader and the Cambridge MA street-use (dumpster) permit reader
// (wave 153, lane 153K — convergence row 89; directive K1: "where source rights permit, implement property/market facts, not
// private-person invention, with proper source/date evidence; log live validation as owner-held").
//
// SURVIVOR VERDICT (CLAUDE.md §1): the datasets were VERIFIED by id in wave 148 (lib/external/socrata-market-registry.ts
// MARKET_DATASET_CANDIDATES — ACRIS Real Property Master bnx9-e6tj + Legals 8h5j-fqxa, Cambridge 8xmj-thsm, each with its
// license read) and the movement registry named their source keys (pr_property_transfer_open_data, pr_street_use_permit) as
// "configuration-only until an adapter files it". This is that adapter — and ONLY the adapter: the HTTP client is the existing
// lib/external/socrata-client.ts socrataQuery, the C19 gate is lib/intent/dataset-verification.ts datasetCeilingWithObservations,
// the address key is lib/external/permit-signals.ts normalizeStreetAddress, the store is the permit sweep's own table
// (motivated_seller_signals, detected_via 'socrata', dataset_host / dataset_id stamped), and the movement watcher's EXISTING
// stored-sweep source turns each filed row into a movement record (movementSignalFromSellerSignalRow). No new table, client,
// cron or watcher.
//
// PROPERTY FACTS, NEVER PEOPLE. ACRIS Parties (names) is never registered or read; Cambridge's contractor_or_client column is
// never selected. A fact is filed only against an address a lead or contact the tenant ALREADY owns carries — it never mints a
// person. A dumpster on the street is a renovation OR a move-out: it is filed as a street-use fact, never read as either alone.
//
// RIGHTS AND FRESHNESS. A candidate is read only while its C19 verification lends a ceiling (status verified or stale — a stale
// verification is re-checked BY this read, and the cron records the observation in market_dataset_verifications); unverified,
// drifted or unavailable datasets are refused by name. ACRIS publishes with a ~4-5 week lag, so its window is the dataset's own
// maxLagDays plus a week; every read is capped and a truncated window is said, never silent.
//
// Consumer: app/api/cron/permit-signal-scan/route.ts (the daily public-record sweep, per tenant territory). Proof:
// scripts/movement-signals-guard.ts §R89.

import type { SupabaseClient } from "@supabase/supabase-js"
import { MARKET_DATASET_CANDIDATES } from "@/lib/external/socrata-market-registry"

type Svc = SupabaseClient<any, any, any>
type Row = Record<string, unknown>
type Query = (p: { host: string; datasetId: string; query: { select?: string; where?: string; order?: string; limit?: number; offset?: number } }) => Promise<{ ok: boolean; status: number | null; data: Row[]; error: string | null }>

/** The signal types this adapter files (no CHECK constrains motivated_seller_signals.signal_type; m499's index is permit-only). */
const PUBLIC_RECORD_SIGNAL_TYPES = ["deed_recorded", "street_use_permit"] as const
type PublicRecordSignalType = (typeof PUBLIC_RECORD_SIGNAL_TYPES)[number]

/** Rows read per page and pages per dataset per run — a truncated window is reported, never silent. */
const PAGE = 1000
const MAX_PAGES = 3
const LEGALS_CHUNK = 100

const ACRIS_MASTER = "data.cityofnewyork.us/bnx9-e6tj"
const ACRIS_LEGALS = "data.cityofnewyork.us/8h5j-fqxa"
const CAMBRIDGE_STREET_USE = "data.cambridgema.gov/8xmj-thsm"
const BOROUGHS: Readonly<Record<string, string>> = Object.freeze({ "1": "Manhattan", "2": "Bronx", "3": "Brooklyn", "4": "Queens", "5": "Staten Island" })
const NYC_CITY_NAMES = new Set(["new york", "new york city", "nyc", "manhattan", "bronx", "the bronx", "brooklyn", "queens", "staten island"])

interface PublicRecordFact {
  signalType: PublicRecordSignalType
  datasetKey: string
  host: string
  datasetId: string
  recordId: string
  address: string
  /** The city the fact belongs to (NYC borough name for ACRIS). */
  city: string
  /** When the event happened at the source (recorded / issued), ISO. */
  eventAt: string
  sourceUrl: string
  detail: Record<string, string | boolean | null>
}

interface DatasetProbe { dataset: string; label: string; provider: string; status: number | null; ok: boolean; rows: number; matched: number; truncated: boolean; error: string | null }

const keyOf = (c: { host: string; datasetId: string }) => `${c.host}/${c.datasetId}`
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const str = (v: unknown): string | null => (v == null || String(v).trim() === "" ? null : String(v).trim())
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** The registry candidate for a dataset key (or null) — read-only. */
function candidate(datasetKey: string) {
  return MARKET_DATASET_CANDIDATES.find((c) => keyOf(c) === datasetKey) ?? null
}

/** PURE — ACRIS master (deeds) joined to Legals (the address half) on document_id → deed facts. Names are never read. */
function acrisDeedFacts(master: readonly Row[], legals: readonly Row[]): PublicRecordFact[] {
  const byDoc = new Map<string, Row>()
  for (const l of legals) { const id = str(l.document_id); if (id && !byDoc.has(id)) byDoc.set(id, l) }
  const out: PublicRecordFact[] = []
  for (const m of master) {
    const id = str(m.document_id)
    if (!id || String(m.doc_type ?? "").toUpperCase() !== "DEED") continue
    const at = Date.parse(String(m.recorded_datetime ?? ""))
    const l = byDoc.get(id)
    const num = str(l?.street_number), street = str(l?.street_name), borough = BOROUGHS[String(l?.borough ?? "")] ?? null
    if (!Number.isFinite(at) || !num || !street || !borough) continue
    out.push({
      signalType: "deed_recorded", datasetKey: ACRIS_MASTER, host: "data.cityofnewyork.us", datasetId: "bnx9-e6tj", recordId: id,
      address: `${num} ${street}`, city: borough, eventAt: new Date(at).toISOString(),
      sourceUrl: `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentImageView?doc_id=${encodeURIComponent(id)}`,
      detail: { doc_type: "DEED", borough, block: str(l?.block), lot: str(l?.lot) },
    })
  }
  return out
}

/** PURE — Cambridge street-use permits → street-use facts. The applicant column is never selected or read. */
function streetUseFacts(rows: readonly Row[]): PublicRecordFact[] {
  const out: PublicRecordFact[] = []
  for (const r of rows) {
    const address = str(r.address), at = Date.parse(String(r.issue_date ?? ""))
    if (!address || !Number.isFinite(at)) continue
    const day = new Date(at).toISOString().slice(0, 10)
    const onStreet = str(r.street_or_private)
    out.push({
      signalType: "street_use_permit", datasetKey: CAMBRIDGE_STREET_USE, host: "data.cambridgema.gov", datasetId: "8xmj-thsm",
      recordId: `${address.toUpperCase()}|${day}`, address, city: "Cambridge", eventAt: new Date(at).toISOString(),
      sourceUrl: "https://data.cambridgema.gov/d/8xmj-thsm",
      detail: { container: "dumpster", on_street: onStreet ? /street/i.test(onStreet) : null, reads_as: "a renovation OR a move-out — never either alone" },
    })
  }
  return out
}

/** The markets this adapter can read, from the tenant territories' (state, city) pairs. */
function marketsFor(territories: ReadonlyArray<{ state?: string | null; city?: string | null }>): Set<"NY:New York" | "MA:Cambridge"> {
  const out = new Set<"NY:New York" | "MA:Cambridge">()
  for (const t of territories) {
    const st = String(t.state ?? "").trim().toUpperCase(), city = String(t.city ?? "").trim().toLowerCase()
    if (st === "NY" && NYC_CITY_NAMES.has(city)) out.add("NY:New York")
    if (st === "MA" && city === "cambridge") out.add("MA:Cambridge")
  }
  return out
}

/**
 * READ — the verified public-record datasets for the given territories, once per run (a dataset's health is a fact about the
 * PORTAL, not the tenant). Refuses any dataset the C19 gate does not lend a ceiling to. Never throws.
 */
export async function readPublicRecordFacts(
  svc: Svc,
  a: { territories: ReadonlyArray<{ state?: string | null; city?: string | null }>; now?: Date },
  deps: { query?: Query; ceiling?: (datasetKey: string) => Promise<{ status: string; reason: string }> } = {},
): Promise<{ facts: PublicRecordFact[]; probes: DatasetProbe[]; refused: string[] }> {
  const now = a.now ?? new Date()
  const markets = marketsFor(a.territories)
  const facts: PublicRecordFact[] = [], probes: DatasetProbe[] = [], refused: string[] = []
  if (markets.size === 0) return { facts, probes, refused }
  const query: Query = deps.query ?? (async (p) => (await import("@/lib/external/socrata-client")).socrataQuery(p as never) as never)
  const ceiling = deps.ceiling ?? (async (k: string) => (await import("./dataset-verification")).datasetCeilingWithObservations(svc, k, now))
  const lendable = async (k: string): Promise<boolean> => {
    const c = candidate(k)
    if (!c || c.unavailable || !c.verifiedOn || !c.licence || c.licence.class === "unknown") { refused.push(`${k}: not a verified, license-read registry candidate`); return false }
    try {
      const v = await ceiling(k)
      if (v.status === "verified" || v.status === "stale") return true
      refused.push(`${k}: C19 status ${v.status} — ${v.reason}`)
    } catch (e) { refused.push(`${k}: the C19 verification could not be read (${e instanceof Error ? e.message : String(e)}) — refused, never assumed`) }
    return false
  }
  const paged = async (host: string, datasetId: string, q: { select: string; where: string; order: string }) => {
    const rows: Row[] = []
    let status: number | null = null, error: string | null = null, truncated = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await query({ host, datasetId, query: { ...q, limit: PAGE, offset: page * PAGE } })
      status = r.status
      if (!r.ok) { error = r.error ?? "refused"; break }
      rows.push(...r.data)
      if (r.data.length < PAGE) break
      if (page === MAX_PAGES - 1) truncated = true
    }
    return { rows, status, error, truncated }
  }

  if (markets.has("NY:New York") && (await lendable(ACRIS_MASTER)) && (await lendable(ACRIS_LEGALS))) {
    const lag = candidate(ACRIS_MASTER)?.maxLagDays ?? 45
    const since = isoDay(new Date(now.getTime() - (lag + 7) * 86_400_000))
    const m = await paged("data.cityofnewyork.us", "bnx9-e6tj", { select: "document_id,doc_type,recorded_datetime", where: `doc_type='DEED' AND recorded_datetime >= '${since}'`, order: "recorded_datetime DESC" })
    probes.push({ dataset: ACRIS_MASTER, label: "NYC ACRIS — Real Property Master", provider: "socrata", status: m.status, ok: !m.error, rows: m.rows.length, matched: 0, truncated: m.truncated, error: m.error })
    if (!m.error && m.rows.length > 0) {
      const ids = [...new Set(m.rows.map((r) => str(r.document_id)).filter((x): x is string => !!x))]
      const legals: Row[] = []
      let lStatus: number | null = null, lError: string | null = null
      for (let i = 0; i < ids.length && !lError; i += LEGALS_CHUNK) {
        const chunk = ids.slice(i, i + LEGALS_CHUNK)
        const r = await query({ host: "data.cityofnewyork.us", datasetId: "8h5j-fqxa", query: { select: "document_id,street_number,street_name,borough,block,lot", where: `document_id in (${chunk.map(quote).join(",")})`, limit: PAGE } })
        lStatus = r.status
        if (!r.ok) lError = r.error ?? "refused"
        else legals.push(...r.data)
      }
      probes.push({ dataset: ACRIS_LEGALS, label: "NYC ACRIS — Real Property Legals", provider: "socrata", status: lStatus, ok: !lError, rows: legals.length, matched: 0, truncated: false, error: lError })
      if (!lError) facts.push(...acrisDeedFacts(m.rows, legals))
    }
  }
  if (markets.has("MA:Cambridge") && (await lendable(CAMBRIDGE_STREET_USE))) {
    const lag = candidate(CAMBRIDGE_STREET_USE)?.maxLagDays ?? 14
    const since = isoDay(new Date(now.getTime() - lag * 86_400_000))
    const c = await paged("data.cambridgema.gov", "8xmj-thsm", { select: "address,issue_date,street_or_private", where: `issue_date >= '${since}'`, order: "issue_date DESC" })
    probes.push({ dataset: CAMBRIDGE_STREET_USE, label: "Cambridge MA dumpster parking permits", provider: "socrata", status: c.status, ok: !c.error, rows: c.rows.length, matched: 0, truncated: c.truncated, error: c.error })
    if (!c.error) facts.push(...streetUseFacts(c.rows))
  }
  return { facts, probes, refused }
}

/**
 * FILE — the facts that land on an address a lead or contact of THIS tenant already carries, into motivated_seller_signals
 * (the movement watcher's stored-sweep source). Idempotent on signal_details.dedupe_key; every insert is .select()-counted.
 * Never mints a person. Never throws; refusals are returned.
 */
export async function filePublicRecordFacts(
  svc: Svc,
  a: { brokerageId: string; territories: ReadonlyArray<{ state?: string | null; city?: string | null }>; facts: readonly PublicRecordFact[]; now?: Date },
): Promise<{ matched: number; written: number; alreadyRecorded: number; byDataset: Record<string, number>; errors: string[] }> {
  const out = { matched: 0, written: 0, alreadyRecorded: 0, byDataset: {} as Record<string, number>, errors: [] as string[] }
  // Only the markets of THIS tenant's own territories — a run reads each portal once for every tenant, and a fact from another
  // tenant's market must never match an address here.
  const markets = marketsFor(a.territories)
  const facts = a.facts.filter((f) => markets.has(f.signalType === "deed_recorded" ? "NY:New York" : "MA:Cambridge"))
  if (!a.brokerageId || facts.length === 0) return out
  const { normalizeStreetAddress } = await import("@/lib/external/permit-signals")
  const now = a.now ?? new Date()
  const [{ data: contacts, error: cErr }, { data: leads, error: lErr }] = await Promise.all([
    svc.from("contacts").select("id, address, city").eq("brokerage_id", a.brokerageId).is("deleted_at", null).not("address", "is", null).limit(5000),
    svc.from("leads").select("id, address, city").eq("brokerage_id", a.brokerageId).not("address", "is", null).limit(5000),
  ])
  if (cErr) out.errors.push(`contacts read refused: ${cErr.message}`)
  if (lErr) out.errors.push(`leads read refused: ${lErr.message}`)
  if (cErr && lErr) return out
  type Owned = { kind: "contact" | "lead"; id: string; key: string; city: string }
  const owned: Owned[] = []
  for (const [kind, rows] of [["contact", contacts], ["lead", leads]] as const) {
    for (const r of ((rows ?? []) as Array<{ id: string; address?: string | null; city?: string | null }>)) {
      const key = normalizeStreetAddress(r.address)
      if (key) owned.push({ kind, id: r.id, key, city: String(r.city ?? "").trim().toLowerCase() })
    }
  }
  const sameCity = (fact: PublicRecordFact, city: string) => fact.signalType === "deed_recorded"
    ? (!city || NYC_CITY_NAMES.has(city) || city === fact.city.toLowerCase())
    : (!city || city === "cambridge")
  const { data: prior, error: pErr } = await svc.from("motivated_seller_signals").select("signal_details").eq("brokerage_id", a.brokerageId).in("signal_type", [...PUBLIC_RECORD_SIGNAL_TYPES]).limit(5000)
  if (pErr) { out.errors.push(`prior public-record signals could not be read — nothing filed (an unread dedupe never writes twice): ${pErr.message}`); return out }
  const seen = new Set(((prior ?? []) as Array<{ signal_details?: Record<string, unknown> | null }>).map((r) => String(r.signal_details?.dedupe_key ?? "")))
  for (const fact of facts) {
    const key = normalizeStreetAddress(fact.address)
    if (!key) continue
    for (const o of owned) {
      if (o.key !== key || !sameCity(fact, o.city)) continue
      out.matched++
      const dedupeKey = `${fact.datasetKey}:${fact.recordId}:${o.kind}:${o.id}`
      if (seen.has(dedupeKey)) { out.alreadyRecorded++; continue }
      const row = {
        brokerage_id: a.brokerageId,
        contact_id: o.kind === "contact" ? o.id : null,
        lead_id: o.kind === "lead" ? o.id : null,
        signal_type: fact.signalType,
        signal_strength: fact.signalType === "deed_recorded" ? "moderate" : "weak",
        detected_via: "socrata",
        detected_at: now.toISOString(),
        signal_details: {
          dedupe_key: dedupeKey, dataset_host: fact.host, dataset_id: fact.datasetId, record_id: fact.recordId,
          address: fact.address, city: fact.city, event_at: fact.eventAt, source_url: fact.sourceUrl, ...fact.detail,
          fact_only: "a property fact from an open-data record matched to an address this tenant already holds — never a person",
        },
      }
      const { data: ins, error } = await svc.from("motivated_seller_signals").insert(row).select("id")
      if (error) { out.errors.push(`${fact.datasetKey} ${fact.recordId}: insert refused: ${error.message}`); continue }
      if (!Array.isArray(ins) || ins.length === 0) { out.errors.push(`${fact.datasetKey} ${fact.recordId}: insert returned no row`); continue }
      seen.add(dedupeKey)
      out.written++
      out.byDataset[fact.datasetKey] = (out.byDataset[fact.datasetKey] ?? 0) + 1
    }
  }
  return out
}
