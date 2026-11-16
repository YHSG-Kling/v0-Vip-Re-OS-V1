// lib/providers/scrape-checkpoint.ts
// ─────────────────────────────────────────────────────────────────────────────
// REPLAY-SAFE SNAPSHOT CHECKPOINTS FOR THE PAGE-FETCH SCRAPERS (wave 153, lane 153G — convergence row 55).
//
// Row 55: the Apify run cursor was built in wave 152 (lib/external/apify-actors.ts — a run id, a dataset and an offset are
// what Apify DOCUMENTS). Zyte (POST api.zyte.com/v1/extract) and ZenRows (GET api.zenrows.com/v1/) are single-page fetch
// APIs: neither documents a cursor, a watermark or a change feed, so NONE IS INVENTED HERE. What both DO document, and what
// this module uses, is read from the vendors' own pages (2026-11-14):
//   · Zyte — `httpResponseHeaders: true` returns the target's response headers in any mode (except serp);
//     `customHttpRequestHeaders` may be sent ONLY with `httpResponseBody` (a browser request may set Referer alone); only
//     successful responses are charged — rate-limiting (429 / 503) and unsuccessful responses (incl. the 520 ban) are free,
//     and a target's own non-ban status (a 404, a 304) IS a successful, charged response (docs.zyte.com/zyte-api/usage/
//     reference.html, /usage/errors.html, /pricing.html).
//   · ZenRows — `custom_headers=true` forwards request headers; target headers come back prefixed `Zr-`; `original_status`
//     returns the target's status; `X-Request-Cost` states the request's dollar cost; only the configuration that succeeds is
//     billed (docs.zenrows.com/fetch/api-reference, /fetch/features/headers, /fetch/features/other).
//
// THE LAWFUL ALTERNATE CHECKPOINT (directive G2), per TARGET (a normalized URL — the source, not the transport, so the picker
// may switch providers between ticks without losing it):
//   · a STABLE CONTENT DIGEST of the page (scripts / styles / comments / nonces / CSRF tokens stripped) — an unchanged page
//     forwards ZERO records, so a re-run creates no RawData and books no paid record (the fetch itself is booked once, as
//     the request it was);
//   · OBSERVED vs PROCESSED watermarks — the observed digest moves on every successful fetch, the processed digest only when
//     the caller COMMITS that its ingest succeeded; a crash between fetch and ingest leaves them apart and the next tick
//     re-processes (the RawData door's idempotency key makes that replay one observation);
//   · SOURCE EVENT TIMESTAMPS — each record's own date (the ONE derivation, buildRawDataEnvelope's signal_at) moves
//     maxSourceEventAt; a dated record older than that minus the BOUNDED RESCAN WINDOW is outside the region still re-read;
//     record digests inside the window are kept (bounded, pruned by age and count) so a re-read record is not forwarded twice;
//   · CONDITIONAL REQUESTS only where permitted — the provider documents forwarding request headers in that mode AND the
//     source itself returned a validator (ETag / Last-Modified) on an earlier fetch; otherwise the digest alone decides;
//   · SOURCE-DEFINED PAGINATION only — a next page is followed only when the page itself publishes rel="next" on the same
//     host, from page 1 each tick, stopping at the first unchanged page or the page cap (never a stored or computed cursor);
//   · BACKPRESSURE / TIMEOUTS / RETRIES / SPEND — a minimum re-fetch interval, a per-tick fetch budget, a bounded timeout,
//     exponential backoff on the failures the vendors say to retry (rate limiting, ban, service) and a hold on the ones they
//     say not to (auth, invalid, domain forbidden), and the caller's spend gate BEFORE any paid request;
//   · ROBOTS AND CONTRACT TERMS — robots.txt is read under RFC 9309 (2xx parsed, 4xx = no file, 5xx / unreachable = complete
//     disallow) with the ONE parser (lib/assets/screenshot-capture.ts isRobotsAllowed), cached ≤ 24 h; a host whose terms
//     restrict automated collection is HELD unless a written agreement is recorded here by a reviewed change — Zyte, ZenRows
//     and Apify are collection infrastructure, not a license to a site's data (directive G2).
//
// STATE lives on the scrape JOB ledger (lead_scraping_jobs — job_type `scrape_snapshot_checkpoint`, metadata jsonb holds the
// checkpoint; job_type has no CHECK; the Apify cursor precedent; no new table). FAIL CLOSED: an unreadable checkpoint starts
// no paid fetch. PURE where it decides; every I/O door (store, fetcher, robots, spend) is injected so the proof drives the
// same code the cron runs. No "server-only": the cron and the proofs both load it (the zenrows adapter's precedent).

import { stableContentDigest, buildRawDataEnvelope, type NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import { isRobotsAllowed } from "@/lib/assets/screenshot-capture"
import { sourceRightsForUrl } from "@/lib/providers/exa/hunting"
import { VENDOR_PRICING, ZYTE_REQUEST_COST_USD } from "@/lib/vendor-governance/cost-normalizer"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** The scrape-job row kind that carries a snapshot checkpoint (lead_scraping_jobs.job_type has no CHECK; one constant). */
const CHECKPOINT_JOB_TYPE = "scrape_snapshot_checkpoint"
/** RFC 9309 §2.4: a cached robots.txt SHOULD NOT be used for more than 24 hours. */
const ROBOTS_CACHE_MS = 24 * HOUR_MS
/** The token robots.txt groups are matched against (and the `*` group too — a provider fetches with its own UA). */
const ROBOTS_USER_AGENT_TOKEN = "VipReOS-AcquisitionBot"
const DEFAULTS = Object.freeze({
  minIntervalMinutes: 360,
  rescanWindowDays: 14,
  maxSeen: 1000,
  maxPages: 1,
  timeoutMs: 75_000,
  maxAttempts: 3,
})

type ScrapeProvider = "zyte" | "zenrows"

// ─── what each transport DOCUMENTS (one table; the capability matrix and the guard read it) ─────────────────────────────

interface SnapshotTransportFacts {
  cursor: "none"
  /** Which request mode may carry If-None-Match / If-Modified-Since, as the vendor documents request headers. */
  conditionalRequests: { httpMode: boolean; browserMode: boolean; how: string }
  /** How the target's own validators are read back. */
  responseHeaders: string
  billing: string
  /** Vendor statuses the vendor says to RETRY (free) vs to hold (a retry cannot fix them). */
  retryStatuses: readonly number[]
  holdStatuses: readonly number[]
  docs: readonly string[]
}

export const SNAPSHOT_TRANSPORT_FACTS: Readonly<Record<ScrapeProvider, SnapshotTransportFacts>> = Object.freeze({
  zyte: {
    cursor: "none",
    conditionalRequests: { httpMode: true, browserMode: false, how: "customHttpRequestHeaders — only with httpResponseBody; a browser request may set Referer alone" },
    responseHeaders: "httpResponseHeaders: true (any mode except serp)",
    billing: "only successful responses are charged; rate-limiting (429/503) and unsuccessful responses (incl. the 520 ban) are free; a target's own non-ban status (404, 304) is a successful, charged response",
    retryStatuses: [429, 503, 520, 521, 500],
    holdStatuses: [400, 401, 403, 421, 422, 451],
    docs: ["docs.zyte.com/zyte-api/usage/reference.html", "docs.zyte.com/zyte-api/usage/errors.html", "docs.zyte.com/zyte-api/pricing.html (read 2026-11-14)"],
  },
  zenrows: {
    cursor: "none",
    conditionalRequests: { httpMode: true, browserMode: true, how: "custom_headers=true forwards request headers (the SDK sets it when headers are passed); original_status returns the target status" },
    responseHeaders: "target headers prefixed Zr- (Zr-Etag / Zr-Last-Modified when the target sends them); X-Request-Cost states the dollar cost",
    billing: "only the configuration that succeeds is billed; failed attempts are not charged (1 / 5 / 10 / 25 credits by js_render and premium_proxy)",
    retryStatuses: [429, 422, 503, 504, 500],
    holdStatuses: [400, 401, 402, 403],
    docs: ["docs.zenrows.com/fetch/api-reference", "docs.zenrows.com/fetch/features/headers", "docs.zenrows.com/fetch/features/other (read 2026-11-14)"],
  },
})

// ─── contract terms: hosts whose terms restrict automated collection (HELD unless a written agreement is recorded) ──────

/** Real-estate portals whose terms restrict automated collection without written permission (the repo's own records:
 *  lib/marketing/estimate-sources.ts tosNote; lib/intent/movement-source-registry.ts CONTESTED licences). */
const PORTAL_TERMS_HOSTS = /(^|\.)(zillow|trulia|realtor|redfin|homes)\.com$/i
const CLASSIFIED_TERMS_HOSTS = /(^|\.)craigslist\.org$/i
/** Nextdoor (wave 153, lane 153N — owner ruling B2 / directive Part B §4.2): its Member Agreement forbids unauthorized scraping
 *  and Nextdoor publishes no read API. The owner routed Nextdoor THROUGH the Zyte / ZenRows transport (this checkpoint); the
 *  rights stay a NAMED HOLD — LICENSE_REQUIRED — that exactly one reviewed, recorded agreement (SCRAPE_TARGET_AGREEMENTS
 *  ["nextdoor.com"]) lifts. Never a flag, never a manager's or a healer's decision. */
const NEXTDOOR_TERMS_HOST = /(^|\.)nextdoor\.com$/i

/**
 * A WRITTEN agreement that lets a terms-restricted host be fetched. EMPTY: none is recorded. Adding a host is a REVIEWED
 * change carrying the agreement's reference (the PROVIDER_ACTIVATION doctrine — never a flag a manager or a healer flips).
 */
const SCRAPE_TARGET_AGREEMENTS: Readonly<Record<string, { reference: string; recordedAt: string; scope: string }>> = Object.freeze({})

interface TermsVerdict { allowed: boolean; basis: "no_known_restriction" | "portal_terms" | "classified_terms" | "license_required" | "forum_platform_terms" | "written_agreement"; note: string }

/** PURE — may this host be fetched under its terms? (Robots is decided separately; both must allow.) */
function scrapeTargetTermsVerdict(host: string, url: string, agreements = SCRAPE_TARGET_AGREEMENTS): TermsVerdict {
  const bare = host.replace(/^www\./, "")
  const agreement = agreements[bare]
  if (agreement) return { allowed: true, basis: "written_agreement", note: `written agreement ${agreement.reference} (${agreement.scope}, recorded ${agreement.recordedAt})` }
  if (PORTAL_TERMS_HOSTS.test(bare)) return { allowed: false, basis: "portal_terms", note: `${bare}'s terms restrict automated collection without written permission — held until an agreement is recorded (Zyte / ZenRows are transports, not a license to the site's data)` }
  if (CLASSIFIED_TERMS_HOSTS.test(bare)) return { allowed: false, basis: "classified_terms", note: `${bare}'s terms of use prohibit automated collection — held until an agreement is recorded` }
  if (NEXTDOOR_TERMS_HOST.test(bare)) return { allowed: false, basis: "license_required", note: "LICENSE_REQUIRED — Nextdoor's Member Agreement forbids unauthorized scraping and it publishes no read API; the route runs through this transport and stays held until a reviewed written agreement is recorded for nextdoor.com (an owner decision)" }
  const rights = sourceRightsForUrl(url)
  if (rights.sourceClass === "public_forum") return { allowed: false, basis: "forum_platform_terms", note: rights.termsNote }
  return { allowed: true, basis: "no_known_restriction", note: "no recorded terms restriction for this host (robots.txt still decides)" }
}

// ─── the target + the digest ────────────────────────────────────────────────────────────────────────────────────────

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref|ref_src|_ga)$/i

/** PURE — the target as a stable key: https/http only, host lowercased, fragment and tracking params dropped, query sorted. */
function normalizeTarget(url: string): { url: string; host: string; origin: string; path: string } | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  u.hash = ""
  u.hostname = u.hostname.toLowerCase()
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  u.search = ""
  for (const [k, v] of kept) u.searchParams.append(k, v)
  return { url: u.toString(), host: u.hostname, origin: u.origin, path: `${u.pathname}${u.search}` }
}

/** PURE — the page's content digest: volatile markup (scripts, styles, comments, nonces, CSRF / request tokens,
 *  build ids) removed and whitespace collapsed, then the ONE stable digest (raw-record-types.ts stableContentDigest). */
function snapshotDigest(html: string): string {
  const stable = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s(nonce|integrity|data-reactid|data-react-checksum|data-csrf|data-request-id|data-build-id)=("[^"]*"|'[^']*')/gi, "")
    .replace(/<meta[^>]+name=["'](csrf-token|csrf-param|request-id|build-id)["'][^>]*>/gi, "")
    .replace(/<input[^>]+name=["'](authenticity_token|csrfmiddlewaretoken|_token|__RequestVerificationToken)["'][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
  return stableContentDigest(stable)
}

/** PURE — a record's digest (what makes two reads the SAME observation; never a clock). */
function recordDigest(r: NormalizedScrapedRecord): string {
  return stableContentDigest([r.source, r.sourceRecordId, r.email ?? null, r.phone ?? null, r.propertyAddress ?? null, r.firstName ?? null, r.lastName ?? null, r.sourceUrl ?? null])
}

/** PURE — the record's own event date through THE ONE derivation (buildRawDataEnvelope signal_at); null when undated. */
function recordEventAt(r: NormalizedScrapedRecord, nowMs: number): string | null {
  return buildRawDataEnvelope(r, { brokerageId: null, rights: { rights: "checkpoint", licence: null }, entityKindOf: () => null, actorType: "cron", costUsd: null, nowMs }).signal_at
}

/** PURE — the next page a SOURCE published (rel="next", same host), or null. Never computed, never stored. */
function sourceNextLink(html: string, base: string): string | null {
  const m = /<(?:link|a)\b[^>]*\brel=["']?next["']?[^>]*>/i.exec(html)
  if (!m) return null
  const href = /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1]
  if (!href) return null
  try {
    const next = new URL(href.replace(/&amp;/g, "&"), base)
    return next.hostname.toLowerCase() === new URL(base).hostname.toLowerCase() && /^https?:$/.test(next.protocol) ? next.toString() : null
  } catch { return null }
}

// ─── the checkpoint state ──────────────────────────────────────────────────────────────────────────────────────────

interface CheckpointState {
  key: string
  targetUrl: string
  host: string
  observedAt: string | null
  observedDigest: string | null
  processedAt: string | null
  processedDigest: string | null
  maxSourceEventAt: string | null
  /** Committed record digests inside the rescan window, bounded (d = digest, at = event or observation time). */
  seen: Array<{ d: string; at: string }>
  validators: { etag: string | null; lastModified: string | null }
  attempts: number
  retryAfter: string | null
  lastError: string | null
  lastProvider: ScrapeProvider | null
  robots: { allowed: boolean; checkedAt: string; basis: string } | null
  fetches: number
  unchangedFetches: number
  spendUsd: number
}

function emptyState(key: string, targetUrl: string, host: string): CheckpointState {
  return { key, targetUrl, host, observedAt: null, observedDigest: null, processedAt: null, processedDigest: null, maxSourceEventAt: null, seen: [], validators: { etag: null, lastModified: null }, attempts: 0, retryAfter: null, lastError: null, lastProvider: null, robots: null, fetches: 0, unchangedFetches: 0, spendUsd: 0 }
}

/** Where checkpoints live. The default writes the scrape job ledger; a proof injects an in-memory one. */
interface CheckpointStore {
  /** The checkpoint for this key; `undefined` = none yet; null = unreadable (the caller then fetches nothing). */
  load(key: string): Promise<{ id: string | null; state: CheckpointState } | undefined | null>
  save(rowId: string | null, state: CheckpointState, scope: CheckpointScope): Promise<{ ok: boolean; id: string | null; error: string | null }>
}

// ─── the ONLY purposes the page transport serves (wave 153, lane 153N — owner ruling B3, verbatim: "zenrows and zyte should
// only search for possible online chatter around needing real estate services or for sale by owner properties") ──────────
//
// Every checkpointed fetch DECLARES its purpose; anything else is refused by name before the checkpoint is read, so a refused
// purpose costs no request and writes no row. A listing's status, a property's record, an owner's contact point, a sold price
// — facts a configured data provider supplies — are never a scrape purpose: the planner prefers the provider
// (lib/lead-pipeline/source-discovery-planner.ts providerFirstVerdict).
export const SCRAPE_PURPOSES = ["real_estate_need_chatter", "fsbo_listing"] as const
export type ScrapePurpose = (typeof SCRAPE_PURPOSES)[number]

/** PURE — why a declared purpose may NOT ride the page transport (null = it may). */
export function scrapePurposeProblem(purpose: unknown): string | null {
  if ((SCRAPE_PURPOSES as readonly unknown[]).includes(purpose)) return null
  return `scrape purpose "${String(purpose)}" refused — Zyte / ZenRows serve only ${SCRAPE_PURPOSES.join(" and ")} (owner ruling B3); a fact a data provider holds is bought from the provider, not scraped`
}

/** `lane` names the caller's source lane (zillow_fsbo_search, realty_chatter, nextdoor_chatter …) for the ledger row. */
interface CheckpointScope { brokerageId: string | null; marketId: string | null; purpose: ScrapePurpose; lane?: string | null }

function parseState(meta: Record<string, any> | null | undefined, key: string): CheckpointState | null {
  const c = meta?.checkpoint
  if (!c || typeof c !== "object" || c.key !== key) return null
  return {
    ...emptyState(key, String(c.targetUrl ?? ""), String(c.host ?? "")),
    observedAt: c.observedAt ?? null, observedDigest: c.observedDigest ?? null, processedAt: c.processedAt ?? null, processedDigest: c.processedDigest ?? null,
    maxSourceEventAt: c.maxSourceEventAt ?? null, seen: Array.isArray(c.seen) ? c.seen.filter((x: any) => x && typeof x.d === "string" && typeof x.at === "string") : [],
    validators: { etag: c.validators?.etag ?? null, lastModified: c.validators?.lastModified ?? null },
    attempts: Number(c.attempts ?? 0) || 0, retryAfter: c.retryAfter ?? null, lastError: c.lastError ?? null, lastProvider: c.lastProvider ?? null,
    robots: c.robots && typeof c.robots.allowed === "boolean" ? c.robots : null,
    fetches: Number(c.fetches ?? 0) || 0, unchangedFetches: Number(c.unchangedFetches ?? 0) || 0, spendUsd: Number(c.spendUsd ?? 0) || 0,
  }
}

/** The default store — the scrape JOB ledger. Every refusal is READ and every update COUNTED (CLAUDE.md §3). */
function jobLedgerCheckpointStore(client: { from: (t: string) => any }): CheckpointStore {
  return {
    async load(key) {
      const { data, error } = await client.from("lead_scraping_jobs").select("id, metadata").eq("job_type", CHECKPOINT_JOB_TYPE).eq("metadata->>checkpoint_key", key).limit(2)
      if (error) { console.error(`[scrape-checkpoint] checkpoint ${key} could not be read: ${error.message}`); return null }
      const rows = (data ?? []) as Array<{ id: string; metadata: Record<string, any> | null }>
      if (rows.length === 0) return undefined
      const state = parseState(rows[0].metadata, key)
      if (!state) { console.error(`[scrape-checkpoint] checkpoint ${key} row ${rows[0].id} is unreadable — no paid fetch until it is repaired`); return null }
      return { id: rows[0].id, state }
    },
    async save(rowId, state, scope) {
      const row = {
        job_type: CHECKPOINT_JOB_TYPE, source: `checkpoint:${state.host}`, status: state.retryAfter ? "failed" : "running",
        brokerage_id: scope.brokerageId, market_id: scope.marketId, leads_found: state.seen.length, leads_created: 0,
        error_message: state.lastError, metadata: { checkpoint_key: state.key, purpose: scope.purpose, lane: scope.lane ?? null, checkpoint: state },
      }
      if (!rowId) {
        const { data, error } = await client.from("lead_scraping_jobs").insert({ ...row, started_at: new Date().toISOString() }).select("id")
        if (error) return { ok: false, id: null, error: error.message }
        const id = Array.isArray(data) && data[0] ? String((data[0] as { id: unknown }).id) : null
        return { ok: !!id, id, error: id ? null : "checkpoint insert returned no row" }
      }
      const { data, error } = await client.from("lead_scraping_jobs").update(row).eq("id", rowId).eq("job_type", CHECKPOINT_JOB_TYPE).select("id")
      if (error) return { ok: false, id: rowId, error: error.message }
      if (!Array.isArray(data) || data.length !== 1) return { ok: false, id: rowId, error: `checkpoint row ${rowId} matched ${Array.isArray(data) ? data.length : 0} rows` }
      return { ok: true, id: rowId, error: null }
    },
  }
}

// ─── the fetcher seam + robots ────────────────────────────────────────────────────────────────────────────────────────

interface SnapshotFetchResult {
  ok: boolean
  html: string
  provider: ScrapeProvider | null
  cost: number
  costBasis: "final" | "estimated" | "none"
  /** The TARGET's status where the transport reports it (Zyte statusCode; ZenRows original_status). */
  statusCode: number | null
  /** The transport's own HTTP status on a refusal (429 / 520 / 401 …) — what the retry rule reads. */
  vendorStatus: number | null
  /** The target's response headers, lowercased (validators only are read). */
  headers: Record<string, string> | null
  notModified: boolean
  error: string | null
}

type SnapshotFetcher = (url: string, opts: { jsRender: boolean; premiumProxy: boolean; requestHeaders: Record<string, string> | null; withHeaders: true }) => Promise<SnapshotFetchResult>
type RobotsReader = (origin: string) => Promise<{ status: number | null; text: string | null }>

const defaultFetcher: SnapshotFetcher = async (url, opts) => (await import("@/lib/external/zenrows-client")).scrapeSiteWithBestProvider(url, opts)

/** RFC 9309 — robots.txt for an origin, fetched directly (free; never through a paid transport). */
const defaultRobotsReader: RobotsReader = async (origin) => {
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": `${ROBOTS_USER_AGENT_TOKEN}/1.0 (honours robots.txt)` }, redirect: "follow", signal: AbortSignal.timeout(8000) })
    return { status: res.status, text: res.ok ? await res.text() : null }
  } catch { return { status: null, text: null } }
}

/** PURE — RFC 9309 §2.3.1: 2xx → parse; 4xx → no robots file (allowed); 5xx / unreachable → complete disallow. */
function robotsVerdict(r: { status: number | null; text: string | null }, path: string): { allowed: boolean; basis: string } {
  if (r.status === null) return { allowed: false, basis: "robots.txt unreachable — RFC 9309 treats the site as fully disallowed this tick" }
  if (r.status >= 500) return { allowed: false, basis: `robots.txt answered ${r.status} — RFC 9309 treats the site as fully disallowed this tick` }
  if (r.status >= 400) return { allowed: true, basis: `robots.txt answered ${r.status} (no robots file) — RFC 9309 allows` }
  const ok = isRobotsAllowed(r.text, path, ROBOTS_USER_AGENT_TOKEN) && isRobotsAllowed(r.text, path, "*")
  return { allowed: ok, basis: ok ? "robots.txt allows this path" : `robots.txt disallows ${path}` }
}

/** PURE — the retry rule after a failed fetch: the vendor's own retry / hold statuses; a network error or timeout retries. */
function failureDisposition(provider: ScrapeProvider | null, vendorStatus: number | null): "retry" | "hold" {
  if (vendorStatus === null || !provider) return "retry"
  const f = SNAPSHOT_TRANSPORT_FACTS[provider]
  if (f.holdStatuses.includes(vendorStatus)) return "hold"
  return "retry"
}

/** PURE — exponential backoff (2^attempts hours, ≤ 24 h); a HOLD (auth, invalid, domain forbidden) waits a full day. */
function backoffUntil(attempts: number, disposition: "retry" | "hold", nowMs: number): string {
  const hours = disposition === "hold" ? 24 : Math.min(24, 2 ** Math.max(0, attempts - 1))
  return new Date(nowMs + hours * HOUR_MS).toISOString()
}

/** PURE — the conditional headers this fetch may carry: the source sent a validator AND the transport documents request
 *  headers in this mode (a JS-rendered page goes through a browser request — Zyte forwards Referer alone there). */
function conditionalHeaders(state: CheckpointState, jsRender: boolean, configured: readonly ScrapeProvider[]): Record<string, string> | null {
  if (!state.validators.etag && !state.validators.lastModified) return null
  const permitted = configured.length > 0 && configured.every((p) => (jsRender ? SNAPSHOT_TRANSPORT_FACTS[p].conditionalRequests.browserMode : SNAPSHOT_TRANSPORT_FACTS[p].conditionalRequests.httpMode))
  if (!permitted) return null
  const h: Record<string, string> = {}
  if (state.validators.etag) h["If-None-Match"] = state.validators.etag
  if (state.validators.lastModified) h["If-Modified-Since"] = state.validators.lastModified
  return h
}

// ─── the call ────────────────────────────────────────────────────────────────────────────────────────────────────────

type SnapshotStatus =
  | "fetched_changed" | "unchanged" | "not_modified"
  | "skipped_interval" | "held_backoff" | "held_tick_budget" | "held_spend" | "held_robots" | "held_terms"
  | "refused_checkpoint_unreadable" | "refused_target" | "refused_purpose" | "failed" | "no_provider"

interface CheckpointedSnapshot {
  status: SnapshotStatus
  /** The HTML of every CHANGED page fetched this call (empty unless status is fetched_changed). */
  html: string[]
  pages: number
  provider: ScrapeProvider | null
  /** The vendor spend of this call's requests (booked once by the caller, as requests — never spread over replays). */
  costUsd: number
  costBasis: "final" | "estimated" | "none"
  watermarks: { observedAt: string | null; processedAt: string | null; processedBehindObserved: boolean; maxSourceEventAt: string | null }
  reason: string
  notes: string[]
  /** PURE over the checkpoint — which parsed records are NEW (not committed inside the rescan window). */
  selectNew(records: readonly NormalizedScrapedRecord[]): { records: NormalizedScrapedRecord[]; skippedSeen: number; skippedOutsideWindow: number }
  /** After the caller's ingest: ok = the processed watermark moves to this snapshot and the forwarded records are remembered. */
  commit(outcome: { ok: boolean; forwarded?: readonly NormalizedScrapedRecord[] }): Promise<{ persisted: boolean; error: string | null }>
}

interface SnapshotCheckpointDeps {
  /** The ledger client the DEFAULT store writes through (the cron's service client; a proof's in-memory client). */
  ledgerClient?: { from: (t: string) => any }
  store?: CheckpointStore
  fetcher?: SnapshotFetcher
  robots?: RobotsReader
  /** The caller's spend policy BEFORE a paid request (budget / caps). Absent = refused: no spend without a policy. */
  spendGate?: (estimatedUsd: number) => { allowed: boolean; reason: string }
  /** A shared per-tick fetch budget (backpressure across targets); decremented by every paid request. */
  tickBudget?: { fetchesLeft: number }
  /** Which transports hold a key (the picker's configured set) — decides whether a conditional request is permitted. */
  configuredProviders?: readonly ScrapeProvider[]
  agreements?: Readonly<Record<string, { reference: string; recordedAt: string; scope: string }>>
  now?: () => Date
}

interface SnapshotCheckpointInput {
  url: string
  scope: CheckpointScope
  jsRender?: boolean
  premiumProxy?: boolean
  /** Upper bound of a request's cost for the spend gate; default = the dearest configured transport in THE ONE price table
   *  (VENDOR_PRICING.zenrows / ZYTE_REQUEST_COST_USD by mode). */
  estimatedUsdPerRequest?: number
  minIntervalMinutes?: number
  rescanWindowDays?: number
  /** Source-published (rel="next") pages to walk from page 1 this tick; stops at the first unchanged page. */
  maxPages?: number
  timeoutMs?: number
}

/** PURE — the spend gate's estimate: the dearest configured transport for this mode, from THE ONE price table. */
function requestEstimateUsd(jsRender: boolean, configured: readonly ScrapeProvider[]): number {
  const per: Record<ScrapeProvider, number> = {
    zenrows: VENDOR_PRICING.zenrows?.costPerUnit ?? 0,
    zyte: jsRender ? ZYTE_REQUEST_COST_USD.browserHtml : ZYTE_REQUEST_COST_USD.httpResponseBody,
  }
  const set = configured.length ? configured : (Object.keys(per) as ScrapeProvider[])
  return Math.max(...set.map((p) => per[p]))
}

const lower = (h: Record<string, string> | null | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase().replace(/^zr-/, "")] = String(v)
  return out
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(onTimeout()) })
  })
}

/**
 * Fetch a target through the configured page transport behind its checkpoint. Never throws. Order: target → checkpoint
 * (fail closed) → interval / backoff → terms → robots → tick budget → spend gate → fetch (conditional only where permitted)
 * → digest vs the PROCESSED watermark → source-published next pages → persist the OBSERVED watermark. The caller parses
 * `html`, forwards `selectNew(records)` to THE ONE RawData producer and then `commit`s.
 */
export async function fetchCheckpointedSnapshot(input: SnapshotCheckpointInput, deps: SnapshotCheckpointDeps = {}): Promise<CheckpointedSnapshot> {
  const now = deps.now ?? (() => new Date())
  const nowMs = now().getTime()
  const notes: string[] = []
  const target = normalizeTarget(input.url)
  const rescanMs = (input.rescanWindowDays ?? DEFAULTS.rescanWindowDays) * DAY_MS
  // Presence of a key NAME only — never a value (the picker's own configured-key contract).
  const configured: readonly ScrapeProvider[] = deps.configuredProviders ?? (["zenrows", "zyte"] as const).filter((p) => !!process.env[p === "zenrows" ? "ZENROWS_API_KEY" : "ZYTE_API_KEY"])

  let state: CheckpointState | null = null
  let rowId: string | null = null
  const store: CheckpointStore | null = deps.store ?? (deps.ledgerClient ? jobLedgerCheckpointStore(deps.ledgerClient) : null)
  let html: string[] = []
  let costUsd = 0
  let costBasis: CheckpointedSnapshot["costBasis"] = "none"
  let provider: ScrapeProvider | null = null
  let pages = 0

  const persist = async (): Promise<{ persisted: boolean; error: string | null }> => {
    if (!store || !state) return { persisted: false, error: "no checkpoint store" }
    const r = await store.save(rowId, state, input.scope).catch((e) => ({ ok: false, id: rowId, error: e instanceof Error ? e.message : String(e) }))
    if (r.ok) rowId = r.id
    return { persisted: r.ok, error: r.error }
  }

  const result = (status: SnapshotStatus, reason: string): CheckpointedSnapshot => {
    const s = state
    return {
      status, html: status === "fetched_changed" ? html : [], pages, provider, costUsd: Math.round(costUsd * 1e6) / 1e6, costBasis, reason, notes,
      watermarks: { observedAt: s?.observedAt ?? null, processedAt: s?.processedAt ?? null, processedBehindObserved: !!s && s.observedDigest !== s.processedDigest, maxSourceEventAt: s?.maxSourceEventAt ?? null },
      selectNew(records) {
        if (!s) return { records: [], skippedSeen: 0, skippedOutsideWindow: 0 }
        const seen = new Set(s.seen.map((x) => x.d))
        const floor = s.maxSourceEventAt ? Date.parse(s.maxSourceEventAt) - rescanMs : null
        const out: NormalizedScrapedRecord[] = []
        let skippedSeen = 0, skippedOutsideWindow = 0
        const batch = new Set<string>()
        for (const r of records) {
          const d = recordDigest(r)
          if (seen.has(d) || batch.has(d)) { skippedSeen++; continue }
          const at = recordEventAt(r, nowMs)
          if (floor !== null && at && Date.parse(at) < floor) { skippedOutsideWindow++; continue }
          batch.add(d)
          out.push(r)
        }
        return { records: out, skippedSeen, skippedOutsideWindow }
      },
      async commit(outcome) {
        if (!s) return { persisted: false, error: "no checkpoint" }
        if (!outcome.ok) {
          // The ingest failed: the processed watermark STAYS, so the next tick re-processes this snapshot (a replay is one
          // observation at the RawData door); nothing is remembered as seen.
          s.lastError = "ingest did not complete — the snapshot will be re-processed"
          return persist()
        }
        const at = now().toISOString()
        s.processedDigest = s.observedDigest
        s.processedAt = at
        for (const r of outcome.forwarded ?? []) {
          const ev = recordEventAt(r, nowMs)
          s.seen.push({ d: recordDigest(r), at: ev ?? at })
          if (ev && (!s.maxSourceEventAt || Date.parse(ev) > Date.parse(s.maxSourceEventAt))) s.maxSourceEventAt = ev
        }
        const floorMs = (s.maxSourceEventAt ? Date.parse(s.maxSourceEventAt) : nowMs) - rescanMs
        s.seen = s.seen.filter((x) => Date.parse(x.at) >= floorMs).slice(-DEFAULTS.maxSeen)
        s.lastError = null
        return persist()
      },
    }
  }

  // THE SCOPE RULE FIRST (owner ruling B3): a purpose outside chatter / FSBO is refused by name — no checkpoint read, no request.
  const purposeProblem = scrapePurposeProblem(input.scope?.purpose)
  if (purposeProblem) return result("refused_purpose", purposeProblem)
  if (!target) return result("refused_target", `not a fetchable http(s) URL: ${input.url}`)
  const key = `snap:${input.scope.brokerageId ?? "platform"}:${input.scope.marketId ?? "-"}:${stableContentDigest(target.url)}`
  if (!store) return result("refused_checkpoint_unreadable", "no checkpoint store — a page fetch without a checkpoint could re-buy the same page every tick")
  const loaded = await store.load(key).catch(() => null)
  if (loaded === null) return result("refused_checkpoint_unreadable", "the checkpoint could not be read, so no paid fetch was made (it may hold a backoff or an unprocessed snapshot)")
  if (loaded) { state = loaded.state; rowId = loaded.id } else state = emptyState(key, target.url, target.host)
  const st = state

  // Backpressure: the minimum re-fetch interval and the vendor's backoff.
  if (st.retryAfter && Date.parse(st.retryAfter) > nowMs) return result("held_backoff", `backing off until ${st.retryAfter} after: ${st.lastError ?? "an earlier failure"}`)
  const minMs = (input.minIntervalMinutes ?? DEFAULTS.minIntervalMinutes) * 60_000
  if (st.observedAt && nowMs - Date.parse(st.observedAt) < minMs && st.observedDigest === st.processedDigest) {
    return result("skipped_interval", `fetched at ${st.observedAt} — within the ${input.minIntervalMinutes ?? DEFAULTS.minIntervalMinutes}-minute re-fetch interval`)
  }

  // Contract terms (pure — a held host costs no request at all), then robots.txt (cached ≤ 24 h). Both must allow before any
  // paid request.
  const terms = scrapeTargetTermsVerdict(target.host, target.url, deps.agreements)
  if (!terms.allowed) { await persist(); return result("held_terms", terms.note) }
  if (!st.robots || nowMs - Date.parse(st.robots.checkedAt) > ROBOTS_CACHE_MS) {
    const r = await (deps.robots ?? defaultRobotsReader)(target.origin).catch(() => ({ status: null, text: null }))
    const v = robotsVerdict(r, target.path)
    st.robots = { allowed: v.allowed, checkedAt: now().toISOString(), basis: v.basis }
  }
  if (!st.robots.allowed) { await persist(); return result("held_robots", st.robots.basis) }

  const maxPages = Math.max(1, Math.min(10, input.maxPages ?? DEFAULTS.maxPages))
  let pageUrl: string | null = target.url
  let changed = false
  let anyNotModified = false
  while (pageUrl && pages < maxPages) {
    if (deps.tickBudget && deps.tickBudget.fetchesLeft <= 0) {
      if (pages === 0) { await persist(); return result("held_tick_budget", "this tick's fetch budget is spent — the target waits for the next tick") }
      notes.push("page walk stopped: this tick's fetch budget is spent"); break
    }
    const estimate = input.estimatedUsdPerRequest ?? requestEstimateUsd(!!input.jsRender, configured)
    const spend = deps.spendGate ? deps.spendGate(estimate) : { allowed: false, reason: "no spend policy supplied — a paid fetch needs one" }
    if (!spend.allowed) {
      if (pages === 0) { await persist(); return result("held_spend", spend.reason) }
      notes.push(`page walk stopped: ${spend.reason}`); break
    }
    if (deps.tickBudget) deps.tickBudget.fetchesLeft -= 1
    const isFirst = pages === 0
    const requestHeaders = isFirst ? conditionalHeaders(st, !!input.jsRender, configured) : null
    if (requestHeaders) notes.push(`conditional request sent (${Object.keys(requestHeaders).join(", ")}) — the source published a validator and the transport documents request headers in this mode`)
    const timeoutMs = input.timeoutMs ?? DEFAULTS.timeoutMs
    const res = await withTimeout<SnapshotFetchResult>(
      (deps.fetcher ?? defaultFetcher)(pageUrl, { jsRender: !!input.jsRender, premiumProxy: !!input.premiumProxy, requestHeaders, withHeaders: true }),
      timeoutMs,
      () => ({ ok: false, html: "", provider: null, cost: 0, costBasis: "none", statusCode: null, vendorStatus: null, headers: null, notModified: false, error: `timed out after ${timeoutMs} ms (the request may still complete and bill at the vendor)` }),
    )
    pages++
    costUsd += res.cost ?? 0
    if (res.costBasis === "final" || (res.costBasis === "estimated" && costBasis !== "final")) costBasis = res.costBasis
    if (res.provider) provider = res.provider
    if (!res.ok && !res.notModified) {
      if (!res.provider && /no scrape provider configured/i.test(res.error ?? "")) {
        if (isFirst) { await persist(); return result("no_provider", res.error ?? "no scrape provider configured") }
        break
      }
      st.attempts += 1
      const disposition = failureDisposition(res.provider, res.vendorStatus)
      st.lastError = `${res.provider ?? "transport"}${res.vendorStatus ? ` ${res.vendorStatus}` : ""}: ${res.error ?? "fetch failed"}`
      st.retryAfter = backoffUntil(st.attempts, disposition, nowMs)
      st.lastProvider = res.provider
      st.spendUsd += res.cost ?? 0
      const saved = await persist()
      if (!saved.persisted) notes.push(`checkpoint not persisted: ${saved.error}`)
      // A target that a retry cannot fix (the vendor's hold statuses — a bad key, an unpaid plan, a refused URL) or that has
      // exhausted its attempts is ESCALATED to the connector-healing console's ledger (self_heal_events, domain connector) —
      // never a silent stop that only the cron's return value knew about. A hold backs off 24 h, so this is at most daily.
      if ((disposition === "hold" || st.attempts >= DEFAULTS.maxAttempts) && deps.ledgerClient) {
        const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
        await recordSelfHeal(deps.ledgerClient, {
          brokerageId: input.scope.brokerageId, domain: "connector", subject: `scrape:${res.provider ?? "transport"}:${target?.host ?? "unknown"}`,
          action: disposition === "hold" ? "scrape_target_held" : "scrape_target_attempts_exhausted", outcome: "escalated",
          detail: { vendorStatus: res.vendorStatus ?? null, attempts: st.attempts, retryAfter: st.retryAfter, error: st.lastError, purpose: input.scope.purpose },
        })
      }
      if (isFirst) return result("failed", `${st.lastError} — ${disposition === "hold" ? "held (a retry cannot fix this)" : `retry after ${st.retryAfter}`}${st.attempts >= DEFAULTS.maxAttempts ? ` (${st.attempts} attempts)` : ""}`)
      notes.push(`page ${pages} failed: ${st.lastError}`)
      break
    }
    st.attempts = 0
    st.retryAfter = null
    st.lastProvider = res.provider
    st.fetches += 1
    st.spendUsd += res.cost ?? 0
    if (isFirst) {
      const h = lower(res.headers)
      if (h.etag || h["last-modified"]) st.validators = { etag: h.etag ?? null, lastModified: h["last-modified"] ?? null }
    }
    if (res.notModified) {
      // The SOURCE said 304 to our validator: the processed snapshot still stands (observed moves; nothing to forward).
      anyNotModified = true
      st.observedAt = now().toISOString()
      st.unchangedFetches += 1
      break
    }
    const digest = snapshotDigest(res.html)
    if (isFirst) {
      st.observedAt = now().toISOString()
      const unchanged = digest === st.processedDigest
      st.observedDigest = digest
      if (unchanged) { st.unchangedFetches += 1; break }
    } else if (html.length && digest === snapshotDigest(html[html.length - 1])) {
      break
    }
    changed = true
    html.push(res.html)
    pageUrl = sourceNextLink(res.html, pageUrl)
    if (pageUrl && pages >= maxPages) notes.push(`the source publishes more pages (rel=next) — the ${maxPages}-page cap stops here; the next tick starts again from page 1`)
  }

  const saved = await persist()
  if (!saved.persisted) notes.push(`checkpoint not persisted (${saved.error}) — the next tick may re-fetch; a re-read is one observation at the RawData door`)
  if (anyNotModified) return result("not_modified", "the source answered 304 Not Modified to the stored validator — nothing new to process")
  if (!changed) return result("unchanged", "the page's content digest equals the processed snapshot — zero records forwarded, no paid record booked")
  return result("fetched_changed", `${html.length} changed page(s) observed; ${st.processedDigest ? "the processed snapshot differs" : "first observation of this target"}`)
}
