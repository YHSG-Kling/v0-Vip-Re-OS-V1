// lib/external/apify-actors.ts
// Apify actor RESILIENCE. Public actors come and go; a single hard-coded actor
// id is a single point of failure. Each logical scrape task has an ordered list
// of candidate actors (primary + fallbacks). runApifyTask tries them in order and
// returns the first success; if a candidate is gone (404) or errors, it moves to
// the next; if all fail it returns empty (graceful — the cron keeps running other
// sources). The actor-health cron probes each candidate and records which are
// alive so dead ones are skipped (no wasted failed-run cost). When no Apify actor
// works, the caller falls back to ZenRows where the data type allows.

import { actorExists, type AdapterResult, type ApifyRunCursor } from "@/lib/providers/apify/client"

export type ApifyTask = "reddit" | "facebook" | "instagram" | "craigslist" | "google" | "linkedin" | "facebook_marketplace" | "fsbo_site"

/**
 * Ordered candidate actors per task — primary first. Multiple public actors
 * exist for each source; if one is removed we try the next. Keep primaries
 * cost-effective; fallbacks are alternates that accept compatible input.
 *
 * RE-VERIFIED 2026-09-15 (wave 65, Exa research — see
 * docs/lead-acquisition-coverage-2026-09.md for citations + pricing). Reddit's own
 * logged-out search.json API is reported hard-blocked (403) as of mid-2026, which is why a
 * dedicated Reddit SEARCH actor (clearpath) now leads that list ahead of the older
 * subreddit-listing-style trudax actor. The LinkedIn "no-cookies" slug below is the real,
 * currently-live actor id — the old entry (missing the "-no-cookies" suffix) was never
 * confirmed live and is kept only as an unverified last resort.
 */
export const ACTOR_REGISTRY: Record<ApifyTask, string[]> = {
  reddit:     ["clearpath/reddit-search-scraper", "harshmaur/reddit-search-scraper", "trudax/reddit-scraper", "trudax/reddit-scraper-lite", "oxylabs/reddit-scraper"],
  facebook:   ["memo23/facebook-public-group-posts-scraper", "scrapier/facebook-groups-posts-scraper", "logical_scrapers/facebook-group-posts-scraper", "apify/facebook-posts-scraper", "apify/facebook-pages-scraper"],
  instagram:  ["apify/instagram-hashtag-scraper", "apidojo/instagram-hashtag-scraper", "apify/instagram-scraper", "apify/instagram-search-scraper"],
  craigslist: ["solidcode/craigslist-scraper", "epctex/craigslist-scraper", "ivanvs/craigslist-scraper", "lukaskrivka/craigslist-scraper"],
  google:     ["apify/google-search-scraper", "scraping-fish/google-search-results-scraper"],
  linkedin:   ["apimaestro/linkedin-posts-search-scraper-no-cookies", "harvestapi/linkedin-post-search", "curious_coder/linkedin-post-search-scraper", "apimaestro/linkedin-posts-search-scraper"],
  // Lane 82B (Exa, 2026-09-25): Marketplace PROPERTY-FOR-SALE listings — the FSBO seller lane the
  // facebook_marketplace SourceKey defined since wave 55 with no collector. Primary is Apify's own
  // actor (apify.com/apify/facebook-marketplace-scraper — pay-per-result $5/1k, "from $2.60/1k",
  // location/category/search Marketplace URLs, no login); fallback is the property-specific
  // vivid-softwares/facebook-property-scraper ($18/1k, `forSaleOnly`, seller + beds/baths parsed).
  facebook_marketplace: ["apify/facebook-marketplace-scraper", "vivid-softwares/facebook-property-scraper"],
  // Lane 89B (Exa, 2026-09-29): forsalebyowner.com — the dedicated FSBO marketplace — owner-posted
  // listings by city slug. Primary memo23/forsalebyowner-scraper (states / `city-state` slugs /
  // search URLs, `source: fsbo`, `status: for_sale`, `monitoringMode` returns only listings not seen
  // on earlier runs, US-residential proxy handled by the actor); fallbacks parseforge/forsalebyowner-
  // scraper (`mode: api` + `searchSlug`, 30+ fields incl. owner name + phone) and the homepage-only
  // jungle_synthesizer actor (~20 featured cards, last resort). Pay-per-result ~$3–5 / 1k listings
  // vs BatchData's 'for-sale-by-owner' quickList at $0.05 / RECORD — the same population ~10× cheaper.
  fsbo_site: ["memo23/forsalebyowner-scraper", "parseforge/forsalebyowner-scraper", "jungle_synthesizer/forsalebyowner-scraper"],
  // TOMBSTONE — tiktok_search / tiktok_comments (lane 83A) retired by lane 84C. Owner, 2026-09-26:
  // "don't need tiktok." No other task uses those actors; nothing to merge.
}

export type ActorRunner = (actorId: string, input: Record<string, any>) => Promise<{ data: any[]; cost: number; run?: ApifyRunCursor; readError?: string }>

export interface ApifyTaskResult {
  data: any[]
  cost: number
  actorUsed: string | null
  triedActors: string[]
  /** Items drained this call from an EARLIER run's dataset (its cursor; no new charge). */
  resumedItems: number
  /** No new run was started because an earlier run of the same work is still open (still running, or its read is
   *  being retried) — starting another would pay twice for one scrape. */
  newRunSkipped: boolean
  /** The started run's cursor, when a run started this call. */
  cursor: ApifyRunCursor | null
  /** A cursor that could not be persisted / read, said in words (the run's items still returned). */
  cursorNote: string | null
}

// ─── THE RUN CURSOR (wave 152, lane 152J — convergence row 55) ─────────────────────────────────────────────────────────
//
// What the vendor documents, and nothing more: an Actor run has an id, a status and a default dataset; a dataset is read
// with offset / limit (docs.apify.com/api/v2 — GET /v2/actor-runs/{runId}, GET /v2/datasets/{datasetId}/items). Each
// pull here STARTS A NEW RUN (actor.call), so there is no cross-run watermark to fabricate — where an Actor documents an
// incremental input it is passed as an input (the FSBO primary's `monitoringMode`, lib/external/apify-client.ts). The
// real gap was WITHIN a run: actor.call({ waitSecs: 60 }) returns the run as it stands at 60 s (often RUNNING — the Actor
// keeps going and keeps billing), the dataset was read once, the rest was never read, and the next tick paid for a
// fresh run of the same scrape. So a run that is unfinished, or whose read stopped part-way, leaves a CURSOR (run id,
// dataset id, offset, attempts, last error) on the scrape JOB ledger (lead_scraping_jobs — job_type 'apify_run_cursor',
// metadata holds the cursor; no new table), and the next call for the same work drains that dataset from its offset
// first (free — a dataset read is not a run) and starts no new run while the earlier one is still open. Dedup across
// resumes is the offset itself (an item is read once); records are deduped again downstream at the RawData door.

/** The scrape-job row kind that carries an open run cursor (lead_scraping_jobs.job_type has no CHECK; one constant). */
const APIFY_CURSOR_JOB_TYPE = "apify_run_cursor"
/** Unnamed run datasets are kept for a limited time (Apify data retention for unnamed storages, 7 days on the default
 *  plan). A cursor older than this is retired, never resumed into a dataset that may be gone. */
const APIFY_CURSOR_RETENTION_DAYS = 7
/** Resume attempts before an open cursor is retired as failed (retry state is bounded, never forever). */
const APIFY_CURSOR_MAX_ATTEMPTS = 3

interface ApifyCursorRecord {
  id: string | null
  task: ApifyTask
  actorId: string
  scopeKey: string
  cursor: ApifyRunCursor
  attempts: number
  openedAt: string
  itemsRead: number
}

/** Where open cursors live. The default writes the scrape job ledger; a proof injects an in-memory one. */
interface ApifyCursorStore {
  /** Open cursors for this work; null = unreadable (the caller then starts no paid run blind). */
  loadOpen(task: ApifyTask, scopeKey: string): Promise<ApifyCursorRecord[] | null>
  open(rec: ApifyCursorRecord, lastError: string | null): Promise<{ ok: boolean; error: string | null }>
  advance(rec: ApifyCursorRecord, next: ApifyRunCursor, newItems: number, outcome: "open" | "completed" | "failed", lastError: string | null): Promise<{ ok: boolean; error: string | null }>
  /** Retire every open cursor of this TASK opened before `cutoffIso`, whatever its scope (a scope whose input never recurs
   *  — a territory that changed — would otherwise leave its cursor "running" forever). Returns how many were retired. */
  retireExpired(task: ApifyTask, cutoffIso: string, reason: string): Promise<{ retired: number; error: string | null }>
}

/** PURE — the work's identity: the task + its input (stable key order), hashed (FNV-1a, a grouping key, not a secret). */
function apifyScopeKey(task: ApifyTask, input: Record<string, unknown>): string {
  const stable = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`
    if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`
    return JSON.stringify(v ?? null)
  }
  const text = `${task}|${stable(input)}`
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0
  }
  return `${task}:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

/** The default store — the scrape JOB ledger. Platform-level rows (no market, no tenant): one Actor run can serve many
 *  territories (the pooled FSBO run). Every refusal is READ and every update COUNTED (CLAUDE.md §3). */
function jobLedgerCursorStore(client?: { from: (t: string) => any }): ApifyCursorStore {
  const svc = async () => client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as { from: (t: string) => any })
  const meta = (rec: ApifyCursorRecord, cursor: ApifyRunCursor, attempts: number, lastError: string | null) => ({
    vendor: "apify", task: rec.task, actor: rec.actorId, scope_key: rec.scopeKey, run_id: cursor.runId, dataset_id: cursor.datasetId,
    item_offset: cursor.offset, run_status: cursor.runStatus, finished: cursor.finished, attempts, last_error: lastError, opened_at: rec.openedAt,
  })
  return {
    async loadOpen(task, scopeKey) {
      const { data, error } = await (await svc()).from("lead_scraping_jobs").select("id, metadata, leads_found, created_at")
        .eq("job_type", APIFY_CURSOR_JOB_TYPE).eq("status", "running").eq("source", `apify:${task}`).eq("metadata->>scope_key", scopeKey).limit(10)
      if (error) { console.error(`[apify-cursor] open cursors for ${scopeKey} could not be read: ${error.message}`); return null }
      return ((data ?? []) as Array<{ id: string; metadata: Record<string, any>; leads_found: number | null; created_at: string }>).map((r) => ({
        id: r.id, task, actorId: String(r.metadata?.actor ?? ""), scopeKey,
        cursor: { runId: String(r.metadata?.run_id ?? ""), datasetId: String(r.metadata?.dataset_id ?? ""), offset: Number(r.metadata?.item_offset ?? 0) || 0, runStatus: String(r.metadata?.run_status ?? ""), finished: r.metadata?.finished === true },
        attempts: Number(r.metadata?.attempts ?? 0) || 0, openedAt: String(r.metadata?.opened_at ?? r.created_at), itemsRead: Number(r.leads_found ?? 0) || 0,
      })).filter((r) => r.cursor.runId && r.cursor.datasetId)
    },
    async open(rec, lastError) {
      const { error } = await (await svc()).from("lead_scraping_jobs").insert({
        job_type: APIFY_CURSOR_JOB_TYPE, source: `apify:${rec.task}`, status: "running", brokerage_id: null, market_id: null,
        leads_found: rec.itemsRead, leads_created: 0, started_at: rec.openedAt, error_message: lastError, metadata: meta(rec, rec.cursor, rec.attempts, lastError),
      })
      return { ok: !error, error: error?.message ?? null }
    },
    async advance(rec, next, newItems, outcome, lastError) {
      if (!rec.id) return { ok: false, error: "no cursor row id" }
      const { data, error } = await (await svc()).from("lead_scraping_jobs").update({
        status: outcome === "open" ? "running" : outcome === "completed" ? "completed" : "failed",
        leads_found: rec.itemsRead + newItems, error_message: lastError, metadata: meta(rec, next, rec.attempts, lastError),
        ...(outcome === "open" ? {} : { completed_at: new Date().toISOString() }),
      }).eq("id", rec.id).eq("job_type", APIFY_CURSOR_JOB_TYPE).select("id")
      if (error) return { ok: false, error: error.message }
      if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: `cursor row ${rec.id} matched ${Array.isArray(data) ? data.length : 0} rows` }
      return { ok: true, error: null }
    },
    async retireExpired(task, cutoffIso, reason) {
      const { data, error } = await (await svc()).from("lead_scraping_jobs").update({ status: "failed", error_message: reason, completed_at: new Date().toISOString() })
        .eq("job_type", APIFY_CURSOR_JOB_TYPE).eq("status", "running").eq("source", `apify:${task}`).lt("created_at", cutoffIso).select("id")
      if (error) return { retired: 0, error: error.message }
      return { retired: Array.isArray(data) ? data.length : 0, error: null }
    },
  }
}

/** The store a call uses: the injected one; `false` = none; else the job ledger ONLY inside the app server (NEXT_RUNTIME
 *  — the lib/enrichment/inline-drain.ts precedent), so a script or a proof never writes the live ledger by accident. */
function resolveCursorStore(opt: ApifyCursorStore | false | undefined, ledgerClient: { from: (t: string) => any } | undefined): ApifyCursorStore | null {
  if (opt === false) return null
  if (opt) return opt
  if (ledgerClient) return jobLedgerCursorStore(ledgerClient)
  return process.env.NEXT_RUNTIME ? jobLedgerCursorStore() : null
}

/**
 * Pure: ordered candidates for a task, with known-dead actors removed.
 * healthMap maps actorId -> alive. Unknown actors are kept (try them).
 */
export function pickActors(task: ApifyTask, healthMap?: Record<string, boolean>): string[] {
  const candidates = ACTOR_REGISTRY[task] ?? []
  if (!healthMap) return [...candidates]
  const alive = candidates.filter((id) => healthMap[id] !== false)
  // If health knocked everything out, still try the primary (health may be stale).
  return alive.length > 0 ? alive : candidates.slice(0, 1)
}

/**
 * Run a task across its candidate actors, returning the first success. Tries the
 * next candidate ONLY when a run never started (a removed/404 actor, a refused
 * token) — a run that started is billed, so it is never followed by a second
 * candidate's run (row 55). Before starting anything, drains any OPEN cursor for
 * the same work (task + input) from its dataset offset; while one stays open, no
 * new run starts. Never throws.
 * @param opts.runner injectable for tests; defaults to the real Apify runner.
 * @param opts.resumer injectable for tests; defaults to resumeRunDataset with the platform token.
 * @param opts.cursorStore injectable for tests; `false` opts out; default = the scrape job ledger inside the app server.
 */
export async function runApifyTask(
  task: ApifyTask,
  input: Record<string, any>,
  opts?: {
    runner?: ActorRunner
    healthMap?: Record<string, boolean>
    resumer?: (cursor: ApifyRunCursor) => Promise<AdapterResult<any[]>>
    cursorStore?: ApifyCursorStore | false
    /** The client the DEFAULT job-ledger store writes through (a proof injects the in-memory client). */
    cursorLedgerClient?: { from: (t: string) => any }
    now?: Date
  },
): Promise<ApifyTaskResult> {
  const runner = opts?.runner ?? ((await import("./apify-client")).runApifyActor as ActorRunner)
  const now = opts?.now ?? new Date()
  const store = resolveCursorStore(opts?.cursorStore, opts?.cursorLedgerClient)
  const scopeKey = apifyScopeKey(task, input)
  const resumed: any[] = []
  const notes: string[] = []
  let stillOpen = false

  if (store) {
    // Housekeeping first: every cursor of this task past the retention window is retired, whatever its scope.
    const cutoffIso = new Date(now.getTime() - APIFY_CURSOR_RETENTION_DAYS * 86_400_000).toISOString()
    const swept = await store.retireExpired(task, cutoffIso, `retired: older than the ${APIFY_CURSOR_RETENTION_DAYS}-day dataset retention window`).catch((e) => ({ retired: 0, error: e instanceof Error ? e.message : String(e) }))
    if (swept.error) notes.push(`expired cursors not retired: ${swept.error}`)
    const open = await store.loadOpen(task, scopeKey).catch((e) => { notes.push(`open cursors unreadable: ${e instanceof Error ? e.message : String(e)}`); return null })
    if (open === null) {
      // FAIL CLOSED: an unreadable cursor ledger may hide a still-running paid run — do not buy another one blind.
      notes.push("the run-cursor ledger could not be read, so no new run was started (an earlier run may still be open)")
      return { data: [], cost: 0, actorUsed: null, triedActors: [], resumedItems: 0, newRunSkipped: true, cursor: null, cursorNote: notes.join("; ") }
    }
    const resume = opts?.resumer ?? (async (c: ApifyRunCursor) => {
      const [{ resumeRunDataset }, { apifyToken }] = await Promise.all([import("@/lib/providers/apify/client"), import("@/lib/env/aliases")])
      return resumeRunDataset(apifyToken() ?? "", c)
    })
    for (const rec of open) {
      const ageDays = (now.getTime() - Date.parse(rec.openedAt)) / 86_400_000
      if (Number.isFinite(ageDays) && ageDays > APIFY_CURSOR_RETENTION_DAYS) {
        const w = await store.advance(rec, rec.cursor, 0, "failed", `retired: older than the ${APIFY_CURSOR_RETENTION_DAYS}-day dataset retention window`)
        if (!w.ok) notes.push(`cursor ${rec.cursor.runId} not retired: ${w.error}`)
        continue
      }
      let r: AdapterResult<any[]>
      try { r = await resume(rec.cursor) } catch (e) { r = { ok: false, status: null, data: null, error: e instanceof Error ? e.message : String(e), run: rec.cursor } }
      const got = Array.isArray(r.data) ? r.data : []
      resumed.push(...got)
      const next = r.run ?? rec.cursor
      if (!r.ok) {
        const attempts = rec.attempts + 1
        const outcome = attempts >= APIFY_CURSOR_MAX_ATTEMPTS ? "failed" : "open"
        const w = await store.advance({ ...rec, attempts }, next, got.length, outcome, r.error ?? "resume failed")
        if (!w.ok) notes.push(`cursor ${rec.cursor.runId} not advanced: ${w.error}`)
        if (outcome === "open") stillOpen = true
        continue
      }
      const outcome = next.finished ? "completed" : "open"
      const w = await store.advance(rec, next, got.length, outcome, null)
      if (!w.ok) notes.push(`cursor ${rec.cursor.runId} not advanced: ${w.error}`)
      if (outcome === "open") stillOpen = true
    }
    if (stillOpen) {
      return { data: resumed, cost: 0, actorUsed: null, triedActors: [], resumedItems: resumed.length, newRunSkipped: true, cursor: null, cursorNote: notes.length ? notes.join("; ") : null }
    }
  }

  const candidates = pickActors(task, opts?.healthMap)
  const tried: string[] = []
  for (const actorId of candidates) {
    tried.push(actorId)
    try {
      const r = await runner(actorId, input)
      const runData = r.data ?? []
      if (r.run && (!r.run.finished || r.readError)) {
        // The run started (billed) and its dataset is not fully read: leave the cursor for the next call to drain.
        if (store) {
          const w = await store.open({ id: null, task, actorId, scopeKey, cursor: r.run, attempts: r.readError ? 1 : 0, openedAt: now.toISOString(), itemsRead: runData.length }, r.readError ?? null)
          if (!w.ok) notes.push(`run ${r.run.runId} cursor not saved: ${w.error}`)
        } else {
          notes.push(`run ${r.run.runId} is ${r.run.finished ? "finished" : "still running"} with ${r.run.offset} item(s) read and no cursor store in this context`)
        }
      }
      return { data: [...resumed, ...runData], cost: r.cost ?? 0, actorUsed: actorId, triedActors: tried, resumedItems: resumed.length, newRunSkipped: false, cursor: r.run ?? null, cursorNote: notes.length ? notes.join("; ") : null }
    } catch (err) {
      console.warn(`[ApifyTask:${task}] actor ${actorId} failed, trying next:`, err instanceof Error ? err.message : String(err))
    }
  }
  return { data: resumed, cost: 0, actorUsed: null, triedActors: tried, resumedItems: resumed.length, newRunSkipped: false, cursor: null, cursorNote: notes.length ? notes.join("; ") : null }
}

/** Does an Apify actor still exist? Official SDK adapter
 *  (lib/providers/apify/client.ts) — same GET /v2/acts/{id} endpoint. */
export async function checkActorExists(actorId: string): Promise<boolean> {
  const token = process.env.APIFY_API_TOKEN
  if (!token) return false
  return actorExists(token, actorId)
}
