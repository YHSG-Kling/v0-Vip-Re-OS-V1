// lib/market-reports/topics.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MONTH'S MARKET REPORT SHOULD BE ABOUT — FROM VERIFIED MARKET DATA AND THE MARKET REGISTRY ONLY.
//
// OWNER RULING 10 (2026-11-01, wave 148, lane 148G): "market reports do not take from the topic bank." Verified market data +
// the market registry only; the topic bank stays a separate CREATIVE source.
//
// TOMBSTONE (orphan doctrine §1.3 — the functionality lives elsewhere): wave 147 (lane 147E) read the TOPIC BANK here
// (content_topic_bank raw_data.topic_evidence: competitor post themes, viral patterns, customer questions). That read is GONE from
// this module. The topic bank keeps serving the creative surfaces it was built for — lib/content-intel/topic-bank.ts pickTopics
// (podcasts, newsletters, blogs, farm mail, the topic-pool video, the contact situational reel) — and no market-report path reads
// it (scripts/market-report-producer-guard.ts §E asserts it on a client that records every table read, with a positive control).
//
// THE EVIDENCE NOW (no fourth ideation path — LAW 2; every source is a survivor that already holds verified facts):
//   · market_signal     the tenant's market_data rows (THE refresher's — dated, sourced; cma_aggregate opinions and rows older
//                       than the research module's own 120-day ceiling excluded, said)
//   · market_trend      market_trends monthly snapshots (two months of the same territory → a month-over-month direction)
//   · closed_sales      this brokerage's MLS-synced closed sales in the territory (count only, ≥ 3 — the CMA survivor's floor)
//   · registry_dataset  THE MARKET REGISTRY — lib/external/socrata-market-registry.ts classifyMarketCoverage: the public-record
//                       datasets VERIFIED for the territory's market (a live row read, a bounded date column, not frozen), plus
//                       contract C19's verification rows (market_dataset_verifications — lane 148F, m918) when present: a source
//                       the registry marks UNVERIFIED (or stale, or drifting) cannot raise a signal above `unknown`, so it adds NO
//                       evidence here and the exclusion is said. A refused C19 read fails CLOSED for registry datasets.
// The model RANKS and FRAMES; it cannot add evidence: every suggestion must cite ids from the list, an invented id is dropped,
// and a suggestion left with none is discarded. No model, a refused read, or nothing usable → the deterministic fallback
// (a territory snapshot) with the reason said. Cost booked by the routed call (ai_tool_usage).
//
// Never throws.

import { classifyMarketCoverage } from "@/lib/external/socrata-market-registry"
import { isoDay, type MarketReportFormat, type MarketReportTerritory } from "./contract"
import { buildMarketReportTopicPrompt, MARKET_REPORT_TOPIC_SYSTEM, MarketReportTopicSchema, type MarketReportTopicDraft, type TopicEvidenceItem } from "./prompts"
import type { MarketTwin } from "./market-twin"

type Db = { from: (table: string) => any }

/** The research module's own ceilings (lib/market-reports/research.ts) — one number each for "too old" and "enough sales". */
const MAX_MARKET_ROW_AGE_DAYS = 120
const SOLD_WINDOW_DAYS = 180
const MIN_CLOSED_SALES = 3
/** A C19 verification older than this no longer verifies anything (the registry's own freshness is part of verification). */
const MAX_VERIFICATION_AGE_DAYS = 180
const DAY_MS = 86_400_000

interface MarketReportTopicSuggestion {
  title: string
  angle: string
  format: MarketReportFormat
  evidence: TopicEvidenceItem[]
  whyNow: string
  /** "ai" — ranked by the routed strategist; "fallback" — the deterministic snapshot. */
  by: "ai" | "fallback"
}

export interface TopicSuggestionResult {
  suggestions: MarketReportTopicSuggestion[]
  evidenceCount: number
  /** Why the fallback was used / what could not be read / which unverified source was excluded — said, never silent. */
  notes: string[]
}

export interface TopicDeps {
  now?: Date
  /** The routed strategist (default: generateObjectRouted, feature market_insight_narrative). Seam for the proof. */
  rank?: (a: { brokerageId: string; system: string; prompt: string }) => Promise<MarketReportTopicDraft>
  /** THE market twin for the territory's zip (default lib/market-reports/market-twin.ts loadMarketTwin — the shared, platform-cached
   *  RentCast read authorized by this report production). Seam for the proof. */
  twin?: (svc: Db, a: { brokerageId: string; zip: string }) => Promise<MarketTwin>
}

/** The kinds that may CARRY a topic (a market fact). A registry entry or a relocation context only supports one. */
const CARRYING_KINDS: ReadonlySet<TopicEvidenceItem["kind"]> = new Set(["market_signal", "market_trend", "closed_sales", "demand_gap"])

/** A C19 row, read defensively (lane 148F owns the table; only the contract's field names are relied on). */
interface DatasetVerificationRow {
  source?: unknown; geography?: unknown; confidence?: unknown; last_verified_at?: unknown; drift?: unknown; verified?: unknown
}

/**
 * PURE — does this C19 verification row VERIFY its source today? Unverified when the row says so (confidence unverified /
 * unknown / none / failed, or verified = false), when it carries no verification date or one older than
 * MAX_VERIFICATION_AGE_DAYS, or when it records drift. Proven through suggestMarketReportTopics.
 */
function verificationVerdict(row: DatasetVerificationRow, now: Date): { verified: boolean; reason: string } {
  const conf = String(row.confidence ?? "").toLowerCase()
  if (row.verified === false || ["unverified", "unknown", "none", "failed"].includes(conf)) return { verified: false, reason: `the registry marks it ${conf || "unverified"}` }
  const at = typeof row.last_verified_at === "string" ? Date.parse(row.last_verified_at) : NaN
  if (!Number.isFinite(at)) return { verified: false, reason: "no last successful verification on record" }
  if ((now.getTime() - at) / DAY_MS > MAX_VERIFICATION_AGE_DAYS) return { verified: false, reason: `last verified ${String(row.last_verified_at).slice(0, 10)} — older than ${MAX_VERIFICATION_AGE_DAYS} days` }
  const drift = row.drift as { detected?: unknown } | boolean | null | undefined
  if (drift === true || (drift && typeof drift === "object" && drift.detected === true)) return { verified: false, reason: "drift recorded since the last verification" }
  return { verified: true, reason: `verified ${String(row.last_verified_at).slice(0, 10)}${conf ? ` (${conf})` : ""}` }
}

/** PURE — does a C19 row's geography cover this territory? (absent / "*" / national = everywhere). */
function coversTerritory(geography: unknown, t: MarketReportTerritory): boolean {
  if (geography == null) return true
  const g = (typeof geography === "string" ? geography : JSON.stringify(geography)).toLowerCase()
  if (!g.trim() || g === "*" || /national|all markets|\bus\b/.test(g)) return true
  return [t.zip, t.city, t.state && t.city ? `${t.city}, ${t.state}` : null].some((x) => typeof x === "string" && x && g.includes(x.toLowerCase()))
}

/** Gather the evidence (tenant-pinned). Proven through suggestMarketReportTopics. */
async function gatherRegistryEvidence(svc: Db, input: { brokerageId: string; territory: MarketReportTerritory; now?: Date; twin?: TopicDeps["twin"] }): Promise<{ evidence: TopicEvidenceItem[]; notes: string[] }> {
  const now = input.now ?? new Date()
  const t = input.territory
  const notes: string[] = []
  const evidence: TopicEvidenceItem[] = []

  // C19 FIRST — what the registry says about each source decides whether that source may speak at all.
  let c19: Array<DatasetVerificationRow> | null = []
  {
    const { data, error } = await svc.from("market_dataset_verifications").select("*").limit(500)
    if (error) {
      const absent = error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(String(error.message ?? ""))
      if (absent) notes.push("market_dataset_verifications (contract C19) is not present yet — each source's own verification stands (the registry's verifiedOn, the market row's date)")
      else { c19 = null; notes.push(`market_dataset_verifications read refused: ${error.message ?? "unknown"} — registry datasets are treated as UNVERIFIED this run (fail closed)`) }
    } else c19 = ((data ?? []) as DatasetVerificationRow[]).filter((r) => coversTerritory(r.geography, t))
  }
  /** The C19 verdict for a source key; null when C19 holds no row for it. */
  const c19For = (keys: string[]): { verified: boolean; reason: string } | null => {
    if (!c19) return null
    const lower = keys.map((k) => k.toLowerCase())
    const row = c19.find((r) => typeof r.source === "string" && lower.includes(r.source.toLowerCase()))
    return row ? verificationVerdict(row, now) : null
  }

  // 1 · market_signal — the tenant's verified market rows.
  {
    let mq = svc.from("market_data").select("id, data_date, source_type, zip_code, city, median_sale_price, active_listings, avg_days_on_market, price_trend_pct_1yr").eq("brokerage_id", input.brokerageId)
    if (t.zip) mq = mq.eq("zip_code", t.zip)
    const { data: rows, error: mdErr } = await mq.order("data_date", { ascending: false }).limit(6)
    if (mdErr) notes.push(`market_data read refused: ${mdErr.message ?? "unknown"} — local market signals are a blind spot this run`)
    for (const m of (rows ?? []) as Array<{ id: string; data_date: string; source_type: string | null; zip_code: string | null; city: string | null; price_trend_pct_1yr: number | null; active_listings: number | null; avg_days_on_market: number | null }>) {
      if (m.source_type === "cma_aggregate") continue // an opinion of value is not market data (research.ts says the same)
      const ageDays = (now.getTime() - Date.parse(`${m.data_date}T00:00:00Z`)) / DAY_MS
      if (!Number.isFinite(ageDays) || ageDays > MAX_MARKET_ROW_AGE_DAYS) { notes.push(`market_data ${m.id} (${m.data_date}) is older than ${MAX_MARKET_ROW_AGE_DAYS} days — not evidence`); continue }
      const v = c19For([String(m.source_type ?? ""), `market_data:${m.source_type ?? ""}`])
      if (v && !v.verified) { notes.push(`market_data source ${m.source_type} excluded — ${v.reason} (an unverified source cannot raise a signal above unknown)`); continue }
      const parts: string[] = []
      if (Number(m.price_trend_pct_1yr)) parts.push(`asking prices ${Number(m.price_trend_pct_1yr) > 0 ? "up" : "down"} ${Math.abs(Number(m.price_trend_pct_1yr))}% year over year`)
      if (Number(m.active_listings) > 0) parts.push(`${m.active_listings} active listings`)
      if (Number(m.avg_days_on_market) > 0) parts.push(`${m.avg_days_on_market} average days on market`)
      if (parts.length) evidence.push({ id: `market:${m.id}`, kind: "market_signal", summary: `${m.zip_code ?? m.city ?? t.label}: ${parts.join(", ")}`, observedAt: m.data_date, source: `market_data (${m.source_type})` })
    }
  }

  // 2 · market_trend — two monthly snapshots of the same territory → a direction (never a forecast).
  if (t.zip) {
    const { data: trend, error: trErr } = await svc.from("market_trends").select("snapshot_month, median_price, active_inventory, zip_code").eq("brokerage_id", input.brokerageId).eq("zip_code", t.zip).order("snapshot_month", { ascending: false }).limit(2)
    if (trErr) notes.push(`market_trends read refused: ${trErr.message ?? "unknown"} — the monthly direction is a blind spot this run`)
    const [cur, prev] = (trend ?? []) as Array<{ snapshot_month: string; median_price: number | null; active_inventory: number | null }>
    if (cur && prev) {
      const parts: string[] = []
      const mp = Number(cur.median_price), pp = Number(prev.median_price)
      if (mp > 0 && pp > 0) parts.push(`median asking price of listed homes ${mp > pp ? "rose" : mp < pp ? "fell" : "held"} from $${Math.round(pp).toLocaleString("en-US")} (${prev.snapshot_month}) to $${Math.round(mp).toLocaleString("en-US")} (${cur.snapshot_month})`)
      const ci = Number(cur.active_inventory), pi = Number(prev.active_inventory)
      if (ci > 0 && pi > 0) parts.push(`active listings ${ci > pi ? "grew" : ci < pi ? "shrank" : "held"} from ${pi} to ${ci}`)
      if (parts.length) evidence.push({ id: `trend:${t.zip}:${cur.snapshot_month}`, kind: "market_trend", summary: `${t.label}: ${parts.join("; ")}`, observedAt: cur.snapshot_month, source: "market_trends (monthly snapshot)" })
    }
  }

  // 3 · closed_sales — the tenant's MLS-synced closed sales (count only; the report computes the medians).
  if (t.zip || (t.city && t.state)) {
    const since = isoDay(new Date(now.getTime() - SOLD_WINDOW_DAYS * DAY_MS))
    let q = svc.from("listings").select("id, sold_date").eq("brokerage_id", input.brokerageId).eq("status", "sold").is("deleted_at", null).gte("sold_date", since)
    q = t.zip ? q.eq("zip", t.zip) : q.ilike("city", t.city!).eq("state", t.state!)
    const { data: sold, error: sErr } = await q.limit(200)
    if (sErr) notes.push(`listings (closed sales) read refused: ${sErr.message ?? "unknown"} — closed sales are a blind spot this run`)
    const n = (sold ?? []).length
    const v = c19For(["mls", "listings", "mls_closed_sales"])
    if (v && !v.verified) notes.push(`MLS closed sales excluded — ${v.reason}`)
    else if (n >= MIN_CLOSED_SALES) {
      const newest = ((sold ?? []) as Array<{ sold_date: string | null }>).map((r) => r.sold_date ?? "").sort().pop() ?? null
      evidence.push({ id: `sales:${t.zip ?? `${t.city}-${t.state}`}`, kind: "closed_sales", summary: `${t.label}: ${n} closed sales in the last ${SOLD_WINDOW_DAYS} days (this brokerage's MLS-synced records — a sample of the territory)`, observedAt: newest, source: "listings (MLS-synced closed sales)" })
    }
  }

  // 4 · registry_dataset — THE MARKET REGISTRY: public-record datasets verified for this market (dataset level; never a person
  //     or an address — the person-level matches those datasets feed belong to the seller-signal lanes, not to a report).
  if (t.state && t.city) {
    const coverage = classifyMarketCoverage({ state: t.state, city: t.city })
    if (coverage.status === "unregistered") notes.push(`the market registry has no entry for ${coverage.market} — no public-record dataset can be cited`)
    for (const r of coverage.reasons) notes.push(`registry: ${r}`)
    for (const d of coverage.queryable) {
      const key = `${d.host}/${d.datasetId}`
      if (!c19) { notes.push(`registry dataset ${key} not cited — the C19 verification read was refused (fail closed)`); continue }
      const v = c19For([key, d.datasetId])
      if (v && !v.verified) { notes.push(`registry dataset ${key} excluded — ${v.reason} (an unverified source cannot raise a signal above unknown)`); continue }
      evidence.push({ id: `registry:${key}`, kind: "registry_dataset", summary: `${d.label} — a verified public-record dataset for ${coverage.market}${d.verifiedOn ? `, live row verified ${d.verifiedOn}` : ""}${v ? `; C19: ${v.reason}` : ""}`, observedAt: d.verifiedOn ?? null, source: `market registry (${d.kind}, ${key})` })
    }
  }

  // 5 · THE MARKET TWIN (wave 150, lane 150KLMO — C41): the Housing Match Gap (consented buyer demand × fresh licensed inventory,
  //     no identities, segments under the k-floor suppressed) and the relocation context (verified listing + rent medians →
  //     the own-or-rent starting point a PCS / relocation guide stands on, with the official sources by name). Never the topic bank.
  if (t.zip) {
    const load = input.twin ?? (async (db: Db, a: { brokerageId: string; zip: string }) => (await import("./market-twin")).loadMarketTwin(db, { brokerageId: a.brokerageId, zips: [a.zip], allowProviderRead: true }))
    const twin = await load(svc, { brokerageId: input.brokerageId, zip: t.zip }).catch((e: unknown) => { notes.push(`market twin unavailable: ${e instanceof Error ? e.message : String(e)}`); return null })
    if (twin) {
      notes.push(...twin.notes.map((n) => `twin: ${n}`))
      for (const g of twin.demandGap.segments.filter((x) => x.undersupplied).slice(0, 3)) {
        evidence.push({ id: `demand:${g.area}:${g.priceBand}:${g.beds}`.replace(/\s+/g, "_"), kind: "demand_gap", summary: `${g.attribution} (${g.claimBoundary})`, observedAt: twin.asOf, source: "consented buyer criteria (property_preferences, stated) × fresh active listings — no buyer identified" })
      }
      if (twin.demandGap.suppressedSegments) notes.push(`twin: ${twin.demandGap.suppressedSegments} demand segment(s) under the k-floor suppressed (a count that small could point at a person)`)
      const z = twin.zips.find((x) => x.zip === t.zip)
      if (z?.listing.medianAskingPrice && z.rental.medianRent) {
        const { planRelocation, PCS_OFFICIAL_SOURCES } = await import("@/lib/relocation/pcs-planner")
        const guide = planRelocation({ mode: "territory_guide", territoryLabel: t.label, facts: { medianAskingPrice: z.listing.medianAskingPrice.value, medianRent: z.rental.medianRent.value, asOf: z.asOf, source: "RentCast /markets listing statistics" } })
        if (guide.ok && guide.mode === "territory_guide" && guide.priceToRent != null) {
          evidence.push({ id: `relocation:${t.zip}`, kind: "relocation_context", summary: `${guide.summary}. Official sources a relocation or PCS guide cites by name: ${PCS_OFFICIAL_SOURCES.map((s) => s.name).join("; ")}`, observedAt: z.asOf, source: "market twin (RentCast /markets) + official DoD / VA sources by name" })
        }
      }
    }
  }
  return { evidence, notes }
}

function fallback(territory: MarketReportTerritory, evidence: TopicEvidenceItem[], reason: string): MarketReportTopicSuggestion {
  return {
    title: `${territory.label} market snapshot`,
    angle: `Where prices, supply and pace stand in ${territory.label} right now.`,
    format: "territory_snapshot",
    evidence: evidence.filter((e) => e.kind === "market_signal" || e.kind === "market_trend").slice(0, 3),
    whyNow: reason,
    by: "fallback",
  }
}

/** Suggest topics for a territory's report, each with the verified evidence behind it. */
export async function suggestMarketReportTopics(svc: Db, input: { brokerageId: string; territory: MarketReportTerritory }, deps: TopicDeps = {}): Promise<TopicSuggestionResult> {
  const now = deps.now ?? new Date()
  try {
    const { evidence, notes } = await gatherRegistryEvidence(svc, { brokerageId: input.brokerageId, territory: input.territory, now, twin: deps.twin })
    if (evidence.length === 0) return { suggestions: [fallback(input.territory, [], "no verified market evidence on record — a plain snapshot of the territory")], evidenceCount: 0, notes: [...notes, "no evidence — fallback topic"] }
    const rank = deps.rank ?? (async (a) => (await (await import("@/lib/ai/models")).generateObjectRouted({
      feature: "market_insight_narrative", brokerageId: a.brokerageId, manager: "campaign_orchestrator",
      system: a.system, prompt: a.prompt, schema: MarketReportTopicSchema, maxTokens: 1200, temperature: 0.4,
      contextExtra: { purpose: "market_report_topic_suggestion" },
    })).object)
    let draft: MarketReportTopicDraft
    try {
      draft = await rank({ brokerageId: input.brokerageId, system: MARKET_REPORT_TOPIC_SYSTEM, prompt: buildMarketReportTopicPrompt({ territory: input.territory, asOf: isoDay(now), evidence }) })
    } catch (e) {
      return { suggestions: [fallback(input.territory, evidence, "the topic strategist was unavailable — a plain snapshot")], evidenceCount: evidence.length, notes: [...notes, `strategist unavailable: ${e instanceof Error ? e.message : String(e)}`] }
    }
    const byId = new Map(evidence.map((e) => [e.id, e]))
    const dropped: string[] = []
    const suggestions: MarketReportTopicSuggestion[] = []
    for (const s of draft.suggestions ?? []) {
      const cited = (s.evidence_ids ?? []).map((id) => { const e = byId.get(id); if (!e) dropped.push(id); return e }).filter((e): e is TopicEvidenceItem => !!e)
      // a suggestion must stand on MARKET evidence — a registry entry alone says what CAN be verified, not what is happening
      if (!cited.some((e) => CARRYING_KINDS.has(e.kind))) continue
      const title = s.title.toLowerCase().includes(input.territory.label.toLowerCase()) ? s.title : `${input.territory.label}: ${s.title}`
      suggestions.push({ title, angle: s.angle, format: s.format, evidence: cited, whyNow: s.why_now, by: "ai" })
    }
    if (dropped.length) notes.push(`dropped ${dropped.length} evidence id(s) the strategist invented: ${dropped.slice(0, 5).join(", ")}`)
    if (suggestions.length === 0) return { suggestions: [fallback(input.territory, evidence, "no suggestion cited real market evidence — a plain snapshot")], evidenceCount: evidence.length, notes }
    return { suggestions, evidenceCount: evidence.length, notes }
  } catch (e) {
    return { suggestions: [fallback(input.territory, [], "topic suggestion failed — a plain snapshot")], evidenceCount: 0, notes: [`suggestMarketReportTopics threw: ${e instanceof Error ? e.message : String(e)}`] }
  }
}
