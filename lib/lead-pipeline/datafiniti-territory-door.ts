// lib/lead-pipeline/datafiniti-territory-door.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DATAFINITI TERRITORY DOOR (wave 153, lane 153T — closes lane 153M's "nothing calls the producer / nothing reads a
// completed download"). NOT a new acquisition system (OS-CONSTITUTION law 1 / 2): it composes the survivors exactly as the
// BatchData lanes are composed —
//   · the cron (app/api/cron/lead-scraping/route.ts) opens it per territory, AFTER the ONE source door
//     (source-discovery-planner.ts resolveSourceDoor) admitted the `datafiniti_people` token; the platform's facts come from
//     pooled-pull.ts platformProviderDoorFacts("datafiniti") + withTerritoryBudget, as for every acquisition vendor;
//   · the pull is lib/lead-pipeline/datafiniti-people-producer.ts runDatafinitiPeoplePull (rights → known keys → account →
//     free count → paidPullApproval → charge once → paid start → THE RawData producer → one booking) — unchanged;
//   · the RESUME CHECKPOINT is a lead_scraping_jobs row (job_type datafiniti_download, the same jobs table the cron and the
//     pre-pull dedup ledger write; job_type carries no CHECK): written the moment a paid download id exists, read first on
//     every later cycle, closed when its result files were ingested;
//   · the COMPLETED-DOWNLOAD READER (readDatafinitiDownloadFile) fetches a result-file link through the ONE egress
//     (connector-gateway callConnector, connector datafiniti, NO credential sent to the file host) and parses the
//     undocumented file format defensively (a JSON array, { records | data: [...] }, or NDJSON) — anything else is
//     UNREADABLE, never guessed.
//
// DORMANT BY DEFAULT. Rights are read FIRST (PROVIDER_ACTIVATION.datafiniti — dormant_pending_rights today): nothing is read,
// written or called until the owner records the licensing decision. The proof flips the rights seam (`activation`) only.
//
// REPLAY-SAFE. A resume makes NO paid call and books nothing (the producer's resume path); a replayed request key is refused
// by the producer's charge-once check; the RawData producer's own (source, source_record_id) idempotency counts a re-ingested
// record as a replay, never a second row. A checkpoint that could not be read refuses the cycle (a blind start could buy the
// same territory twice).

import { PROVIDER_ACTIVATION, type ProviderActivation } from "@/lib/ai-isa/property-lookup-rail"
import { runDatafinitiPeoplePull, DATAFINITI_SOURCE_KEY, type DatafinitiPullDeps, type DatafinitiPullReport } from "@/lib/lead-pipeline/datafiniti-people-producer"
import type { DatafinitiPeopleFilters, DatafinitiPeopleRecord } from "@/lib/external/datafiniti-client"

export const DATAFINITI_DOWNLOAD_JOB_TYPE = "datafiniti_download"
/** One purchase decision per territory per calendar month (the territory budget's own period). */
export const DATAFINITI_TERRITORY_RECORDS_PER_CYCLE = 100
/** A result file larger than this many records is refused as shape drift (a plan's monthly allotment is ≤ 50k). */
const MAX_RECORDS_PER_FILE = 50_000

type Client = { from: (t: string) => any }

export interface DatafinitiTerritory {
  id: string
  name?: string | null
  city: string | null
  state: string | null
  zip_codes?: string[] | null
}

// ─── pure ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE — the request id that anchors the producer's charge-once key: one decision per territory per month. */
export function datafinitiTerritoryRequestId(marketId: string, now: Date): string {
  return `territory:${marketId}:${now.toISOString().slice(0, 7)}`
}

/**
 * PURE — the TYPED filters for a territory (the schema's declared geography fields only — which describe where the person
 * WORKS, lane 153M's published blind spot). A city + state when both are named, else the first 5-digit ZIP; a territory
 * naming neither is refused (null), never widened to a "match everything" pull.
 */
export function datafinitiTerritoryFilters(t: DatafinitiTerritory): DatafinitiPeopleFilters | null {
  const city = (t.city ?? "").trim(), state = (t.state ?? "").trim().toUpperCase()
  if (city && /^[A-Z]{2}$/.test(state)) return { city, province: state, country: "US" }
  const zip = (t.zip_codes ?? []).map((z) => (z ?? "").trim().slice(0, 5)).find((z) => /^\d{5}$/.test(z))
  return zip ? { postalCode: zip, country: "US" } : null
}

/**
 * PURE — parse one result file. The format is not documented to us: a JSON array, an object carrying `records` or `data`,
 * or NDJSON (one record per line). Every record must be an object; one malformed line or a non-object makes the WHOLE file
 * unreadable (null) — a partial parse would ingest half a purchase and report it whole.
 */
export function parseDatafinitiDownloadFile(text: string): DatafinitiPeopleRecord[] | null {
  const body = (text ?? "").replace(/^﻿/, "").trim()
  if (!body) return []
  const isRecord = (v: unknown): v is DatafinitiPeopleRecord => !!v && typeof v === "object" && !Array.isArray(v)
  const finish = (xs: unknown[]): DatafinitiPeopleRecord[] | null => (xs.length <= MAX_RECORDS_PER_FILE && xs.every(isRecord) ? (xs as DatafinitiPeopleRecord[]) : null)
  if (body.startsWith("[") || body.startsWith("{")) {
    try {
      const v = JSON.parse(body) as unknown
      if (Array.isArray(v)) return finish(v)
      if (isRecord(v)) {
        const inner = (v as Record<string, unknown>).records ?? (v as Record<string, unknown>).data
        if (Array.isArray(inner)) return finish(inner)
      }
      // A single JSON object that is not a wrapper — fall through: it may be the first line of NDJSON.
    } catch { /* not one JSON document — try NDJSON */ }
  }
  const out: unknown[] = []
  for (const line of body.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch { return null }
  }
  return finish(out)
}

// ─── the completed-download reader ───────────────────────────────────────────────────────────────────────────────────

export type DatafinitiFileFetch = (url: string) => Promise<{ ok: boolean; status: number | null; text: string | null; error: string | null }>

/** Production file fetch: THE single egress, no credential (a result-file link is the vendor's own short-lived URL). */
export const gatewayDatafinitiFileFetch: DatafinitiFileFetch = async (url) => {
  const u = new URL(url)
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector({
    connector: "datafiniti", baseUrl: u.origin, path: `${u.pathname}${u.search}`, method: "GET",
    auth: { style: "none" }, responseType: "text", retry: false, timeoutMs: 60_000,
  })
  return { ok: res.ok, status: res.status ?? null, text: res.ok ? String(res.data ?? "") : null, error: res.ok ? null : String(res.error ?? "fetch failed").replace(/[?#].*$/, "") }
}

/**
 * THE COMPLETED-DOWNLOAD READER — the producer's `fetchDownloadFile`. Only an https link is fetched; a refused / failed
 * fetch or an unreadable file returns null (the producer then stops at download_pending and the checkpoint stays open for
 * the next cycle — the link lives 7 days). Never throws.
 */
export function readDatafinitiDownloadFile(fetchFile: DatafinitiFileFetch = gatewayDatafinitiFileFetch): (url: string) => Promise<DatafinitiPeopleRecord[] | null> {
  return async (url) => {
    try {
      if (!/^https:\/\/[^\s/]+\/\S*$/.test(url ?? "")) return null
      const r = await fetchFile(url)
      if (!r.ok || r.text === null) return null
      return parseDatafinitiDownloadFile(r.text)
    } catch {
      return null
    }
  }
}

// ─── the checkpoint (lead_scraping_jobs) ─────────────────────────────────────────────────────────────────────────────

export interface DatafinitiCheckpoint {
  id: string
  status: string
  metadata: { download_id?: string | null; request_id?: string | null; filters?: DatafinitiPeopleFilters | null; charge_key?: string | null; route?: string | null } | null
}

/** The OPEN checkpoint for this tenant's territory (status running), or null; a refused read is { ok: false } (fail closed). */
export async function readDatafinitiCheckpoint(client: Client, scope: { brokerageId: string; marketId: string }): Promise<{ ok: true; checkpoint: DatafinitiCheckpoint | null } | { ok: false; reason: string }> {
  const { data, error } = await client.from("lead_scraping_jobs").select("id, status, metadata")
    .eq("job_type", DATAFINITI_DOWNLOAD_JOB_TYPE).eq("brokerage_id", scope.brokerageId).eq("market_id", scope.marketId).eq("status", "running")
    .order("started_at", { ascending: false }).limit(1)
  if (error) return { ok: false, reason: `lead_scraping_jobs: ${error.message ?? String(error)}` }
  const row = Array.isArray(data) ? (data[0] as DatafinitiCheckpoint | undefined) : undefined
  return { ok: true, checkpoint: row ?? null }
}

async function writeCheckpoint(client: Client, row: { brokerageId: string; marketId: string; downloadId: string; requestId: string; chargeKey: string; filters: DatafinitiPeopleFilters; route: string; at: string }): Promise<boolean> {
  const { data, error } = await client.from("lead_scraping_jobs").insert({
    job_type: DATAFINITI_DOWNLOAD_JOB_TYPE, source: DATAFINITI_SOURCE_KEY, status: "running",
    brokerage_id: row.brokerageId, market_id: row.marketId, leads_found: 0, leads_created: 0, started_at: row.at, completed_at: null, error_message: null,
    metadata: { download_id: row.downloadId, request_id: row.requestId, charge_key: row.chargeKey, filters: row.filters, route: row.route },
  }).select("id")
  return !error && Array.isArray(data) && data.length === 1
}

/** Close / annotate the checkpoint — tenant-pinned, and the touched rows COUNTED (an update matching nothing resolves too). */
async function settleCheckpoint(client: Client, scope: { brokerageId: string; id: string }, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await client.from("lead_scraping_jobs").update(patch).eq("id", scope.id).eq("brokerage_id", scope.brokerageId).eq("job_type", DATAFINITI_DOWNLOAD_JOB_TYPE).select("id")
  return !error && Array.isArray(data) && data.length === 1
}

// ─── production seams (the cron's composition) ───────────────────────────────────────────────────────────────────────

/**
 * The producer's PRODUCTION seams for one territory, over the cron's service client — every one an existing survivor:
 * loadKnownAcquisitionKeys (download mode: no candidates exist before a list is bought, so the pre-buy dedup has nothing to
 * judge; the ingress dedup and the RawData producer's own idempotency hold replays), the cron's approved plans (null = the
 * read was refused → paidPullApproval refuses), the platform door facts with this territory's budget, the spend ledger's
 * idempotency key (usage-logger.ts writes it to request_metadata.idempotency_key; a refused read is null → never bought),
 * ingestRawSourceBatch, meterVendorSpend and recordPrePullDedupSavings.
 */
export function productionDatafinitiDoorDeps(svc: Client, scope: {
  brokerageId: string
  marketId: string
  plans: DatafinitiPullDeps["loadPlans"] extends () => Promise<infer P> ? P : never
  platformDoor: DatafinitiPullDeps["platformDoor"]
}): DatafinitiTerritoryDeps {
  return {
    client: svc,
    pull: {
      loadKnown: async () => {
        const { loadKnownAcquisitionKeys } = await import("@/lib/lead-pipeline/pre-pull-dedup")
        return loadKnownAcquisitionKeys(svc as never, { brokerageId: scope.brokerageId, marketIds: [scope.marketId] }, { candidates: [] })
      },
      loadPlans: async () => scope.plans,
      platformDoor: scope.platformDoor ?? null,
      chargeBooked: async (key) => {
        const { data, error } = await svc.from("vendor_usage_tracking").select("id").eq("vendor_name", "datafiniti").eq("request_metadata->>idempotency_key", key).limit(1)
        if (error) return null
        return Array.isArray(data) && data.length > 0
      },
      ingest: async (p) => {
        const { ingestRawSourceBatch } = await import("@/lib/kernel/scraping")
        return ingestRawSourceBatch({ ...p, client: svc as never })
      },
      book: async (i) => {
        const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
        return meterVendorSpend(i)
      },
      recordSavings: async (i) => {
        const { recordPrePullDedupSavings } = await import("@/lib/lead-pipeline/pre-pull-dedup")
        return recordPrePullDedupSavings(svc, i)
      },
    },
  }
}

// ─── the cycle ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DatafinitiTerritoryCycleReport {
  ran: "refused" | "started" | "resumed" | "nothing_to_do"
  stage: string
  refused: string | null
  downloadId: string | null
  checkpoint: { id: string | null; written: boolean | null; closed: boolean | null }
  pull: DatafinitiPullReport | null
}

export interface DatafinitiTerritoryDeps {
  /** The rights seam — production omits it (PROVIDER_ACTIVATION.datafiniti). The proof flips it; nothing else is simulated. */
  activation?: ProviderActivation
  /** lead_scraping_jobs reader / writer (the cron's service client). */
  client: Client
  /** The producer's seams minus the two this door supplies (the reader and the checkpoint hook). */
  pull: Omit<DatafinitiPullDeps, "fetchDownloadFile" | "onDownloadStarted" | "activation">
  /** The completed-download reader (default: readDatafinitiDownloadFile over the gateway). */
  fetchDownloadFile?: (url: string) => Promise<DatafinitiPeopleRecord[] | null>
  /** Injected for the proof; production = runDatafinitiPeoplePull. */
  run?: typeof runDatafinitiPeoplePull
}

/**
 * ONE CYCLE for one territory of one tenant (the tenant is the market row's owner — never a body value). Rights first; then
 * an OPEN checkpoint is resumed (free status + result files → the RawData door, no paid call); otherwise ONE download is
 * started for this month's request id (the producer's gates decide whether anything is bought). Never throws.
 */
export async function runDatafinitiTerritoryCycle(
  input: { brokerageId: string; market: DatafinitiTerritory; now?: Date; numRecords?: number },
  deps: DatafinitiTerritoryDeps,
): Promise<DatafinitiTerritoryCycleReport> {
  const now = input.now ?? new Date()
  const report = (over: Partial<DatafinitiTerritoryCycleReport>): DatafinitiTerritoryCycleReport => ({ ran: "refused", stage: "rights", refused: null, downloadId: null, checkpoint: { id: null, written: null, closed: null }, pull: null, ...over })
  try {
    // 1 · RIGHTS — before any read, write or call.
    const activation = deps.activation ?? PROVIDER_ACTIVATION.datafiniti
    if (activation.state !== "active") {
      return report({ refused: `LICENSE-HELD — Datafiniti is ${activation.state} (${activation.rights.status}); nothing is read, written or called until the owner records the licensing decision` })
    }
    if (!input.brokerageId) return report({ refused: "the territory has no owning tenant — a platform-pool territory cannot fund a people-data pull (OWNER-SQL §L L6.7)" })
    const run = deps.run ?? runDatafinitiPeoplePull
    const reader = deps.fetchDownloadFile ?? readDatafinitiDownloadFile()
    const territory = { city: input.market.city ?? null, state: input.market.state ?? null, zip_codes: input.market.zip_codes ?? [] }

    // 2 · THE CHECKPOINT (fail closed: an unreadable one could start a second purchase of the same territory).
    const cp = await readDatafinitiCheckpoint(deps.client, { brokerageId: input.brokerageId, marketId: input.market.id })
    if (!cp.ok) return report({ stage: "checkpoint", refused: `the download checkpoint could not be read — no download is started blind (${cp.reason})` })

    // 3 · RESUME an open download: free status + result files; no paid call, no booking.
    if (cp.checkpoint) {
      const meta = cp.checkpoint.metadata ?? {}
      const downloadId = typeof meta.download_id === "string" ? meta.download_id : null
      const requestId = typeof meta.request_id === "string" ? meta.request_id : null
      if (!downloadId || !requestId) {
        return report({ stage: "checkpoint", refused: `checkpoint ${cp.checkpoint.id} carries no download id / request id — held for a person (never re-bought)`, checkpoint: { id: cp.checkpoint.id, written: true, closed: false } })
      }
      const pull = await run({
        brokerageId: input.brokerageId, route: "platform", mode: "download", filters: meta.filters ?? datafinitiTerritoryFilters(input.market) ?? {},
        numRecords: 0, requestId, resumeDownloadId: downloadId, territory, marketId: input.market.id, now,
      }, { ...deps.pull, activation, fetchDownloadFile: reader })
      let closed: boolean | null = null
      if (pull.ok && pull.stage === "done") {
        closed = await settleCheckpoint(deps.client, { brokerageId: input.brokerageId, id: cp.checkpoint.id }, {
          status: "completed", completed_at: now.toISOString(), leads_found: pull.returned, leads_created: pull.ingested?.inserted ?? 0, error_message: null,
        })
      } else if (pull.refused === "the download was cancelled") {
        closed = await settleCheckpoint(deps.client, { brokerageId: input.brokerageId, id: cp.checkpoint.id }, { status: "cancelled", completed_at: now.toISOString(), error_message: pull.refused })
      } else if (pull.refused) {
        await settleCheckpoint(deps.client, { brokerageId: input.brokerageId, id: cp.checkpoint.id }, { error_message: pull.refused.slice(0, 500) })
        closed = false
      } else {
        closed = false
      }
      return report({ ran: "resumed", stage: pull.stage, refused: pull.refused, downloadId, checkpoint: { id: cp.checkpoint.id, written: true, closed }, pull })
    }

    // 4 · START this month's download (the producer's gates — count, spend door, charge once — decide whether it buys).
    const filters = datafinitiTerritoryFilters(input.market)
    if (!filters) return report({ stage: "preview", refused: "the territory names no city + state and no ZIP — a people-data pull needs a declared geography (never widened)" })
    const requestId = datafinitiTerritoryRequestId(input.market.id, now)
    let written: boolean | null = null
    const pull = await run({
      brokerageId: input.brokerageId, route: "platform", mode: "download", filters,
      numRecords: Math.max(1, Math.floor(input.numRecords ?? DATAFINITI_TERRITORY_RECORDS_PER_CYCLE)), requestId, territory, marketId: input.market.id, now,
    }, {
      ...deps.pull, activation, fetchDownloadFile: reader,
      onDownloadStarted: async (p) => {
        written = await writeCheckpoint(deps.client, { brokerageId: input.brokerageId, marketId: input.market.id, downloadId: p.downloadId, requestId: p.requestId, chargeKey: p.chargeKey, filters, route: "platform", at: now.toISOString() })
        return written
      },
    })
    if (pull.replayedCharge) {
      return report({ ran: "nothing_to_do", stage: pull.stage, refused: `this month's ${DATAFINITI_SOURCE_KEY} request for the territory was already bought and no checkpoint is open — nothing re-bought; a person reconciles it from the spend ledger (request ${requestId})`, pull })
    }
    if (!pull.downloadId) return report({ ran: pull.ok ? "nothing_to_do" : "refused", stage: pull.stage, refused: pull.refused, pull })
    let closed: boolean | null = false
    if (pull.ok && pull.stage === "done" && written) {
      const open = await readDatafinitiCheckpoint(deps.client, { brokerageId: input.brokerageId, marketId: input.market.id })
      const id = open.ok ? open.checkpoint?.id ?? null : null
      closed = id ? await settleCheckpoint(deps.client, { brokerageId: input.brokerageId, id }, { status: "completed", completed_at: now.toISOString(), leads_found: pull.returned, leads_created: pull.ingested?.inserted ?? 0 }) : false
    }
    return report({ ran: "started", stage: pull.stage, refused: pull.refused, downloadId: pull.downloadId, checkpoint: { id: null, written, closed }, pull })
  } catch (e) {
    return report({ stage: "error", refused: `the Datafiniti territory cycle threw: ${e instanceof Error ? e.message : String(e)}` })
  }
}
