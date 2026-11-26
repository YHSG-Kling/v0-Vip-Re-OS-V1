// lib/acquisition-plays/property-candidates.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLAY — FSBO / PUBLIC RELOCATION / PROBATE-PERMITTED FILINGS → A PROPERTY-LEVEL CANDIDATE QUEUE
// (wave 151, lane 151D; directive plays 4 / 7 and the hunting examples "FSBO situations", "public
// business relocations", "public probate/property filings where permitted").
//
// Exa hunts owner-published for-sale-by-owner listings, official probate notices and public business
// relocations in the territory, with a schema-shaped extraction. Each becomes a PROPERTY-LEVEL
// observation through THE ONE producer, with its RIGHTS recorded on the row:
//   · a FSBO page → subject `property` (an address, an asking price, whether the owner published a contact
//     point — kept in the payload, never as a person column: a listing proves nobody's identity);
//   · an official probate notice (a .gov / court / statutory-notice page ONLY) → `entity_trust_estate`,
//     sensitivity intimate, targeting prohibited — a property fact for correctly licensed tools, never a
//     "distressed seller" label on a person;
//   · a business relocation → `job_civic_event` evidence (the corridor's cousin; a commercial move).
// An `owner` row exists ONLY when lib/identity/subject-identity.ts verifyOwnership verifies the published
// name against authoritative records (two sources, or one plus a matching mailing address). A name on a
// single public page never joins a person to a property (nameOnlyJoinProblem).
// Pages that show a property ALREADY LISTED WITH A BROKERAGE or RECORDED SOLD are not candidates; they
// are returned as `contradictions` for the negative-evidence play (an old seller theory on that address).

import type { IngestBatchResult, IngestRawSourceBatchParams } from "@/lib/kernel/scraping"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import { extractPropertyAddress } from "@/lib/lead-pipeline/permit-sourcer"
import { verifyOwnership } from "@/lib/identity/subject-identity"
import { groundedEvidence, freshnessProblem, huntTerritory, sourceRightsForUrl, type ExaHuntClient, type ExaHuntResult, type ExaHuntSearch, type GroundedEvidence, type SourceRights } from "@/lib/providers/exa/hunting"
import { EXA_PLAY_CHANNEL, EXA_PLAY_SOURCE, PLAY_ACTOR, emptyResult, evidenceRecord, nameOnlyJoinProblem, type PlayAction, type PlayResult } from "./contract"
import type { PlayMarket } from "./moving-corridor"

const PLAY = "property_candidate_queue" as const
export const FSBO_MAX_AGE_DAYS = 120
export const NOTICE_MAX_AGE_DAYS = 180

/** The owner-published listing sites the FSBO search is confined to (their class permits the published contact point). */
const FSBO_DOMAINS = ["forsalebyowner.com", "fsbo.com", "byowner.com", "fizber.com", "homesbyowner.com", "craigslist.org"]

const PROPERTY_CANDIDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    listing_kind: { type: "string", enum: ["fsbo", "probate_notice", "business_relocation", "agent_listing", "sold_record", "other"] },
    property_address: { type: ["string", "null"], description: "street address exactly as written" },
    city: { type: ["string", "null"] },
    state: { type: ["string", "null"], description: "two-letter state code" },
    zip: { type: ["string", "null"] },
    asking_price: { type: ["number", "null"] },
    owner_published_contact: { type: "boolean", description: "true when the owner published a phone or email for inquiries" },
    owner_name_as_published: { type: ["string", "null"] },
    estate_or_entity_name: { type: ["string", "null"], description: "the estate / trust / LLC named, e.g. 'Estate of Jane Doe'" },
    listing_brokerage: { type: ["string", "null"], description: "the brokerage or agent the property is listed with, when the page says so" },
    notice_or_filing_date: { type: ["string", "null"] },
  },
  required: ["listing_kind"],
}

const where = (m: PlayMarket) => [m.city, m.state].filter(Boolean).join(", ")

/** PURE — the territory's property-candidate searches. */
export function propertyCandidateSearches(market: PlayMarket): ExaHuntSearch[] {
  const w = where(market)
  if (!w) return []
  const county = market.counties?.[0]
  return [
    { key: "property:fsbo", query: `for sale by owner home ${w}`, includeDomains: FSBO_DOMAINS, sinceDays: FSBO_MAX_AGE_DAYS, numResults: 10, schema: PROPERTY_CANDIDATE_SCHEMA },
    { key: "property:probate_notice", query: `notice to creditors estate of decedent ${county ? `${county} County ` : ""}${market.state ?? ""} probate real property`, sinceDays: NOTICE_MAX_AGE_DAYS, numResults: 10, schema: PROPERTY_CANDIDATE_SCHEMA },
    { key: "property:business_relocation", query: `business relocating offices or headquarters to ${w} commercial move announcement`, category: "news", sinceDays: FSBO_MAX_AGE_DAYS, numResults: 10, schema: PROPERTY_CANDIDATE_SCHEMA },
  ]
}

export type PropertyCandidateKind = "fsbo" | "probate_notice" | "business_relocation"

export interface PropertyCandidate {
  kind: PropertyCandidateKind
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  askingPrice: number | null
  publishedContact: { present: boolean; email: string | null; phone: string | null; nameAsPublished: string | null }
  entityName: string | null
  noticeDate: string | null
  evidence: GroundedEvidence
  rights: SourceRights
  sensitivity: "intimate_service_topic" | "property_fact" | "market_context"
}

/** A page that CONTRADICTS a seller theory on the address (listed with a brokerage; recorded sold). */
export interface PropertyContradiction {
  kind: "active_listing_other_agent" | "recorded_sale"
  address: string
  city: string | null
  state: string | null
  listingBrokerage: string | null
  evidence: GroundedEvidence
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
const ESTATE_RE = /\b(estate of [A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\b/i

interface CandidateRead { candidates: PropertyCandidate[]; contradictions: PropertyContradiction[]; dropped: Record<string, number> }

/** PURE — results → property candidates (+ contradictions); every drop is counted and named. */
function propertyCandidates(results: readonly ExaHuntResult[], market: PlayMarket, now: Date): CandidateRead {
  const dropped: Record<string, number> = {}
  const drop = (k: string) => { dropped[k] = (dropped[k] ?? 0) + 1 }
  const candidates: PropertyCandidate[] = []
  const contradictions: PropertyContradiction[] = []
  for (const r of results) {
    const ev = groundedEvidence(r, now)
    if (!ev) { drop("no_citation"); continue }
    const rights = sourceRightsForUrl(r.url)
    const x = r.extracted ?? {}
    const text = `${r.title ?? ""} ${r.text ?? ""} ${(r.highlights ?? []).join(" ")}`
    const kindRaw = str(x.listing_kind) ?? (rights.sourceClass === "owner_published_listing" ? "fsbo" : rights.officialRecord && /notice to creditors|probate|estate of/i.test(text) ? "probate_notice" : /relocat|headquarters|moving (?:its )?offices/i.test(text) ? "business_relocation" : "other")
    const address = str(x.property_address) ?? extractPropertyAddress(text)
    const city = str(x.city) ?? market.city
    const state = (str(x.state) ?? market.state)?.toUpperCase() ?? null
    const zip = str(x.zip)
    if (kindRaw === "agent_listing" || kindRaw === "sold_record") {
      if (!address) { drop("contradiction_without_address"); continue }
      contradictions.push({ kind: kindRaw === "agent_listing" ? "active_listing_other_agent" : "recorded_sale", address, city, state, listingBrokerage: str(x.listing_brokerage), evidence: ev })
      continue
    }
    if (kindRaw !== "fsbo" && kindRaw !== "probate_notice" && kindRaw !== "business_relocation") { drop("not_a_candidate_kind"); continue }
    const maxAge = kindRaw === "probate_notice" ? NOTICE_MAX_AGE_DAYS : FSBO_MAX_AGE_DAYS
    const stale = freshnessProblem(ev, maxAge, now)
    if (stale) { drop("stale"); continue }
    if (kindRaw === "probate_notice" && !rights.officialRecord) { drop("probate_not_official_record"); continue }
    if (kindRaw !== "business_relocation" && !address) { drop("no_address"); continue }
    if (state && market.state && state !== market.state.toUpperCase()) { drop("outside_territory_state"); continue }
    const email = EMAIL_RE.exec(text)?.[0] ?? null
    const phone = PHONE_RE.exec(text)?.[0]?.replace(/\D/g, "") ?? null
    const present = x.owner_published_contact === true || !!email || !!(phone && phone.length >= 10)
    candidates.push({
      kind: kindRaw, address, city, state, zip, askingPrice: num(x.asking_price),
      publishedContact: { present, email: present ? email : null, phone: present && phone && phone.length >= 10 ? phone : null, nameAsPublished: str(x.owner_name_as_published) },
      entityName: str(x.estate_or_entity_name) ?? (kindRaw === "probate_notice" ? ESTATE_RE.exec(text)?.[1] ?? null : null),
      noticeDate: str(x.notice_or_filing_date) ?? ev.publishedAt,
      evidence: ev, rights,
      sensitivity: kindRaw === "probate_notice" ? "intimate_service_topic" : kindRaw === "fsbo" ? "property_fact" : "market_context",
    })
  }
  return { candidates, contradictions, dropped }
}

type OwnershipEvidence = Parameters<typeof verifyOwnership>[1][number]

/**
 * PURE — a candidate → its producer record. `owner` ONLY on a verified ownership verdict; a FSBO stays `property` (the
 * published contact point rides the payload, never a person column); an estate is `entity_trust_estate` with targeting
 * prohibited; a business relocation is job_civic_event evidence.
 */
function candidateRecord(c: PropertyCandidate, market: PlayMarket, ownerRecords: readonly OwnershipEvidence[]): NormalizedScrapedRecord | null {
  const e = c.evidence
  if (c.kind === "business_relocation") {
    return evidenceRecord({ subject: "job_civic_event", evidence: e, market: { city: market.city, state: market.state }, play: PLAY, evidenceClass: "market_level_opportunity", rights: c.rights, tags: ["business_relocation"], extracted: { address: c.address, entity: c.entityName } })
  }
  const base = {
    sourceRecordId: `exa-${e.resultId}`,
    source: EXA_PLAY_SOURCE,
    intentType: "seller" as const,
    city: c.city, state: c.state, zip: c.zip,
    propertyAddress: c.address,
    sourceUrl: e.sourceUrl,
    rawPayload: {
      id: e.resultId, url: e.sourceUrl, title: e.title, published: e.publishedAt, publisher: e.publisher, excerpt: e.quotedBasis,
      kind: c.kind, asking_price: c.askingPrice, source_class: c.rights.sourceClass,
      // The owner's published contact point is a FACT about the listing, kept where it cannot be read as a verified person.
      published_contact: c.publishedContact.present ? { email: c.publishedContact.email, phone: c.publishedContact.phone, name_as_published: c.publishedContact.nameAsPublished } : null,
      estate_or_entity: c.entityName, notice_date: c.noticeDate,
    },
  }
  const citation = { url: e.sourceUrl, title: e.title, publisher: e.publisher, published: e.publishedAt, retrieved_at: e.retrievedAt }
  if (c.kind === "probate_notice") {
    if (!c.entityName) return null
    return {
      ...base, behaviorType: "public_notice", intentSignals: ["probate", "early_opportunity", PLAY], fullName: c.entityName,
      envelope: {
        subjectKind: "entity_trust_estate", externalEventId: `exa:${e.resultId}`, proofUrls: [e.sourceUrl],
        evidence: { play: PLAY, evidence_class: "inferred_possibility", citation, quoted_basis: e.quotedBasis, source_class: c.rights.sourceClass, source_terms: c.rights.termsNote, sensitivity: c.sensitivity, targeting_prohibited: true, outreach: "none", queue: "property-level candidate for correctly licensed acquisition tools; a residential seller intent is never inferred from a filing" },
      },
    }
  }
  // FSBO: owner only through records. The producer stamps its OWN `evidence.ownership` from the record's single public-web
  // source (C36: a page cannot corroborate itself — that verdict is always unverified here); the play's verdict over the
  // AUTHORITATIVE records the caller supplied rides `ownership_verification`, with every source named, so a reader sees both.
  const lastName = c.publishedContact.nameAsPublished?.trim().split(/\s+/).pop() ?? null
  const verdict = lastName ? verifyOwnership({ lastName, zip: c.zip }, ownerRecords) : { verdict: "unverified" as const, basis: "no owner name published" }
  const join = verdict.verdict === "verified" ? "verified_record" : "name_only"
  const nameOnly = nameOnlyJoinProblem(join)
  const ownershipVerification = { ...verdict, sources: ownerRecords.map((r) => ({ source: r.source, rights: r.rights, owner_name: r.ownerName })), rule: "verified needs the surname on an authoritative record (public_record / licensed_vendor) AND a second independent authoritative source or a matching mailing address (lib/identity/subject-identity.ts verifyOwnership)" }
  const evidence = { play: PLAY, evidence_class: "expressed_interest", citation, quoted_basis: e.quotedBasis, source_class: c.rights.sourceClass, source_terms: c.rights.termsNote, sensitivity: c.sensitivity, asking_price: c.askingPrice, published_contact_present: c.publishedContact.present, ownership_verification: ownershipVerification, identity_join: nameOnly ?? "verified through authoritative owner records", next_step: verdict.verdict === "verified" ? "the owner row walks the EXISTING promotion gate (the published contact point was published to be used)" : "verify ownership against county records before any person row; the property stays a candidate" }
  if (verdict.verdict === "verified" && c.publishedContact.nameAsPublished) {
    const parts = c.publishedContact.nameAsPublished.trim().split(/\s+/)
    return {
      ...base, rawPayload: { ...base.rawPayload, owner_records: ownershipVerification.sources }, behaviorType: "fsbo_listing", intentSignals: ["fsbo", "early_opportunity", PLAY],
      firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : null, lastName: parts[parts.length - 1], email: c.publishedContact.email, phone: c.publishedContact.phone,
      envelope: { subjectKind: "owner", externalEventId: `exa:${e.resultId}`, proofUrls: [e.sourceUrl], evidence },
    }
  }
  return {
    ...base, behaviorType: "fsbo_listing", intentSignals: ["fsbo", "early_opportunity", PLAY],
    envelope: { subjectKind: "property", externalEventId: `exa:${e.resultId}`, proofUrls: [e.sourceUrl], evidence },
  }
}

type Ingest = (p: IngestRawSourceBatchParams) => Promise<IngestBatchResult>
type Svc = { from: (t: string) => any }

export interface PropertyCandidateDeps {
  ingest?: Ingest
  /** Authoritative owner records for an address (public_record / licensed_vendor). Default: none (no provider read — nothing is bought here). */
  ownerRecords?: (c: PropertyCandidate) => Promise<readonly OwnershipEvidence[]>
}

const defaultIngest: Ingest = async (p) => (await import("@/lib/kernel/scraping")).ingestRawSourceBatch(p)

export interface PropertyCandidatePlayResult extends PlayResult {
  candidates: PropertyCandidate[]
  contradictions: PropertyContradiction[]
}

/** The play. A monitor's `results` skip the hunt; a null client hunts nothing. */
export async function runPropertyCandidatePlay(
  svc: Svc,
  a: { market: PlayMarket; hunt: ExaHuntClient | null; results?: ExaHuntResult[] | null; now?: Date },
  deps: PropertyCandidateDeps = {},
): Promise<PropertyCandidatePlayResult> {
  const now = a.now ?? new Date()
  const blind: string[] = ["ownership is verified only against records the caller supplies (default: none — a FSBO stays a property candidate); asking prices are as published"]
  let results: ExaHuntResult[]
  let costUsd = 0
  if (a.results) results = a.results
  else {
    const hunt = await huntTerritory(a.hunt, propertyCandidateSearches(a.market), now)
    costUsd = hunt.costUsd
    blind.push(...hunt.errors)
    if (hunt.status === "provider_unconfigured") return { ...emptyResult(PLAY, "provider_unconfigured", blind), candidates: [], contradictions: [] }
    results = hunt.results
  }
  const read = propertyCandidates(results, a.market, now)
  blind.push(`dropped: ${JSON.stringify(read.dropped)}`)
  const actions: PlayAction[] = []
  const refused: PlayResult["refused"] = []
  const records: NormalizedScrapedRecord[] = []
  for (const c of read.candidates) {
    const owners = deps.ownerRecords ? await deps.ownerRecords(c) : []
    const rec = candidateRecord(c, a.market, owners)
    if (!rec) { refused.push({ what: `${c.kind} ${c.evidence.sourceUrl}`, why: "no estate or entity name on the notice — nothing to queue" }); continue }
    records.push(rec)
  }
  if (records.length) {
    const r = await (deps.ingest ?? defaultIngest)({
      brokerageId: a.market.brokerage_id, marketId: a.market.id, source: EXA_PLAY_SOURCE, sourceFamily: "motivated_seller", sourceChannel: EXA_PLAY_CHANNEL, sourceSubtype: PLAY,
      records, executionId: null, marketGeo: { city: a.market.city, state: a.market.state, zip_codes: a.market.zip_codes },
      batchCostUsd: costUsd > 0 ? costUsd : null, recencyDays: NOTICE_MAX_AGE_DAYS, actor: PLAY_ACTOR, client: svc as never,
    })
    const kinds = records.reduce<Record<string, number>>((acc, x) => { const k = x.envelope?.subjectKind ?? "?"; acc[k] = (acc[k] ?? 0) + 1; return acc }, {})
    actions.push({ kind: "ingest_property", target: "ingestRawSourceBatch", detail: { subject_kinds: kinds, inserted: r.inserted, replayed: r.replayed, skipped_territory: r.skipped_territory, skipped_not_viable: r.skipped_not_viable, skipped_stale: r.skipped_stale, skipped_refused: r.skipped_refused, next: "property-level queue for correctly licensed acquisition tools" } })
  }
  const status: PlayResult["status"] = actions.length ? "acted" : read.contradictions.length ? "acted" : "nothing_found"
  return { play: PLAY, status, evidence: [...read.candidates.map((c) => c.evidence), ...read.contradictions.map((c) => c.evidence)], actions, refused, blindSpots: blind, costUsd, candidates: read.candidates, contradictions: read.contradictions }
}
