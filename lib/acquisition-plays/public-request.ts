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
import { groundedEvidence, freshnessProblem, huntTerritory, sourceRightsForUrl, type ExaHuntClient, type ExaHuntResult, type ExaHuntSearch, type GroundedEvidence, type SourceRights } from "@/lib/providers/exa/hunting"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import { EXA_PLAY_CHANNEL, EXA_PLAY_SOURCE, PLAY_ACTOR, PUBLIC_REQUEST_MAX_AGE_DAYS, emptyResult, evidenceRecord, personCandidateProblem, type PersonCandidate, type PlayAction, type PlayResult } from "./contract"
import type { PlayMarket } from "./moving-corridor"

const PLAY = "public_request_assist" as const

const where = (m: PlayMarket) => [m.city, m.state].filter(Boolean).join(", ")

/** PURE — the territory's request / question searches. First-person phrasing is permitted here (owner correction 2026-11-09). */
export function publicRequestSearches(market: PlayMarket): ExaHuntSearch[] {
  const w = where(market)
  if (!w) return []
  return [
    { key: "request:agent_sought", query: `I'm looking for a real estate agent in ${w}, can anyone recommend one`, sinceDays: PUBLIC_REQUEST_MAX_AGE_DAYS, numResults: 10 },
    { key: "request:relocating_need_agent", query: `relocating to ${w} and need a realtor to help us find a home`, sinceDays: PUBLIC_REQUEST_MAX_AGE_DAYS, numResults: 10 },
    { key: "request:buyer_questions", query: `questions about buying or selling a home in ${w}`, sinceDays: PUBLIC_REQUEST_MAX_AGE_DAYS, numResults: 10 },
  ]
}

interface PublicStatement { firstPerson: boolean; thirdParty: boolean; requestsAgentContact: boolean; isQuestion: boolean; relocating: boolean; quote: string | null }

const REQUEST_RE = /\b(looking for|need|seeking|searching for|hire|find|recommend(?:ation)?s?\s+(?:for|of)?|who should (?:I|we) (?:use|call|talk to))\b[^.?!]{0,60}\b(real ?estate agent|realtor|buyer'?s agent|listing agent|agent)\b|\bcan anyone recommend\b[^.?!]{0,60}\b(agent|realtor)\b/i
const FIRST_PERSON_RE = /\b(I|I'm|I am|I've|we|we're|we are|we've|my|our|me|us)\b/
const THIRD_PARTY_RE = /\b(my|our)\s+(friend|sister|brother|parents|mother|father|coworker|colleague|neighbor|client|cousin|aunt|uncle|son|daughter)\b|\bsomeone I know\b|\ba friend of mine\b/i
const QUESTION_RE = /\?|\b(how (?:much|do|does|long)|what (?:is|are|should)|is it (?:worth|better)|should (?:I|we))\b/i
const RELOCATING_RE = /\b(relocat\w*|moving to|move to|transferr?\w* to|pcs\w* to)\b/i

/** PURE — read a statement: sentences split, the request sentence quoted verbatim (≤ 200 chars). */
function readPublicStatement(text: string): PublicStatement {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean)
  // The AUTHOR's own first-person request wins over a headline that merely names the topic ("Looking for a realtor.").
  const requestSentence = sentences.find((s) => REQUEST_RE.test(s) && FIRST_PERSON_RE.test(s)) ?? sentences.find((s) => REQUEST_RE.test(s)) ?? null
  const questionSentence = sentences.find((s) => QUESTION_RE.test(s) && /\b(home|house|buy|sell|mortgage|closing|agent|realtor|neighborhood|rent)\b/i.test(s)) ?? null
  const quoteSrc = requestSentence ?? questionSentence
  const firstPerson = !!requestSentence && FIRST_PERSON_RE.test(requestSentence)
  const thirdParty = !!requestSentence && THIRD_PARTY_RE.test(requestSentence)
  return {
    firstPerson: firstPerson && !thirdParty,
    thirdParty,
    requestsAgentContact: !!requestSentence && firstPerson && !thirdParty,
    isQuestion: !!questionSentence || /\?/.test(text),
    relocating: RELOCATING_RE.test(text),
    quote: quoteSrc ? quoteSrc.slice(0, 200) : null,
  }
}

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

type Classified =
  | { kind: "person_candidate"; candidate: PersonCandidate; evidence: GroundedEvidence; rights: SourceRights; statement: PublicStatement }
  | { kind: "anonymous_question"; evidence: GroundedEvidence; rights: SourceRights; statement: PublicStatement; why: string }
  | { kind: "dropped"; why: string }

/** PURE — one result → what it may become. Every refusal of the person path names its rule (personCandidateProblem). */
function classifyPublicRequest(r: ExaHuntResult, now: Date): Classified {
  const evidence = groundedEvidence(r, now)
  if (!evidence) return { kind: "dropped", why: "no openable URL or nothing quotable" }
  const stale = freshnessProblem(evidence, PUBLIC_REQUEST_MAX_AGE_DAYS, now)
  if (stale) return { kind: "dropped", why: stale }
  const rights = sourceRightsForUrl(r.url)
  const statement = readPublicStatement(`${r.title ?? ""}. ${r.text ?? ""} ${(r.highlights ?? []).join(" ")}`)
  if (!statement.requestsAgentContact && !statement.isQuestion) return { kind: "dropped", why: "neither a request for an agent nor a real-estate question" }
  const identity = identityFromStatement(r, rights)
  const candidate: PersonCandidate = { statement: { firstPerson: statement.firstPerson, requestsAgentContact: statement.requestsAgentContact, quote: statement.quote }, identity, rights, publishedAt: evidence.publishedAt }
  const problem = personCandidateProblem(candidate, now)
  if (!problem) return { kind: "person_candidate", candidate, evidence, rights, statement }
  return { kind: "anonymous_question", evidence, rights, statement, why: problem }
}

/** PURE — the Raw Lead record for a person who asked, by the contact point they published. No handle rides it. */
function personRecord(c: Classified & { kind: "person_candidate" }, market: PlayMarket): NormalizedScrapedRecord {
  const e = c.evidence
  return {
    sourceRecordId: `exa-${e.resultId}`,
    source: EXA_PLAY_SOURCE,
    behaviorType: "agent_request",
    intentType: "buyer",
    intentSignals: Array.from(new Set(["need_a_realtor", "early_opportunity", PLAY, ...(c.statement.relocating ? ["relocating"] : [])])),
    email: c.candidate.identity.email ?? null,
    phone: c.candidate.identity.phone ?? null,
    city: market.city,
    state: market.state,
    sourceUrl: e.sourceUrl,
    rawPayload: { id: e.resultId, url: e.sourceUrl, title: e.title, published: e.publishedAt, publisher: e.publisher, excerpt: e.quotedBasis, source_class: c.rights.sourceClass },
    envelope: {
      subjectKind: "person",
      externalEventId: `exa:${e.resultId}`,
      proofUrls: [e.sourceUrl],
      evidence: {
        play: PLAY, evidence_class: "expressed_interest",
        consent_basis: "the author published this contact point in a first-person request for an agent on a page class whose terms permit its use",
        identity_basis: c.candidate.identity.basis,
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
}

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
      questions.push(evidenceRecord({ subject: "anonymous_question", evidence: c.evidence, market: a.market, play: PLAY, evidenceClass: "expressed_interest", rights: c.rights, tags: c.statement.requestsAgentContact ? ["agent_request_anonymous"] : ["question"], extracted: { quote: c.statement.quote, requests_agent: c.statement.requestsAgentContact, relocating: c.statement.relocating }, side: "buyer" }))
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
