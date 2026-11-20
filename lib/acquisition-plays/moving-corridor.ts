// lib/acquisition-plays/moving-corridor.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLAY — MOVING-CORRIDOR EARLY RADAR (wave 151, lane 151D; directive play 1 + the creative combination
// "employer growth × commute corridor × inventory gap").
//
// Exa hunts public EMPLOYER announcements in the territory (a relocation, an expansion, an office or
// plant opening, a closure) with a schema-shaped extraction → each announcement is grouped across the
// pages that report it, with every page a citation → the territory's own zips are the coverage (no
// routing provider: commute minutes are NOT computed and the brief says so) → the market twin's STORED
// inventory reading (lib/market-reports/market-twin.ts, allowProviderRead false — no provider bill)
// gives the inventory gap → the brief ends in EXISTING actions: the cited job_civic_event rows through
// THE ONE producer, a bus signal to campaign_orchestrator (the brief), and — when activated — the
// market-report producer (a local buyer resource) and a DRAFT lead magnet a human publishes.
//
// CLAIM BOUNDARY (directive): the output records the announcement and its coverage. It never assumes
// every worker moves and it never identifies a person: a market-level event produces education and an
// opt-in invitation, never a personal lead. A named executive in a story is NOT a candidate.

import type { IngestBatchResult, IngestRawSourceBatchParams } from "@/lib/kernel/scraping"
import type { MarketTwin } from "@/lib/market-reports/market-twin"
import { groundedEvidence, freshnessProblem, huntTerritory, sourceRightsForUrl, type ExaHuntClient, type ExaHuntResult, type ExaHuntSearch, type GroundedEvidence } from "@/lib/providers/exa/hunting"
import { EXA_PLAY_CHANNEL, PLAY_ACTOR, emptyResult, evidenceRecord, type PlayAction, type PlayResult } from "./contract"

/** A territory as the plays read it (a lead_scraping_markets row; lib/kernel/scraping.ts ScrapingMarket is a superset). */
export interface PlayMarket {
  id: string
  brokerage_id: string | null
  name: string
  city: string | null
  state: string | null
  zip_codes: string[] | null
  counties?: string[] | null
  /** agents.id of the territory's agent (NOT a users.id — CLAUDE.md §3) — the magnet's owner when present. */
  agent_id?: string | null
}

const PLAY = "moving_corridor_radar" as const
export const CORRIDOR_MAX_AGE_DAYS = 120

const CORRIDOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    is_announcement: { type: "boolean", description: "true only when the page reports a specific employer's own announced relocation, expansion, opening or closure" },
    employer: { type: "string" },
    event_type: { type: "string", enum: ["relocation", "expansion", "office_opening", "plant_opening", "closure", "other"] },
    location_city: { type: ["string", "null"] },
    location_state: { type: ["string", "null"], description: "two-letter state code" },
    headcount_announced: { type: ["number", "null"], description: "jobs or workers the announcement itself states; null when not stated" },
    start_date: { type: ["string", "null"], description: "when the move / opening is announced to happen, as written" },
  },
  required: ["is_announcement", "employer", "event_type"],
}

const where = (m: PlayMarket) => [m.city, m.state].filter(Boolean).join(", ")

/** PURE — the territory's corridor searches (news, schema-shaped). No city and no state ⇒ no search (territory-honest). */
export function corridorSearches(market: PlayMarket): ExaHuntSearch[] {
  const w = where(market)
  if (!w) return []
  return [
    { key: "corridor:employer_announcements", query: `company relocating its headquarters or opening a new office or plant with new jobs in ${w}`, category: "news", sinceDays: CORRIDOR_MAX_AGE_DAYS, numResults: 10, schema: CORRIDOR_SCHEMA },
    { key: "corridor:expansion_hiring", query: `employer expansion announced hiring workers ${w} campus base plant expansion jobs`, category: "news", sinceDays: CORRIDOR_MAX_AGE_DAYS, numResults: 10, schema: CORRIDOR_SCHEMA },
  ]
}

type CorridorEventType = "relocation" | "expansion" | "office_opening" | "plant_opening" | "closure" | "other"

interface CorridorAnnouncement {
  key: string
  employer: string
  eventType: CorridorEventType
  location: { city: string | null; state: string | null }
  headcountAnnounced: number | null
  startDate: string | null
  citations: GroundedEvidence[]
  extraction: "schema" | "title_heuristic"
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)

/** A title-only reading when the schema returned nothing — labelled, lower confidence, still market-level. */
function heuristicAnnouncement(title: string | null): { employer: string; eventType: CorridorEventType; headcount: number | null } | null {
  if (!title) return null
  const m = title.match(/^([A-Z][\w&.'-]*(?:\s+[A-Z&][\w&.'-]*){0,4})\s+(?:to\s+|will\s+|is\s+)?(open|opens|opening|relocat\w*|expand\w*|mov\w*|clos\w*|bring\w*)\b/)
  if (!m) return null
  const verb = m[2].toLowerCase()
  const eventType: CorridorEventType = /^open/.test(verb) ? "office_opening" : /^relocat|^mov/.test(verb) ? "relocation" : /^expand|^bring/.test(verb) ? "expansion" : /^clos/.test(verb) ? "closure" : "other"
  const hc = title.match(/(\d[\d,]{1,6})\s+(?:new\s+)?(?:jobs|workers|employees|positions)/i)
  return { employer: m[1].trim(), eventType, headcount: hc ? Number(hc[1].replace(/,/g, "")) : null }
}

interface AnnouncementRead { announcements: CorridorAnnouncement[]; dropped: Record<string, number>; evidence: GroundedEvidence[] }

/** PURE — results → announcements grouped across pages; what is dropped is counted and named. */
function corridorAnnouncements(results: readonly ExaHuntResult[], market: PlayMarket, now: Date): AnnouncementRead {
  const dropped: Record<string, number> = {}
  const drop = (k: string) => { dropped[k] = (dropped[k] ?? 0) + 1 }
  const by = new Map<string, CorridorAnnouncement>()
  const evidence: GroundedEvidence[] = []
  for (const r of results) {
    const ev = groundedEvidence(r, now)
    if (!ev) { drop("no_citation"); continue }
    const stale = freshnessProblem(ev, CORRIDOR_MAX_AGE_DAYS, now)
    if (stale) { drop("stale"); continue }
    const x = r.extracted
    let employer: string | null = null, eventType: CorridorEventType = "other", headcount: number | null = null, startDate: string | null = null
    let location: { city: string | null; state: string | null } = { city: null, state: null }
    let extraction: CorridorAnnouncement["extraction"] = "schema"
    if (x) {
      if (x.is_announcement !== true) { drop("not_an_announcement"); continue }
      employer = str(x.employer)
      const et = str(x.event_type)
      eventType = (["relocation", "expansion", "office_opening", "plant_opening", "closure"] as const).find((k) => k === et) ?? "other"
      headcount = num(x.headcount_announced)
      startDate = str(x.start_date)
      location = { city: str(x.location_city), state: str(x.location_state)?.toUpperCase() ?? null }
    } else {
      const h = heuristicAnnouncement(r.title)
      if (!h) { drop("no_extraction"); continue }
      employer = h.employer; eventType = h.eventType; headcount = h.headcount; extraction = "title_heuristic"
    }
    if (!employer) { drop("no_employer"); continue }
    if (location.state && market.state && location.state.toUpperCase() !== market.state.toUpperCase()) { drop("outside_territory_state"); continue }
    const key = `${norm(employer)}|${eventType}`
    const cur = by.get(key)
    if (cur) {
      cur.citations.push(ev)
      cur.headcountAnnounced = cur.headcountAnnounced ?? headcount
      cur.startDate = cur.startDate ?? startDate
      cur.location = { city: cur.location.city ?? location.city, state: cur.location.state ?? location.state }
      if (extraction === "schema") cur.extraction = "schema"
    } else {
      by.set(key, { key, employer, eventType, location, headcountAnnounced: headcount, startDate, citations: [ev], extraction })
    }
    evidence.push(ev)
  }
  return { announcements: [...by.values()], dropped, evidence }
}

const EVENT_LABEL: Record<CorridorEventType, string> = { relocation: "relocating", expansion: "expanding", office_opening: "opening an office", plant_opening: "opening a plant", closure: "closing a site", other: "announcing a change" }

interface CorridorBrief {
  announcement: Omit<CorridorAnnouncement, "citations"> & { citations: Array<{ url: string; title: string | null; publisher: string | null; published: string | null; quote: string }> }
  coverage: { territory: string; territoryZips: string[]; corridorBasis: string; commuteMinutes: null }
  inventory: { zips: Array<{ zip: string; activeListings: number | null; medianAskingPrice: number | null; asOf: string | null }>; monthsOfSupply: number | null; basis: string }
  gapVerdict: "tight" | "balanced" | "loose" | "unknown"
  resource: { topic: { title: string; angle: string; evidenceIds: string[] }; magnetTitle: string }
  claimBoundary: string
}

/** PURE — announcement × territory coverage × stored inventory → the brief (the creative combination, with its boundary). */
function corridorBrief(a: CorridorAnnouncement, market: PlayMarket, twin: MarketTwin | null): CorridorBrief {
  const zips = market.zip_codes ?? []
  const twinZips = (twin?.zips ?? []).filter((z) => zips.length === 0 || zips.includes(z.zip))
  const mos = twin?.marketGap.monthsOfSupply ?? null
  const gapVerdict: CorridorBrief["gapVerdict"] = mos == null ? "unknown" : mos < 3 ? "tight" : mos <= 6 ? "balanced" : "loose"
  const w = where(market) || market.name
  const label = EVENT_LABEL[a.eventType]
  const hc = a.headcountAnnounced ? ` (${a.headcountAnnounced.toLocaleString()} jobs announced)` : ""
  return {
    announcement: { ...a, citations: a.citations.map((c) => ({ url: c.sourceUrl, title: c.title, publisher: c.publisher, published: c.publishedAt, quote: c.quotedBasis })) },
    coverage: {
      territory: w, territoryZips: zips,
      corridorBasis: zips.length ? "the territory's configured zips are the coverage; commute minutes are not computed (no routing provider)" : "no zips configured on the territory — coverage is the city/state only",
      commuteMinutes: null,
    },
    inventory: {
      zips: twinZips.map((z) => ({ zip: z.zip, activeListings: z.listing.activeListings?.value ?? null, medianAskingPrice: z.listing.medianAskingPrice?.value ?? null, asOf: z.asOf ?? null })),
      monthsOfSupply: mos,
      basis: twin ? `${twin.marketGap.reason} (${twin.marketGap.source ?? "no feed"}; listing figures are ASKING prices and counts, never sales)` : "no market twin read — inventory unknown",
    },
    gapVerdict,
    resource: {
      topic: {
        title: `${a.employer} is ${label} near ${w}${hc}: what it means for homes here`,
        angle: `A public employer announcement and the ${gapVerdict === "unknown" ? "current" : gapVerdict} local inventory — a cited guide for households weighing a move, not a prediction about any person`,
        evidenceIds: a.citations.map((c) => `exa:${c.resultId}`),
      },
      magnetTitle: `Moving to ${market.city ?? market.name} for ${a.employer}? A local buyer guide`,
    },
    claimBoundary: "announcement and coverage only — no worker is assumed to move; no person is identified; market-level evidence produces education and an opt-in invitation, never a personal lead",
  }
}

type Ingest = (p: IngestRawSourceBatchParams) => Promise<IngestBatchResult>
type Svc = { from: (t: string) => any }

export interface CorridorDeps {
  ingest?: Ingest
  /** The STORED market twin (default lib/market-reports/market-twin.ts loadMarketTwin with allowProviderRead:false — no provider read). */
  twin?: (svc: Svc, a: { brokerageId: string; zips: string[] }) => Promise<MarketTwin | null>
  signal?: typeof import("@/lib/kernel/manager-signals").publishManagerSignal
  /** The market-report producer (default lib/market-reports/producer.ts produceMarketReport). Called only when `activate`. */
  report?: (svc: Svc, input: Record<string, unknown>) => Promise<{ ok: boolean; stage?: string; reason?: string; documentId?: string | null }>
  /** The lead-magnet producer (default lib/kernel/lead-magnets.ts createLeadMagnet, publishState draft). Called only when `activate`. */
  magnet?: (input: Record<string, unknown>, opts: { client?: Svc }) => Promise<{ success: boolean; magnetId?: string; error?: string }>
}

const defaultIngest: Ingest = async (p) => (await import("@/lib/kernel/scraping")).ingestRawSourceBatch(p)
const defaultTwin: NonNullable<CorridorDeps["twin"]> = async (svc, a) => {
  const { loadMarketTwin } = await import("@/lib/market-reports/market-twin")
  return loadMarketTwin(svc as never, { brokerageId: a.brokerageId, zips: a.zips, allowProviderRead: false })
}
const defaultSignal: NonNullable<CorridorDeps["signal"]> = async (input, client) => (await import("@/lib/kernel/manager-signals")).publishManagerSignal(input, client)
const defaultReport: NonNullable<CorridorDeps["report"]> = async (svc, input) => (await import("@/lib/market-reports/producer")).produceMarketReport(svc as never, input as never)
const defaultMagnet: NonNullable<CorridorDeps["magnet"]> = async (input, opts) => (await import("@/lib/kernel/lead-magnets")).createLeadMagnet(input as never, opts as never)

export const CORRIDOR_BRIEF_SIGNAL = "corridor_radar_brief"

/**
 * The play. `results` (a monitor's delta) skips the hunt; otherwise the client hunts (null → provider_unconfigured, zero rows).
 * `activate` (default false) also produces the local guide and the DRAFT magnet through the existing producers.
 */
export async function runMovingCorridorPlay(
  svc: Svc,
  a: { market: PlayMarket; hunt: ExaHuntClient | null; results?: ExaHuntResult[] | null; now?: Date; activate?: boolean },
  deps: CorridorDeps = {},
): Promise<PlayResult> {
  const now = a.now ?? new Date()
  const blind: string[] = []
  let results: ExaHuntResult[]
  let costUsd = 0
  if (a.results) results = a.results
  else {
    const hunt = await huntTerritory(a.hunt, corridorSearches(a.market), now)
    costUsd = hunt.costUsd
    blind.push(...hunt.errors)
    if (hunt.status === "provider_unconfigured") return emptyResult(PLAY, "provider_unconfigured", blind)
    results = hunt.results
  }
  const read = corridorAnnouncements(results, a.market, now)
  blind.push(`dropped: ${JSON.stringify(read.dropped)}`, "commute minutes are not computed (no routing provider); coverage is the territory's configured zips")
  if (read.announcements.length === 0) return { ...emptyResult(PLAY, "nothing_found", blind), costUsd }

  const actions: PlayAction[] = []
  const refused: PlayResult["refused"] = []

  // 1 · THE ONE PRODUCER — every citation is a job_civic_event row (identity-free; the Lead door refuses it).
  const records = read.announcements.flatMap((an) => an.citations.map((ev) => evidenceRecord({
    subject: "job_civic_event", evidence: ev, market: a.market, play: PLAY, evidenceClass: "market_level_opportunity", rights: sourceRightsForUrl(ev.sourceUrl),
    tags: ["employer_announcement", an.eventType, an.extraction],
    extracted: { employer: an.employer, event_type: an.eventType, location: an.location, headcount_announced: an.headcountAnnounced, start_date: an.startDate, announcement_key: an.key },
  })))
  const ingested = await (deps.ingest ?? defaultIngest)({
    brokerageId: a.market.brokerage_id, marketId: a.market.id, source: records[0].source, sourceFamily: "social_intent", sourceChannel: EXA_PLAY_CHANNEL, sourceSubtype: PLAY,
    records, executionId: null, marketGeo: { city: a.market.city, state: a.market.state, zip_codes: a.market.zip_codes },
    batchCostUsd: costUsd > 0 ? costUsd : null, recencyDays: CORRIDOR_MAX_AGE_DAYS, actor: PLAY_ACTOR, client: svc as never,
  })
  actions.push({ kind: "ingest_evidence", target: "ingestRawSourceBatch", detail: { subject_kind: "job_civic_event", inserted: ingested.inserted, replayed: ingested.replayed, skipped_territory: ingested.skipped_territory, skipped_stale: ingested.skipped_stale, skipped_refused: ingested.skipped_refused } })

  // 2 · THE BRIEF — stored inventory only (no provider read), per announcement, one open brief per territory × announcement.
  let twin: MarketTwin | null = null
  if (a.market.brokerage_id) {
    try { twin = await (deps.twin ?? defaultTwin)(svc, { brokerageId: a.market.brokerage_id, zips: a.market.zip_codes ?? [] }) }
    catch (e) { blind.push(`market twin not read (${e instanceof Error ? e.message : String(e)}) — inventory gap unknown`) }
  } else blind.push("platform-pool territory (no brokerage) — no twin, no brief activation")
  const briefs = read.announcements.map((an) => corridorBrief(an, a.market, twin))

  if (a.market.brokerage_id) {
    const brokerageId = a.market.brokerage_id
    for (const brief of briefs) {
      const { data: open, error: openErr } = await svc.from("manager_signals").select("id")
        .eq("brokerage_id", brokerageId).eq("to_manager", "campaign_orchestrator").eq("signal_type", CORRIDOR_BRIEF_SIGNAL)
        .eq("entity_id", a.market.id).eq("status", "open").eq("payload->>announcement_key", brief.announcement.key).limit(1)
      if (openErr) { refused.push({ what: `brief ${brief.announcement.key}`, why: `manager_signals read refused: ${openErr.message}` }); continue }
      if ((open ?? []).length > 0) { actions.push({ kind: "manager_signal", target: "publishManagerSignal", detail: { announcement_key: brief.announcement.key, already_open: true } }); continue }
      const sig = await (deps.signal ?? defaultSignal)({
        brokerageId, fromManager: "data_steward", toManager: "campaign_orchestrator", signalType: CORRIDOR_BRIEF_SIGNAL, dedupe: false,
        message: `${brief.announcement.employer} is ${EVENT_LABEL[brief.announcement.eventType]} near ${brief.coverage.territory} — a cited local buyer resource and an opt-in magnet are proposed (${brief.gapVerdict} inventory). ${brief.claimBoundary}`.slice(0, 900),
        entityType: "territory", entityId: a.market.id,
        payload: { announcement_key: brief.announcement.key, play: PLAY, brief },
      }, svc as never)
      actions.push({ kind: "manager_signal", target: "publishManagerSignal", detail: { announcement_key: brief.announcement.key, ok: sig.ok, reason: sig.reason ?? null, gap: brief.gapVerdict } })
      if (!sig.ok) { refused.push({ what: `brief ${brief.announcement.key}`, why: sig.reason ?? "bus refused" }); continue }

      // 3 · ACTIVATION (opt-in): the local guide through the market-report producer, the DRAFT magnet through the magnet producer.
      if (a.activate) {
        const territory = a.market.zip_codes?.length === 1
          ? { grain: "zip", label: a.market.zip_codes[0], zip: a.market.zip_codes[0], city: a.market.city, state: a.market.state }
          : { grain: "city", label: brief.coverage.territory, zip: null, city: a.market.city, state: a.market.state }
        try {
          const rep = await (deps.report ?? defaultReport)(svc, {
            brokerageId, agentId: a.market.agent_id ?? null, actor: { type: "manager", managerKey: "campaign_orchestrator" },
            territory, topic: brief.resource.topic, purpose: "corridor_radar_local_guide", reasonCode: "SCHEDULED_CONTENT_PUBLISH",
          })
          actions.push({ kind: "market_report", target: "produceMarketReport", detail: { announcement_key: brief.announcement.key, ok: rep.ok, stage: rep.stage ?? null, reason: rep.reason ?? null, documentId: rep.documentId ?? null, evidence_ids: brief.resource.topic.evidenceIds } })
        } catch (e) { refused.push({ what: "market report", why: e instanceof Error ? e.message : String(e) }) }
        if (a.market.agent_id) {
          try {
            const mg = await (deps.magnet ?? defaultMagnet)({
              title: brief.resource.magnetTitle, description: `${brief.resource.topic.angle}. ${brief.claimBoundary}`, magnetType: "market_report",
              brokerageId, agentId: a.market.agent_id, createdBy: a.market.agent_id, publishState: "draft",
              settings: { authoring: { by: "ai" }, early_opportunity: { play: PLAY, announcement_key: brief.announcement.key, citations: brief.announcement.citations.map((c) => c.url), claim_boundary: brief.claimBoundary } },
            }, { client: svc })
            actions.push({ kind: "lead_magnet_draft", target: "createLeadMagnet", detail: { announcement_key: brief.announcement.key, ok: mg.success, magnetId: mg.magnetId ?? null, error: mg.error ?? null, publish_state: "draft" } })
          } catch (e) { refused.push({ what: "lead magnet draft", why: e instanceof Error ? e.message : String(e) }) }
        } else blind.push("no agent on the territory — brief and guide only, no magnet owner")
      }
    }
  }

  return { play: PLAY, status: "acted", evidence: read.evidence, actions, refused, blindSpots: blind, costUsd }
}
