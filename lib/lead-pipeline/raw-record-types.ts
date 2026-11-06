/**
 * Canonical shape for every scraped record before it enters the pipeline.
 * Sources: Zillow, Realtor, Craigslist, BatchData, Nextdoor, Facebook, Reddit.
 *
 * isViableRecord  → allowed to exist as a raw_scraped_leads row (WIRED — the
 *                   sourcers and the ingest cron filter on it)
 * hasPromotionEligibleIdentity → MERGED ONTO isViableRecord (orphan doctrine
 *                   §1.1, wave 65A) — see the tombstone where it used to be
 *                   defined, below. It was the SAME PREDICATE, byte for byte;
 *                   the real promotion gate lives in
 *                   lib/lead-pipeline/canonical-lead-eligibility.ts.
 */
export interface NormalizedScrapedRecord {
  /** Stable dedup key unique within the source (not a DB uuid). */
  sourceRecordId: string
  /** e.g. 'zillow', 'realtor', 'craigslist_fsbo', 'batchdata_motivated' */
  source: string
  /** e.g. 'property_view', 'fsbo_listing', 'motivated_seller', 'social_intent' */
  behaviorType: string
  intentType: 'buyer' | 'seller' | 'unknown'
  /** Free-form signals driving the intent classification. */
  intentSignals: string[]

  // Identity fields — at least one combination must be present for viability.
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  username?: string | null
  email?: string | null
  phone?: string | null

  // Geography
  city?: string | null
  state?: string | null
  zip?: string | null

  // Property context
  propertyAddress?: string | null
  mailingAddress?: string | null

  // Scoring
  motivationScore?: number | null
  sourceUrl?: string | null

  /**
   * Lane 89B (owner, 2026-09-29, verbatim: "…enriched by people data lab along with the rest
   * scraped leads unless we already paid for that lead data with the lead"). TRUE only when the
   * VENDOR that sold this record also sold the person's contact points with it (BatchData's
   * `contact` dataset — owner.phoneNumbers / owner.emails — on a Property Search / Smart Search /
   * cash-buyer pull). The raw writer stamps it as normalized_preview.paid_person_data (ONE spelling,
   * lib/kernel/scraping.ts) and pipeline-processor.ts::enrichWithPeopleData skips the PeopleData
   * call for such a row when it carries a phone or an email — the identity is already bought.
   * A scraped reply email on a Craigslist post is NOT paid person data (nobody sold the person);
   * source-intent-map.ts::SOURCE_PAID_PERSON_DATA is the per-source contract this flag must obey.
   */
  paidPersonData?: boolean

  /** Rich intent classification (when the source produced enough text to score). Optional so
   *  every scraper need not populate it; downstream code reads `intent?.winner` defensively. */
  intent?: {
    winner: "buyer" | "seller" | "investor" | "agent" | "generic"
    persona:
      | "first_time_buyer" | "move_up_buyer" | "downsizer"
      | "fsbo_seller" | "motivated_seller" | "expired_listing"
      | "investor_flipper" | "investor_buy_hold" | "investor_1031"
      | "agent_recruit"
      | null
    scores: { buyer: number; seller: number; investor: number; agent: number; generic: number }
    matched: string[]
    /** True when the source page advertises a saved-search / property-alert profile (buyer side). */
    buyerAlertProfile?: boolean
    /** Property addresses + prices the normalizer pulled from text/highlights/summary. */
    propertyAddresses?: string[]
    prices?: number[]
  }

  /** Original payload from the provider — preserved verbatim for audit. */
  rawPayload: Record<string, unknown>

  /**
   * C35 (wave 150, lane 150EFG) — what the INGRESS knows about the observation beyond the record
   * itself. Optional: the ONE producer (lib/kernel/scraping.ts ingestRawSourceBatch) derives every
   * missing part through buildRawDataEnvelope below; a caller only states what it knows better
   * (a vendor's own event id, a subject it has classified, the proof URLs it read).
   */
  envelope?: RawDataEnvelopeHints
}

// ── C35 — THE ONE RAWDATA PRODUCER CONTRACT (wave 150, lane 150EFG) ─────────────────────────
//
// Owner directive (wave 150): "All ingress routes — including SDK, MCP, scraping actor, CSV, API,
// webhook, vendor event and manager action — use a single producer contract with event idempotency,
// source rights, license, timestamps, TTL, external IDs, proof URLs, actor/version, cost and
// event/decision evidence. A source-produced property does not magically prove an owner's identity."
//
// SURVIVOR (LAW 1): the producer already existed — ingestRawSourceBatch is the only raw_scraped_leads
// writer in app/ lib/ workflows/ (the deal-room demo seed aside). What it lacked was the contract: no
// subject kind (a market article and a person rode the same row shape), no idempotency key (the only
// UNIQUE was the GLOBAL (source, source_record_id) — and ten sourcers minted that id from
// Date.now()+Math.random() when the item had no id, so a replay was a new row), no rights/licence,
// no TTL, no proof URLs, no actor/version. This block is the contract; the producer writes it as
// first-class columns (m961) and verbatim at normalized_preview.rawdata.

/** One vocabulary — raw_scraped_leads.subject_kind CHECK (m961) holds the same words. */
export const RAWDATA_SUBJECT_KINDS = [
  "person", "owner", "property", "entity_trust_estate", "household", "business",
  "market", "anonymous_question", "job_civic_event", "listing", "signal",
] as const
export type RawDataSubjectKind = (typeof RAWDATA_SUBJECT_KINDS)[number]

/** One vocabulary — raw_scraped_leads.producer_actor_type CHECK (m961). */
const RAWDATA_ACTOR_TYPES = ["cron", "webhook", "csv_import", "actor", "sdk_mcp", "manual", "research", "vendor_event", "manager_action"] as const
export type RawDataActorType = (typeof RAWDATA_ACTOR_TYPES)[number]

/** The producer contract version written on every row (raw_scraped_leads.producer_version). */
const RAWDATA_PRODUCER_VERSION = "rawdata-c35@1"

/**
 * How long an observation of each subject kind stays an ANSWER before it must be re-observed
 * (raw_scraped_leads.ttl_expires_at). OPERATIONAL windows, not legal ones: a post or a question goes
 * stale fast; a property / ownership fact moves slowly. Never an outreach schedule.
 */
const RAWDATA_TTL_DAYS: Readonly<Record<RawDataSubjectKind, number>> = Object.freeze({
  person: 365, owner: 365, household: 365, business: 365, entity_trust_estate: 365, property: 365,
  listing: 120, job_civic_event: 180, signal: 90, anonymous_question: 90, market: 30,
})

/** What an ingress may state about an observation (everything else is derived). */
interface RawDataEnvelopeHints {
  subjectKind?: RawDataSubjectKind
  /** The vendor's / webhook's OWN event id — the strongest idempotency anchor there is. */
  externalEventId?: string | null
  /** Other ids the source gave (apn, radar id, listing id, message id …). */
  externalIds?: Record<string, string>
  /** URLs a human can open to see what the observation rests on. */
  proofUrls?: string[]
  ttlDays?: number
  /** Why the ingress believes this observation (decision / event evidence), stored verbatim. */
  evidence?: Record<string, unknown>
}

export interface RawDataEnvelope {
  subject_kind: RawDataSubjectKind
  idempotency_key: string
  /** Which part of the record anchored the key — published so a weak (digest) key is visible. */
  idempotency_basis: "external_event_id" | "source_record_id" | "content_digest"
  source_rights: string
  source_licence: string | null
  signal_at: string | null
  observed_at: string
  ttl_expires_at: string
  external_ids: Record<string, string>
  proof_urls: string[]
  producer_actor_type: RawDataActorType
  producer_actor_id: string | null
  producer_version: string
  cost_usd: number | null
  evidence: Record<string, unknown>
}

/** A source_record_id minted from a clock or a random number cannot anchor a replay (CLAUDE.md §2 —
 *  this is the defect the key exists to close, so the producer refuses to trust such an id). */
function isVolatileSourceRecordId(id: string | null | undefined): boolean {
  if (!id || !id.trim()) return true
  return /\d{13}|0\.\d{6,}/.test(id)
}

/** Payload keys that change between two reads of the SAME observation (never part of a digest). */
const VOLATILE_PAYLOAD_KEY = /^(scraped|fetched|retrieved|crawled|ingested|received|run|request)_?(at|on|time|id)$|^(runId|requestId|actorRunId|traceId|_ts)$/i

function canonicalJson(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return "null"
  if (depth > 6) return '"…"'
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, depth + 1)).join(",")}]`
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).filter((k) => !VOLATILE_PAYLOAD_KEY.test(k)).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`
  }
  return JSON.stringify(v)
}

/** PURE — a stable 64-bit FNV-1a digest (hex) of any JSON-like value; identical content → identical
 *  digest across processes (no crypto import, so client-safe proofs can call it). */
export function stableContentDigest(value: unknown): string {
  const s = canonicalJson(value)
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}

/**
 * PURE — the idempotency key of one observation, SCOPED to its owner: `t:<brokerage>|…` for a tenant
 * scrape, `p|…` for the platform pool. Scoping is the "same property may be lawfully researched per
 * tenant without sharing person details" rule: two tenants observing one property hold two rows, and
 * neither row is the other's. Anchor order: the source's own event id → a stable source_record_id →
 * a content digest of the identity + payload (never a clock).
 */
function rawDataIdempotencyKey(
  r: Pick<NormalizedScrapedRecord, "source" | "sourceRecordId" | "email" | "phone" | "username" | "firstName" | "lastName" | "fullName" | "propertyAddress" | "sourceUrl" | "rawPayload" | "envelope">,
  brokerageId: string | null,
): { key: string; basis: RawDataEnvelope["idempotency_basis"] } {
  const scope = brokerageId ? `t:${brokerageId}` : "p"
  const src = (r.source ?? "").trim().toLowerCase()
  const evt = r.envelope?.externalEventId?.trim()
  if (evt) return { key: `${scope}|${src}|evt:${evt}`, basis: "external_event_id" }
  if (!isVolatileSourceRecordId(r.sourceRecordId)) return { key: `${scope}|${src}|rec:${r.sourceRecordId.trim()}`, basis: "source_record_id" }
  const digest = stableContentDigest({
    email: r.email?.trim().toLowerCase() ?? null, phone: r.phone?.replace(/\D/g, "").slice(-10) ?? null,
    username: r.username ?? null, first: r.firstName ?? null, last: r.lastName ?? null, full: r.fullName ?? null,
    address: r.propertyAddress?.trim().toLowerCase() ?? null, url: r.sourceUrl ?? null, payload: r.rawPayload ?? null,
  })
  return { key: `${scope}|${src}|dig:${digest}`, basis: "content_digest" }
}

/**
 * PURE — the subject an observation is ABOUT. A caller's stated kind wins; otherwise derived
 * conservatively: an entity name (LLC / trust / estate / business) is never a person; a name or a
 * contact point is a person (an OWNER when a licensed vendor tied it to a property); an address alone
 * is a PROPERTY (which proves nobody's identity); anything else is a SIGNAL.
 */
function inferRawSubjectKind(
  r: Pick<NormalizedScrapedRecord, "firstName" | "lastName" | "fullName" | "email" | "phone" | "username" | "propertyAddress" | "envelope">,
  rights: string,
  entityKindOf: (name: string) => "person" | "household" | "business" | "entity_trust_estate" | null,
): RawDataSubjectKind {
  const stated = r.envelope?.subjectKind
  if (stated && (RAWDATA_SUBJECT_KINDS as readonly string[]).includes(stated)) return stated
  const name = (r.fullName ?? [r.firstName, r.lastName].filter(Boolean).join(" ")).trim()
  const nameKind = name ? entityKindOf(name) : null
  if (nameKind === "business" || nameKind === "entity_trust_estate" || nameKind === "household") return nameKind
  if (name || r.email || r.phone || r.username) {
    return r.propertyAddress && rights === "licensed_vendor" ? "owner" : "person"
  }
  if (r.propertyAddress) return "property"
  return "signal"
}

/** The subjects that may EVER walk toward the one Lead door. A property, a market, a question, a civic
 *  event, a listing, a business or an LLC / trust / estate is evidence — it becomes a Lead only once a
 *  real person behind it is found and re-observed as a person (canary 4). */
export const LEAD_CAPABLE_SUBJECT_KINDS: ReadonlySet<RawDataSubjectKind> = new Set(["person", "owner", "household"])

/**
 * PURE — the full envelope for one record, as the producer writes it. `signalAt` is the payload's own
 * date (recordSignalDate); `observedAt` is the producer's clock; TTL runs from the later-known of the two.
 */
export function buildRawDataEnvelope(
  r: NormalizedScrapedRecord,
  ctx: {
    brokerageId: string | null
    rights: { rights: string; licence: string | null }
    entityKindOf: (name: string) => "person" | "household" | "business" | "entity_trust_estate" | null
    actorType: RawDataActorType
    actorId?: string | null
    costUsd: number | null
    nowMs?: number
  },
): RawDataEnvelope {
  const nowMs = ctx.nowMs ?? Date.now()
  const subject = inferRawSubjectKind(r, ctx.rights.rights, ctx.entityKindOf)
  const { key, basis } = rawDataIdempotencyKey(r, ctx.brokerageId)
  const signalAt = recordSignalDate(r, nowMs)
  const ttlDays = r.envelope?.ttlDays && r.envelope.ttlDays > 0 ? r.envelope.ttlDays : RAWDATA_TTL_DAYS[subject]
  const anchorMs = signalAt ? Date.parse(signalAt) : nowMs
  const proof = new Set<string>([...(r.envelope?.proofUrls ?? []), ...(r.sourceUrl ? [r.sourceUrl] : [])].filter((u) => /^https?:\/\//i.test(u)))
  const externalIds: Record<string, string> = { ...(r.envelope?.externalIds ?? {}) }
  if (!isVolatileSourceRecordId(r.sourceRecordId)) externalIds.source_record_id ??= r.sourceRecordId
  if (r.envelope?.externalEventId) externalIds.event_id ??= r.envelope.externalEventId
  return {
    subject_kind: subject,
    idempotency_key: key,
    idempotency_basis: basis,
    source_rights: ctx.rights.rights,
    source_licence: ctx.rights.licence,
    signal_at: signalAt,
    observed_at: new Date(nowMs).toISOString(),
    ttl_expires_at: new Date(anchorMs + ttlDays * 86_400_000).toISOString(),
    external_ids: externalIds,
    proof_urls: [...proof],
    producer_actor_type: ctx.actorType,
    producer_actor_id: ctx.actorId ?? null,
    producer_version: RAWDATA_PRODUCER_VERSION,
    cost_usd: ctx.costUsd,
    evidence: { ...(r.envelope?.evidence ?? {}), behavior_type: r.behaviorType, intent_signals: r.intentSignals ?? [] },
  }
}

/** PURE — why the producer must NOT write this envelope (null = write it). Unknown rights is refused:
 *  "Restricted or invalid → hold, suppress or delete with reason" — and nothing names a basis here. */
export function rawDataEnvelopeProblem(e: RawDataEnvelope): string | null {
  if (!e.idempotency_key) return "no idempotency key"
  if (!(RAWDATA_SUBJECT_KINDS as readonly string[]).includes(e.subject_kind)) return `unknown subject kind "${e.subject_kind}"`
  if (e.source_rights === "unknown" || !e.source_rights) return "no source rights — nothing names the basis this observation was obtained under"
  if (e.source_rights === "first_party_consented") return "a consented first-party submission is a Contact (C8 captureContact), never a raw row"
  return null
}

/**
 * Gate 1 — record is allowed to exist as a raw_scraped_leads row.
 * Requires at minimum one identity signal or a property address.
 */
export function isViableRecord(r: NormalizedScrapedRecord): boolean {
  return !!(
    r.email ||
    r.phone ||
    r.username ||
    (r.fullName && (r.city || r.state)) ||
    (r.firstName && r.lastName && (r.city || r.state)) ||
    r.propertyAddress
  )
}

// ── Gate 1b — RECENCY (wave 91, lane 91B) ────────────────────────────────────
//
// Owner, verbatim (2026-09-30): "we should only pull more recent data". A request-side window
// exists only where the provider publishes one (Exa `startPublishedDate`, BatchData recorder-date
// windows via lookback_days); Apify actors, ZenRows/Zyte page scrapes, Tavily and OSINT hand back
// whatever the page or actor returns, however old. This is the CLIENT-SIDE half: the date the
// signal was made (a post's publish time, a listing's date) is read off the provider's own payload
// and a record older than its source's window is dropped at the raw writer — BEFORE the row
// exists, so it can never reach PeopleData (the cost-bearing enrichment, processRawRecord).
//
// An UNDATED record is KEPT (nothing proves it stale — a payload with no date key, a relative
// "3 days ago", an unparseable string or a future date all read as undated). That is the
// published blind spot: the gate can only drop what a payload dates.

/** Payload keys that carry the signal's own date, across the providers the raw writer receives
 *  (Apify post/listing actors, Exa, review/nextdoor extraction, Craigslist, Marketplace). The
 *  first parseable one wins; a `post` / `item` / `extraction` child is read one level deep. */
const RECENCY_DATE_KEYS = [
  "posted_at", "postedAt", "posted", "datePosted", "date_posted",
  "published", "publishedDate", "published_date", "publishedAt",
  "created_at", "createdAt", "created_utc", "created", "creation_time",
  "listingDate", "listedDate", "listed_at", "timestamp", "datetime", "date", "time",
] as const

function parseSignalDate(v: unknown, nowMs: number): number | null {
  let ms: number | null = null
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    ms = v < 1e12 ? v * 1000 : v // epoch seconds (reddit created_utc, marketplace creation_time) or ms
  } else if (typeof v === "string" && v.trim()) {
    const t = v.trim()
    if (/^\d{9,13}$/.test(t)) ms = Number(t) < 1e12 ? Number(t) * 1000 : Number(t)
    else if (/\d{4}/.test(t)) { const p = Date.parse(t); ms = Number.isFinite(p) ? p : null } // needs a year — "3 days ago" / "Monday" stay undated
  }
  if (ms === null) return null
  if (ms > nowMs + 86_400_000) return null // a future date is a parse artefact, not a signal date
  if (ms < Date.UTC(2000, 0, 1)) return null
  return ms
}

/** PURE — the ISO date the record's signal was made, read from its own payload; null when the
 *  payload dates nothing. */
function recordSignalDate(r: Pick<NormalizedScrapedRecord, "rawPayload">, nowMs: number = Date.now()): string | null {
  const layers: Array<Record<string, unknown>> = []
  const root = (r.rawPayload ?? {}) as Record<string, unknown>
  layers.push(root)
  for (const child of ["post", "item", "extraction", "listing"]) {
    const c = root[child]
    if (c && typeof c === "object" && !Array.isArray(c)) layers.push(c as Record<string, unknown>)
  }
  for (const layer of layers) {
    for (const k of RECENCY_DATE_KEYS) {
      const ms = parseSignalDate(layer[k], nowMs)
      if (ms !== null) return new Date(ms).toISOString()
    }
  }
  return null
}

/** PURE — keep the record? false only when it is DATED and older than `days`. No window (null /
 *  0 / undefined) or no date ⇒ kept. */
export function isWithinRecencyWindow(
  r: Pick<NormalizedScrapedRecord, "rawPayload">,
  days: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!days || days <= 0) return true
  const iso = recordSignalDate(r, nowMs)
  if (!iso) return true
  return Date.parse(iso) >= nowMs - days * 86_400_000
}

// ── MERGED ONTO SURVIVOR (orphan doctrine §1.1, wave 65A) ────────────────────
// `hasPromotionEligibleIdentity` used to live here, BYTE-IDENTICAL to
// `isViableRecord` (lib/lead-pipeline/raw-record-types.ts:72) — same six
// clauses, same order. The real, stricter promotion gate it claimed to be was
// (and remains) lib/lead-pipeline/canonical-lead-eligibility.ts — the "SINGLE
// source of truth for the raw record → lead CONVERSION GATE" (first name AND
// last name, plus one of email / phone / VERIFIED mailing address) — which
// both live promotion paths (lib/lead-pipeline/pipeline-processor.ts and
// lib/lead-promotion/eligibility-evaluator.ts) already delegate to. This
// duplicate function added nothing a caller could not get from isViableRecord
// directly, and its own header said so (wave "2026-09-03, lane L2"). Its only
// two callers — scripts/scraper-simulator.ts:32,262,270 and
// scripts/lead-flow-e2e.ts:28,262, both outside the scraping fence for THIS
// lane's edit list — are repointed to isViableRecord (lib/lead-pipeline/raw-
// record-types.ts:72) in this same pass. No capability is lost: isViableRecord
// IS the predicate this function computed, unchanged.

/**
 * Returns a stable string key for deduplication.
 * Priority: email > phone > username+source > name+location.
 * Returns null when no usable identity exists.
 */
export function buildLeadIdentityKey(r: NormalizedScrapedRecord): string | null {
  if (r.email) return `email:${r.email.trim().toLowerCase()}`

  const p = r.phone?.replace(/\D/g, '').slice(-10)
  if (p?.length === 10) return `phone:${p}`

  if (r.username && r.sourceUrl) {
    return `user:${r.username.toLowerCase()}|src:${r.sourceUrl}`
  }

  const name = [r.firstName, r.lastName].filter(Boolean).join(' ').toLowerCase()
  if (name && (r.city || r.state)) {
    return `name:${name}|${r.city?.toLowerCase() ?? ''}|${r.state?.toLowerCase() ?? ''}`
  }

  return null
}
