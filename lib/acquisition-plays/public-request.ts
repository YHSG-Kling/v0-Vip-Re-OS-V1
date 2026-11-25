// lib/acquisition-plays/public-request.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLAY — PUBLICLY EXPRESSED REAL-ESTATE QUESTIONS AND REQUESTS FOR AN AGENT (wave 151, lane 151D; directive
// play 6, under the 2026-11-09 owner correction "exa is to find people when it is a scraper or hunting").
//
// Exa hunts public pages where someone asks for an agent or asks a buying / selling question about the
// territory. What becomes WHAT is decided by three gates, each said in the evidence:
//   · THE STATEMENT — first person, and an actual request for an agent to get in touch (a verbatim quote
//     or nothing; a third party's mention of a friend identifies nobody).
//   · THE IDENTITY — a contact point the AUTHOR published for this purpose (email / phone in their own
//     post), or a verified match to a record we hold. A handle or a name alone is NOT an identity: the
//     poster stays anonymous and is never deanonymized.
//   · THE SOURCE CLASS — only a page class whose terms permit using that published contact point (a
//     classified "wanted" post, an owner-published listing). A forum's member is answered through our
//     OWN inbound resources; the channel is never messaged because the content was public.
// A person who passes all three enters THE ONE RawData producer as a Raw Lead (subject person) and
// walks the EXISTING promotion gate → AI ISA. One whose contact point already belongs to a Contact we
// hold goes to THE arbiter (respondToLifeChangeSignal) — no new row, no paid call. Everything else is a
// cited anonymous_question the topic pass turns into an inbound resource (the answer).
//
// NO OUTBOUND HERE: this module never dispatches anything (test:early-opportunity-plays scans it).

import type { IngestBatchResult, IngestRawSourceBatchParams } from "@/lib/kernel/scraping"
import { GOOGLE_INDEXED_DISCOVERY_ROUTE, groundedEvidence, freshnessProblem, huntTerritory, sourceRightsForUrl, type ExaHuntClient, type ExaHuntResult, type ExaHuntSearch, type GroundedEvidence, type SourceRights } from "@/lib/providers/exa/hunting"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import type { KnownAcquisitionKeys, PrePullCandidate } from "@/lib/lead-pipeline/pre-pull-dedup"
import { EXA_PLAY_CHANNEL, EXA_PLAY_SOURCE, PLAY_ACTOR, PUBLIC_REQUEST_MAX_AGE_DAYS, emptyResult, evidenceRecord, personCandidateProblem, type PersonCandidate, type PlayAction, type PlayResult } from "./contract"
import type { PlayMarket } from "./moving-corridor"
import { readPublicStatement, type PublicStatement } from "./public-statement"

const PLAY = "public_request_assist" as const

const where = (m: PlayMarket) => [m.city, m.state].filter(Boolean).join(", ")

/**
 * PURE — the territory's person-intent searches. First-person phrasing is permitted here (owner correction 2026-11-09).
 * WAVE 153 (lane 153N — owner ruling B4 / B5): Exa finds PEOPLE publicly stating their own real-estate need — asking for an
 * agent, buying, selling, selling by owner, relocating, a military move — each a plain description of the page wanted, scoped
 * to the territory, inside the 90-day window. No invented "play": every search is a phrase a person writes, and a hit is a
 * person ONLY after the grounding gate (openable URL, quotable text, a source date, the author as the person with the need,
 * a contact point the author published). Military movers are found from what they VOLUNTEER in public; nothing here reads,
 * infers or claims orders or a duty station.
 */
export function publicRequestSearches(market: PlayMarket): ExaHuntSearch[] {
  const w = where(market)
  if (!w) return []
  const s = (key: string, query: string): ExaHuntSearch => ({ key, query, sinceDays: PUBLIC_REQUEST_MAX_AGE_DAYS, numResults: 10 })
  return [
    s("request:agent_sought", `I'm looking for a real estate agent in ${w}, can anyone recommend one`),
    s("request:relocating_need_agent", `relocating to ${w} and need a realtor to help us find a home`),
    s("request:buyer_questions", `questions about buying or selling a home in ${w}`),
    s("need:buying", `we are looking to buy a house in ${w} this year, any advice`),
    s("need:selling", `we need to sell our house in ${w}, where do we start`),
    s("need:fsbo", `selling my house by owner in ${w}, contact me if interested`),
    s("need:military_move", `PCSing to ${w} and looking for a home to buy or rent`),
  ]
}

/** The real-estate needs a first-person statement can carry (one vocabulary; rides the record as need_kinds). */
export const STATED_NEED_KINDS = ["buying", "selling", "fsbo_selling", "relocating", "military_move"] as const
export type StatedNeedKind = (typeof STATED_NEED_KINDS)[number]

// TOMBSTONE (wave 154, lane 154G1): readPublicStatement, its regexes and NEED_PATTERNS moved VERBATIM to the PURE module
// lib/acquisition-plays/public-statement.ts (readPublicStatement) so the content-topic path can classify public chatter
// without reaching this file's lazy RawData / AI-ISA imports. STATED_NEED_KINDS stays here (its one spelling).

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
const NAME_RE = /\b([A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+)\b/

/** PURE — the identity a statement carries: a contact point the AUTHOR published (email / phone in the text) wins; a handle or a name alone is not one. */
function identityFromStatement(r: ExaHuntResult, rights: SourceRights): PersonCandidate["identity"] {
  const text = `${r.title ?? ""} ${r.text ?? ""} ${(r.highlights ?? []).join(" ")}`
  const host = rights.host ?? ""
  const emails = (text.match(EMAIL_RE) ?? []).filter((e) => !/noreply|no-reply|support@|info@|privacy@|legal@|abuse@/i.test(e) && !(host && e.toLowerCase().endsWith(`@${host}`)))
  const phones = (text.match(PHONE_RE) ?? []).map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 10)
  if (emails.length || phones.length) return { basis: "published_contact", email: emails[0] ?? null, phone: phones[0] ?? null, handle: r.author ?? null }
  if (r.author && r.author.trim()) return { basis: "handle_only", handle: r.author.trim() }
  const name = NAME_RE.exec(text)?.[1] ?? null
  if (name) return { basis: "name_only", name }
  return { basis: "none" }
}

// ── WAVE 154 (lane 154B — owner ruling R5(a), directive B1) ─────────────────────────────────────────────────────
// B1 asks every person record for the author AS PUBLISHED, the identity-link confidence, the contact channel AS PUBLISHED,
// and an expiry; it asks a non-person page to be classified for what it is (an article / public record or permit is
// market or property intelligence, never a person); and it asks older indexed copies and rediscoveries not to duplicate.

/** What a page that did NOT pass the person path is (one vocabulary; rides the evidence record). */
export const NON_PERSON_INTELLIGENCE_CLASSES = ["article", "public_record_or_permit", "partial_profile", "anonymous_forum_post", "unattributed_page"] as const
export type NonPersonIntelligenceClass = (typeof NON_PERSON_INTELLIGENCE_CLASSES)[number]

/** PURE — an article or a public record / permit is MARKET or PROPERTY intelligence; a name with no published contact point is
 *  a partial profile; a forum post without one stays an anonymous question. None of them is ever a person. */
/** @proofSeam scripts/google-intelligence-guard.ts checks the classes on fixture rights; production caller: the public-request classification path in this file. */
export function nonPersonIntelligenceClass(rights: Pick<SourceRights, "sourceClass">, identityBasis: string): NonPersonIntelligenceClass {
  if (rights.sourceClass === "news") return "article"
  if (rights.sourceClass === "official_record") return "public_record_or_permit"
  if (identityBasis === "name_only") return "partial_profile"
  if (rights.sourceClass === "public_forum" || identityBasis === "handle_only") return "anonymous_forum_post"
  return "unattributed_page"
}

/** PURE — one statement's identity across indexed copies: the author's published contact point + their words, normalized.
 *  A mirror, a cached copy or a rediscovery under a new result id carries the same key (FNV-1a, deterministic). */
/** @proofSeam scripts/google-intelligence-guard.ts checks copy-key collapse; production caller: the public-request classification path in this file. */
export function statementCopyKey(a: { email?: string | null; phone?: string | null; quote: string | null }): string {
  const contact = (a.email ?? "").trim().toLowerCase() || (a.phone ?? "").replace(/\D/g, "")
  const words = (a.quote ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
  let h = 0x811c9dc5
  for (const ch of `${contact}|${words}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, "0")
}

type Classified =
  | { kind: "person_candidate"; candidate: PersonCandidate; evidence: GroundedEvidence; rights: SourceRights; statement: PublicStatement; author: string | null }
  | { kind: "anonymous_question"; evidence: GroundedEvidence; rights: SourceRights; statement: PublicStatement; why: string; identityBasis: string }
  | { kind: "dropped"; why: string }

/** PURE — one result → what it may become. Every refusal of the person path names its rule (personCandidateProblem). */
function classifyPublicRequest(r: ExaHuntResult, now: Date): Classified {
  const evidence = groundedEvidence(r, now)
  if (!evidence) return { kind: "dropped", why: "no openable URL or nothing quotable" }
  const stale = freshnessProblem(evidence, PUBLIC_REQUEST_MAX_AGE_DAYS, now)
  if (stale) return { kind: "dropped", why: stale }
  const rights = sourceRightsForUrl(r.url)
  const statement = readPublicStatement(`${r.title ?? ""}. ${r.text ?? ""} ${(r.highlights ?? []).join(" ")}`)
  if (!statement.requestsAgentContact && !statement.statesHousingNeed && !statement.isQuestion) return { kind: "dropped", why: "neither a request for an agent, a stated real-estate need nor a real-estate question" }
  const identity = identityFromStatement(r, rights)
  const candidate: PersonCandidate = { statement: { firstPerson: statement.firstPerson, requestsAgentContact: statement.requestsAgentContact, statesHousingNeed: statement.statesHousingNeed, quote: statement.quote, minorAuthor: statement.minorAuthor }, identity, rights, publishedAt: evidence.publishedAt }
  const problem = personCandidateProblem(candidate, now)
  if (!problem) return { kind: "person_candidate", candidate, evidence, rights, statement, author: r.author?.trim() || null }
  return { kind: "anonymous_question", evidence, rights, statement, why: problem, identityBasis: identity.basis }
}

/** PURE — the Raw Lead record for a person who asked, by the contact point they published. The author's name AS THE PAGE
 *  SHOWS IT rides the evidence only here, where the same author published a contact point for this need (directive B1). */
function personRecord(c: Classified & { kind: "person_candidate" }, market: PlayMarket): NormalizedScrapedRecord {
  const e = c.evidence
  const needs = c.statement.needKinds
  const sells = needs.includes("selling") || needs.includes("fsbo_selling")
  const copyKey = statementCopyKey({ email: c.candidate.identity.email, phone: c.candidate.identity.phone, quote: c.statement.quote })
  const expires = c.candidate.publishedAt && Number.isFinite(Date.parse(c.candidate.publishedAt))
    ? new Date(Date.parse(c.candidate.publishedAt) + PUBLIC_REQUEST_MAX_AGE_DAYS * 86_400_000).toISOString() : null
  return {
    // Keyed on the STATEMENT, not the Exa result id (wave 154): an older indexed copy or a rediscovery of the same words by
    // the same author replays the held row (re-verified) instead of filing a second Raw Lead.
    sourceRecordId: `exa-stmt-${copyKey}`,
    source: EXA_PLAY_SOURCE,
    behaviorType: c.statement.requestsAgentContact ? "agent_request" : "stated_housing_need",
    intentType: sells ? "seller" : "buyer",
    intentSignals: Array.from(new Set([...(c.statement.requestsAgentContact ? ["need_a_realtor"] : []), "early_opportunity", PLAY, ...needs, ...(c.statement.relocating ? ["relocating"] : [])])),
    email: c.candidate.identity.email ?? null,
    phone: c.candidate.identity.phone ?? null,
    city: market.city,
    state: market.state,
    sourceUrl: e.sourceUrl,
    rawPayload: { id: e.resultId, url: e.sourceUrl, title: e.title, published: e.publishedAt, publisher: e.publisher, excerpt: e.quotedBasis, source_class: c.rights.sourceClass },
    envelope: {
      subjectKind: "person",
      externalEventId: `exa:stmt:${copyKey}`,
      proofUrls: [e.sourceUrl],
      // After the play's window the statement is history, not a person asking now (ttl anchors on the published date).
      ttlDays: PUBLIC_REQUEST_MAX_AGE_DAYS,
      evidence: {
        play: PLAY, evidence_class: "expressed_interest",
        // Directive B1 fields (wave 154, lane 154B).
        author_as_published: c.author,
        identity_link: { basis: c.candidate.identity.basis, confidence: "direct", why: "the contact point appears in the author's own first-person statement on this page — no inference, no lookup" },
        contact_channel_as_published: { email: !!c.candidate.identity.email, phone: !!c.candidate.identity.phone, where: "in the text of the author's own post" },
        evidence_expires_at: expires,
        statement_copy_key: copyKey,
        exa_result_id: e.resultId,
        discovery_route: GOOGLE_INDEXED_DISCOVERY_ROUTE,
        consent_basis: "the author published this contact point in a first-person request for an agent or statement of their own real-estate need, on a public page class whose use the owner permitted (ruling B4)",
        identity_basis: c.candidate.identity.basis,
        author_relationship: "first_person_author — the person who posted states the need as their own",
        need_kinds: needs,
        // Owner ruling B5: a military move is what the person VOLUNTEERED in public; the record never claims orders, a report
        // date or a duty station — those are asked of the person (the portal's PCS planner, after they are a Contact).
        ...(needs.includes("military_move") ? { military_boundary: "volunteered move only — no orders, report date or duty station is claimed from this text" } : {}),
        quote: c.statement.quote,
        citation: { url: e.sourceUrl, title: e.title, publisher: e.publisher, published: e.publishedAt, retrieved_at: e.retrievedAt },
        source_class: c.rights.sourceClass, source_terms: c.rights.termsNote,
        channel_policy: "never a reply in the channel; the person is answered through the contact point they published, by the Raw Lead → promotion gate → AI ISA path",
      },
    },
  }
}

type Ingest = (p: IngestRawSourceBatchParams) => Promise<IngestBatchResult>
type Svc = { from: (t: string) => any }

export interface PublicRequestDeps {
  ingest?: Ingest
  /** A tenant-pinned lookup of a Contact we already hold by the published contact point (default: contacts by email, then phone). */
  findContact?: (svc: Svc, a: { brokerageId: string; email: string | null; phone: string | null }) => Promise<{ contactId: string | null; error: string | null }>
  /** THE arbiter's life-change door (default lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal). */
  respond?: typeof import("@/lib/ai-isa/followup-arbiter").respondToLifeChangeSignal
  /** The known-keys reader of THE pre-pull dedup (default lib/lead-pipeline/pre-pull-dedup.ts loadKnownAcquisitionKeys). */
  loadKnown?: (svc: Svc, scope: { brokerageId: string | null; marketIds: readonly string[] }, probe: { candidates: readonly PrePullCandidate[] }) => Promise<KnownAcquisitionKeys | null>
}

const defaultLoadKnown: NonNullable<PublicRequestDeps["loadKnown"]> = async (svc, scope, probe) =>
  (await import("@/lib/lead-pipeline/pre-pull-dedup")).loadKnownAcquisitionKeys(svc as never, scope, probe)

const defaultIngest: Ingest = async (p) => (await import("@/lib/kernel/scraping")).ingestRawSourceBatch(p)
const defaultRespond: NonNullable<PublicRequestDeps["respond"]> = async (svc, input, deps) => (await import("@/lib/ai-isa/followup-arbiter")).respondToLifeChangeSignal(svc, input, deps)
const defaultFindContact: NonNullable<PublicRequestDeps["findContact"]> = async (svc, a) => {
  if (a.email) {
    const { data, error } = await svc.from("contacts").select("id").eq("brokerage_id", a.brokerageId).eq("email", a.email.toLowerCase()).limit(1)
    if (error) return { contactId: null, error: `contacts read refused: ${error.message}` }
    if ((data ?? []).length) return { contactId: (data as Array<{ id: string }>)[0].id, error: null }
  }
  if (a.phone) {
    const { data, error } = await svc.from("contacts").select("id").eq("brokerage_id", a.brokerageId).eq("phone", a.phone).limit(1)
    if (error) return { contactId: null, error: `contacts read refused: ${error.message}` }
    if ((data ?? []).length) return { contactId: (data as Array<{ id: string }>)[0].id, error: null }
  }
  return { contactId: null, error: null }
}

/** The play. A monitor's `results` skip the hunt; a null client hunts nothing (provider_unconfigured, zero rows). */
export async function runPublicRequestPlay(
  svc: Svc,
  a: { market: PlayMarket; hunt: ExaHuntClient | null; results?: ExaHuntResult[] | null; now?: Date },
  deps: PublicRequestDeps = {},
): Promise<PlayResult> {
  const now = a.now ?? new Date()
  const blind: string[] = ["a forum member's request is answered through our own inbound resources (platform terms); an unclassified host permits no contact point"]
  let results: ExaHuntResult[]
  let costUsd = 0
  if (a.results) results = a.results
  else {
    const hunt = await huntTerritory(a.hunt, publicRequestSearches(a.market), now)
    costUsd = hunt.costUsd
    blind.push(...hunt.errors)
    if (hunt.status === "provider_unconfigured") return emptyResult(PLAY, "provider_unconfigured", blind)
    results = hunt.results
  }
  const actions: PlayAction[] = []
  const refused: PlayResult["refused"] = []
  const evidence: GroundedEvidence[] = []
  const persons: NormalizedScrapedRecord[] = []
  const questions: NormalizedScrapedRecord[] = []
  const dropped: Record<string, number> = {}

  for (const r of results) {
    const c = classifyPublicRequest(r, now)
    if (c.kind === "dropped") { dropped[c.why] = (dropped[c.why] ?? 0) + 1; continue }
    evidence.push(c.evidence)
    if (c.kind === "anonymous_question") {
      refused.push({ what: `person path for ${c.evidence.sourceUrl}`, why: c.why })
      // Wave 154 (B1.4): an article or a public record / permit is MARKET / PROPERTY intelligence (subject 'market'); a forum
      // post or a partial profile stays an anonymous question. Either way: no person, no identity on the record.
      const klass = nonPersonIntelligenceClass(c.rights, c.identityBasis)
      const marketSubject = klass === "article" || klass === "public_record_or_permit"
      questions.push(evidenceRecord({ subject: marketSubject ? "market" : "anonymous_question", evidence: c.evidence, market: a.market, play: PLAY, evidenceClass: "expressed_interest", rights: c.rights, tags: [klass, ...(marketSubject ? [] : c.statement.requestsAgentContact ? ["agent_request_anonymous"] : ["question"])], extracted: { intelligence_class: klass, quote: c.statement.quote, requests_agent: c.statement.requestsAgentContact, relocating: c.statement.relocating }, side: "buyer" }))
      continue
    }
    // An existing Contact by their own published contact point → THE arbiter, never a new row (no provider bill).
    if (a.market.brokerage_id) {
      const found = await (deps.findContact ?? defaultFindContact)(svc, { brokerageId: a.market.brokerage_id, email: c.candidate.identity.email ?? null, phone: c.candidate.identity.phone ?? null })
      if (found.error) { refused.push({ what: `existing-contact check for ${c.evidence.sourceUrl}`, why: found.error }); continue }
      if (found.contactId) {
        const resp = await (deps.respond ?? defaultRespond)(svc, {
          brokerageId: a.market.brokerage_id, subject: { type: "contact", id: found.contactId },
          signalType: c.statement.relocating ? "relocation_referral_request" : "buying_intent", source: `early_opportunity:${PLAY}`, now,
          detail: { quote: c.statement.quote, url: c.evidence.sourceUrl, published: c.evidence.publishedAt, identity_basis: c.candidate.identity.basis },
        })
        actions.push({ kind: "arbiter", target: "respondToLifeChangeSignal", detail: { contactId: found.contactId, action: resp.action, reason: resp.reason, url: c.evidence.sourceUrl } })
        continue
      }
    }
    persons.push(personRecord(c, a.market))
  }
  blind.push(`dropped: ${JSON.stringify(dropped)}`)

  // OLDER INDEXED COPIES (wave 154, B1.5): the same author's same statement found on several URLs in ONE pass (a mirror, a
  // cached copy, a cross-post) is ONE person — the newest-published copy is kept, every other copy is named and held.
  {
    const byKey = new Map<string, number>()
    const keep: NormalizedScrapedRecord[] = []
    const published = (p: NormalizedScrapedRecord) => String((p.rawPayload as { published?: string | null } | undefined)?.published ?? "")
    for (const p of persons) {
      const k = p.sourceRecordId ?? ""
      const at = byKey.get(k)
      if (at === undefined) { byKey.set(k, keep.length); keep.push(p); continue }
      const [newer, older] = published(p) > published(keep[at]) ? [p, keep[at]] : [keep[at], p]
      keep[at] = newer
      refused.push({ what: `person path for ${older.sourceUrl}`, why: `an older indexed copy of the same statement — kept ${newer.sourceUrl}` })
    }
    persons.length = 0
    persons.push(...keep)
  }

  // PRE-PULL DEDUP (wave 153, lane 153N — directive Part B §4 "pre-pull dedup → RawData"): a person we already hold — the
  // same Exa result filed before, or a Lead / Contact / raw observation with the same published email or phone — is HELD
  // before the RawData door, so no second Raw Lead walks the paid enrichment that follows promotion (the Exa search itself was
  // billed at search time; that spend is not re-made). THE one planner (planPrePullDedup) judges; a refused known-keys read
  // holds every person this cycle (fail closed — CLAUDE.md §4), named.
  if (persons.length > 0) {
    const { planPrePullDedup } = await import("@/lib/lead-pipeline/pre-pull-dedup")
    const candidates: PrePullCandidate[] = persons.map((p, i) => ({ ref: String(i), source: EXA_PLAY_SOURCE, sourceRecordId: p.sourceRecordId ?? null, email: p.email ?? null, phone: p.phone ?? null, subjectKind: "person" }))
    const known = await (deps.loadKnown ?? defaultLoadKnown)(svc, { brokerageId: a.market.brokerage_id ?? null, marketIds: a.market.id ? [a.market.id] : [] }, { candidates })
    if (!known) {
      for (const p of persons) refused.push({ what: `person path for ${p.sourceUrl}`, why: "held: the duplicate check could not read what is already held — nothing is filed until it can (fail closed)" })
      persons.length = 0
    } else {
      const plan = planPrePullDedup(candidates, known, { lookupKind: "person", now })
      const keep = new Set(plan.buy.map((c) => c.ref))
      for (const v of plan.verdicts) if (v.action === "skip") refused.push({ what: `person path for ${persons[Number(v.ref)]?.sourceUrl}`, why: `duplicate held before a paid pull (${v.reason}): ${v.why}` })
      const kept = persons.filter((_, i) => keep.has(String(i)))
      persons.length = 0
      persons.push(...kept)
      blind.push(`pre-pull dedup: ${plan.skipped} held of ${candidates.length} (judged against ${JSON.stringify(plan.judgedAgainst)})`)
    }
  }

  const ingest = deps.ingest ?? defaultIngest
  const common = { brokerageId: a.market.brokerage_id, marketId: a.market.id, source: EXA_PLAY_SOURCE, sourceFamily: "social_intent", sourceChannel: EXA_PLAY_CHANNEL, sourceSubtype: PLAY, executionId: null, marketGeo: { city: a.market.city, state: a.market.state, zip_codes: a.market.zip_codes }, recencyDays: PUBLIC_REQUEST_MAX_AGE_DAYS, actor: PLAY_ACTOR, client: svc as never } as const
  const share = (n: number) => (costUsd > 0 && persons.length + questions.length > 0 ? (costUsd * n) / (persons.length + questions.length) : null)
  if (persons.length) {
    const r = await ingest({ ...common, records: persons, batchCostUsd: share(persons.length) })
    actions.push({ kind: "ingest_person", target: "ingestRawSourceBatch", detail: { subject_kind: "person", inserted: r.inserted, replayed: r.replayed, skipped_territory: r.skipped_territory, skipped_stale: r.skipped_stale, skipped_refused: r.skipped_refused, next: "the EXISTING Raw Lead promotion gate → AI ISA" } })
  }
  if (questions.length) {
    const r = await ingest({ ...common, records: questions, batchCostUsd: share(questions.length) })
    actions.push({ kind: "ingest_evidence", target: "ingestRawSourceBatch", detail: { subject_kind: "anonymous_question", inserted: r.inserted, replayed: r.replayed, skipped_refused: r.skipped_refused, next: "the topic pass turns cited questions into an inbound resource (lib/content-intel/topic-themes.ts)" } })
  }
  const status: PlayResult["status"] = actions.length ? "acted" : "nothing_found"
  return { play: PLAY, status, evidence, actions, refused, blindSpots: blind, costUsd }
}
