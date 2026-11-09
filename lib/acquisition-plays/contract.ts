// lib/acquisition-plays/contract.ts
// ─────────────────────────────────────────────────────────────────────────────
// EARLY-OPPORTUNITY PLAYS — THE CONTRACT (wave 151, lane 151D; directive §151D "Advanced research and
// signal-fusion plays — build working paths, not just ideas").
//
// A PLAY is a working research-to-decision path, not a strategy note. Each one here names, in code,
// the twelve facets the directive requires (PLAY_FACETS) and ENDS in an existing manager / action:
// THE ONE RawData producer (lib/kernel/scraping.ts ingestRawSourceBatch), the inter-manager bus
// (lib/kernel/manager-signals.ts publishManagerSignal), the market-report producer
// (lib/market-reports/producer.ts produceMarketReport), the lead-magnet producer (lib/kernel/
// lead-magnets.ts createLeadMagnet), THE arbiter (lib/ai-isa/followup-arbiter.ts
// respondToLifeChangeSignal, reached through lib/intent/movement-signals.ts recordMovementSignal),
// or the movement outcome recorder (recordMovementOutcome). No new manager, kernel or lead engine.
//
// EVIDENCE CLASSES (charter §2, one spelling): VERIFIED INTENT · EXPRESSED INTEREST · INFERRED
// POSSIBILITY · MARKET-LEVEL OPPORTUNITY · STALE-CONTRADICTED. Market-level evidence produces
// education and opt-in invitations, never a personal lead (directive: "a public event does not
// automatically identify an individual ready to transact").
//
// IDENTITY RULES (directive: "avoid unsupported identity joins based merely on similar names"):
//   · personCandidateProblem — a PERSON is discovered only from a first-person request for an agent,
//     by an identity the person themselves published for that purpose (or a verified record key),
//     on a page class whose terms permit it, inside the play's freshness window.
//   · nameOnlyJoinProblem — a name alone never joins a page to a record or a property to an owner.

import type { NormalizedScrapedRecord, RawDataSubjectKind } from "@/lib/lead-pipeline/raw-record-types"
import { freshnessProblem, type GroundedEvidence, type SourceRights } from "@/lib/providers/exa/hunting"

export const EVIDENCE_CLASSES = ["verified_intent", "expressed_interest", "inferred_possibility", "market_level_opportunity", "stale_contradicted"] as const
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number]

/** One vocabulary — provider_monitors.play_key CHECK (m969) holds the same words. */
export const PLAY_KEYS = ["moving_corridor_radar", "public_request_assist", "property_candidate_queue", "contact_second_window", "negative_evidence_saver"] as const
export type PlayKey = (typeof PLAY_KEYS)[number]

/** The plays Exa HUNTS for (a Search Monitor can push their deltas); the other two read first-party / recorded evidence. */
export const EXA_HUNTED_PLAYS: readonly PlayKey[] = ["moving_corridor_radar", "public_request_assist", "property_candidate_queue"]

export const PLAY_FACETS = [
  "source_rights", "territorial_purpose", "producer", "ingestion", "evidence", "freshness",
  "dedup", "arbiter_decision", "activation", "assistance", "outcome_attribution", "failure_recovery",
] as const
export type PlayFacet = (typeof PLAY_FACETS)[number]

export interface PlayCard {
  key: PlayKey
  title: string
  /** 1 = earliest VERIFIED assistance (the ranking the directive asks for — not novelty). */
  earliestAssistanceRank: number
  facets: Record<PlayFacet, string>
  /** The EXISTING exports each path ends in. */
  endsIn: readonly string[]
  negativeControl: string
}

export const PLAY_CARDS: Readonly<Record<PlayKey, PlayCard>> = Object.freeze({
  contact_second_window: {
    key: "contact_second_window", title: "Existing-Contact second-window radar", earliestAssistanceRank: 1,
    facets: {
      source_rights: "first_party_observed — the tenant's own saved_properties, valuation_requests, buyer_criteria_changes and property_preferences rows (consented portal / site activity)",
      territorial_purpose: "the tenant's own Contacts only (contacts.brokerage_id = the session tenant's territory roster)",
      producer: "lib/intent/movement-signals.ts reassessExistingContact (lane 151E's ONE door for a known Contact's change → the C9 recorder) — NEVER the RawData producer: a known Contact is not a new observation of a stranger",
      ingestion: "movement_signals rows keyed by the first-party row ids (fp_saved_homes / fp_valuation_request / fp_criteria_revisions)",
      evidence: "verified first_party_row references with a one-sentence summary of the SHIFT (saved homes outside stated cities / above the stated ceiling; a valuation request; repeated stated criteria changes)",
      freshness: "the sweep window (default 30 days) — a shift older than the window is history",
      dedup: "the C9 idempotency key per first-party row set; a second sweep of the same rows is a replay (status replayed)",
      arbiter_decision: "the movement manager decides (evaluateMovementSubject) and hands offer_help to THE arbiter over the bus (online_intent_detected → the ONE life-change responder); wait / research are legitimate verdicts",
      activation: "whatever the arbiter chooses under the person's stated preferences; unset preferences → the arbiter decides",
      assistance: "a market update, matching homes, an equity review — them-first, in the sender's voice",
      outcome_attribution: "movement_signals.outcome via recordMovementOutcome / the reconciler; decision-window forecasts graded by the outcome",
      failure_recovery: "a refused read refuses the sweep for that contact (said); a refused record is retried on the next sweep; nothing is bought",
    },
    endsIn: ["reassessExistingContact", "respondToLifeChangeSignal"],
    negativeControl: "an existing Contact's shift writes NO raw_scraped_leads row, NO leads row and triggers NO paid lookup; a contact outside the tenant is refused",
  },
  negative_evidence_saver: {
    key: "negative_evidence_saver", title: "Negative-evidence cost saver", earliestAssistanceRank: 2,
    facets: {
      source_rights: "verified records (MLS status, recorded sale, our own transaction rows), the person's own words (opt-out, no-interest, a newer statement) and public pages Exa surfaces (an active listing with another brokerage)",
      territorial_purpose: "open seller / buyer theories inside the tenant's territories (movement_signals with a property address; leads)",
      producer: "lib/intent/movement-signals.ts recordMovementOutcome + leads.ai_outreach_paused + the bus (data_steward → ai_isa negative_evidence_verdict)",
      ingestion: "no new row: the verdict closes or pauses what exists",
      evidence: "the contrary fact with its class (verified / reported / inferred), its date and its source; only evidence NEWER than the theory's latest positive contradicts it",
      freshness: "a contrary fact older than the newest positive is history, not a contradiction (lib/intent/moving-moments.ts rule 3)",
      dedup: "recordMovementOutcome is ledgered once per signal; the bus signal dedupes per open (to, type, entity)",
      arbiter_decision: "stop (explicit no-interest; a recorded sale or an active listing under another agent on a seller theory) · hold (a newer contrary statement) · verify (a changed address; inferred-only evidence never stops) · lower priority",
      activation: "none — the play REMOVES outreach and research; it never adds a touch",
      assistance: "saved spend and a person left alone who asked to be",
      outcome_attribution: "the recorded outcome (listed / moved / opted_out / declined) grades the theory's forecasts; the saved research is visible as the absence of a paid call",
      failure_recovery: "a refused update is said (counted rows); a refused ledger claim is a refusal, never 'already recorded'",
    },
    endsIn: ["recordMovementOutcome", "publishManagerSignal"],
    negativeControl: "with no contrary evidence nothing is paused, closed or published; an OLDER contrary fact changes nothing; a stop verdict makes NO ingest, NO enrichment and NO dispatch",
  },
  public_request_assist: {
    key: "public_request_assist", title: "Publicly expressed real-estate questions and requests", earliestAssistanceRank: 3,
    facets: {
      source_rights: "public_web (Exa → page terms) + the page CLASS: a person is discovered only where the class permits using the contact point the author published (classified 'wanted', owner-published listing); forums and news never yield a person",
      territorial_purpose: "queries rendered for the tenant's territory (city, state); records carry the territory's geography and pass the producer's territory gate",
      producer: "THE ONE RawData producer (ingestRawSourceBatch) — subject person (a first-person request with a published contact) or anonymous_question (everything else)",
      ingestion: "source exa_buyer_intent (the one Exa SourceKey), sourceSubtype public_request_assist, actor research, external event id exa:<result id>",
      evidence: "the verbatim request sentence (quote), the URL, the published date, the publisher, the identity basis and the consent basis",
      freshness: "90 days, and a request with no published date is not current",
      dedup: "the C35 idempotency key (exa:<result id>); a page that matches an EXISTING Contact by its published email / phone goes to the arbiter instead of a new row",
      arbiter_decision: "a person: Raw Lead → the EXISTING promotion gate → AI ISA; an anonymous question: the topic pass (lib/content-intel/topic-themes.ts) turns it into a cited inbound resource; an existing Contact: respondToLifeChangeSignal",
      activation: "answer through the contact point the person published, or publish the answer as an inbound resource — never a message in the channel",
      assistance: "an answer to the exact question asked",
      outcome_attribution: "the raw row's lineage (raw → lead → contact) and the arbiter's ledger row",
      failure_recovery: "no provider key → provider_unconfigured, zero rows; a refused insert is counted (skipped_refused), never 'duplicate'",
    },
    endsIn: ["ingestRawSourceBatch", "respondToLifeChangeSignal"],
    negativeControl: "a handle-only or name-only poster is never deanonymized (anonymous_question, no author rides); the module contains no outbound dispatch; a stale request is dropped",
  },
  property_candidate_queue: {
    key: "property_candidate_queue", title: "FSBO / public relocation / probate-permitted filings → property-level candidate queue", earliestAssistanceRank: 4,
    facets: {
      source_rights: "public_web via Exa; the page class is RECORDED on each row (owner_published_listing, official_record, news); a probate notice is stored only from an official-record page",
      territorial_purpose: "the tenant's territory (city/state/zip) — the producer's territory gate drops an out-of-territory address",
      producer: "THE ONE RawData producer — subject property (FSBO), entity_trust_estate (an estate named in an official notice), job_civic_event (a business relocation); owner ONLY when verifyOwnership verifies",
      ingestion: "source exa_buyer_intent, sourceSubtype property_candidate_queue, scrape category motivated_seller, actor research",
      evidence: "address, asking price, whether the owner published a contact point (kept in the payload, never as a person column), the quoted basis, the URL and date; evidence.ownership from verifyOwnership",
      freshness: "FSBO 120 days (listing TTL), notices 180 days",
      dedup: "C35 idempotency key; identity keys (address / APN / entity) ride external_ids for the C36 dedup",
      arbiter_decision: "property-level: the candidate queue for correctly LICENSED acquisition tools (the investor off-market runner, the planner's hunting lines); a residential seller intent is never inferred from a filing",
      activation: "none on the property alone; a person row exists only after ownership is verified through records",
      assistance: "an owner who published a FSBO listing may be offered what they asked for (buyers, pricing help) — through the published channel, by the gated path",
      outcome_attribution: "raw lineage + the investor / planner tools' own ledgers",
      failure_recovery: "a name-only owner join is refused and said; an unverified ownership stays property; a notice without an address is not viable",
    },
    endsIn: ["ingestRawSourceBatch"],
    negativeControl: "a single public page naming an owner never becomes an owner row (name-only join refused); a probate notice from a news page is dropped; an estate row carries targeting_prohibited",
  },
  moving_corridor_radar: {
    key: "moving_corridor_radar", title: "Moving-corridor early radar (employer growth × commute corridor × inventory gap)", earliestAssistanceRank: 5,
    facets: {
      source_rights: "public_web (news pages, cited excerpt only) + licensed_vendor market aggregates already held (the market twin's stored RentCast reading — no provider read)",
      territorial_purpose: "announcements in the tenant's territory state; coverage = the territory's own zips (commute minutes are NOT computed — no routing provider)",
      producer: "THE ONE RawData producer for the cited job_civic_event rows; publishManagerSignal (data_steward → campaign_orchestrator corridor_radar_brief) for the brief; produceMarketReport + createLeadMagnet (draft) when activated",
      ingestion: "source exa_buyer_intent, sourceSubtype moving_corridor_radar, external event id exa:<result id>",
      evidence: "employer, event type, announced location and headcount AS ANNOUNCED, start date, each with its citation; claim boundary: announcement + coverage only — no worker is assumed to move, no person is identified",
      freshness: "120 days (early radar); older announcements are dropped and counted",
      dedup: "one announcement per (employer, event type) across its pages; one open brief per (territory, announcement); the C35 key per page",
      arbiter_decision: "none for a person — market-level evidence produces education + an opt-in invitation (the local buyer resource and the inbound magnet)",
      activation: "a cited local guide (market report) and a DRAFT lead magnet a human publishes; market-level rows never reach the Lead door",
      assistance: "a relocating household finds the local guide when THEY search; nobody is contacted",
      outcome_attribution: "magnet captures (consented, C8) and the report's ledger row",
      failure_recovery: "no key → provider_unconfigured; a twin read refused → the gap is 'unknown' and said; no agent on the territory → brief only, no magnet",
    },
    endsIn: ["ingestRawSourceBatch", "publishManagerSignal", "produceMarketReport", "createLeadMagnet"],
    negativeControl: "a market-level event creates NO person row and NO Lead (every row is job_civic_event; subjectKindLeadProblem refuses it); a page naming an executive does not make them a lead",
  },
})

/** The ONE Exa SourceKey (the ledger's usage_type on every Exa row — historical spelling kept, lib/lead-pipeline/exa-sourcer.ts). */
export const EXA_PLAY_SOURCE = "exa_buyer_intent"
export const EXA_PLAY_CHANNEL = "exa"
/** raw_scraped_leads.producer_actor_type 'research' (C35 vocabulary) — the row says which door it came in. */
export const PLAY_ACTOR = Object.freeze({ type: "research", id: "early_opportunity_plays" } as const)

// ── IDENTITY RULES ───────────────────────────────────────────────────────────

export type IdentityBasis = "record_key" | "verified_match" | "published_contact" | "handle_only" | "name_only" | "none"

export interface PersonCandidate {
  statement: { firstPerson: boolean; requestsAgentContact: boolean; quote: string | null }
  identity: { basis: IdentityBasis; email?: string | null; phone?: string | null; handle?: string | null; name?: string | null }
  rights: Pick<SourceRights, "publishedContactPermitted" | "sourceClass">
  publishedAt: string | null
}

/** A public request is current for this long; after that it is a question the market once asked, not a person asking now. */
export const PUBLIC_REQUEST_MAX_AGE_DAYS = 90

/** PURE — why a public statement may NOT become a person row (null = it may). Every refusal names its rule. */
export function personCandidateProblem(c: PersonCandidate, now: Date): string | null {
  if (!c.statement.firstPerson) return "not a first-person statement — a third party's mention of someone never identifies them"
  if (!c.statement.requestsAgentContact) return "the author asked no agent to contact them — a question is answered, not pursued"
  if (!c.statement.quote) return "no verbatim quote — a request is never inferred without the author's own words"
  const nameOnly = nameOnlyJoinProblem(c.identity.basis)
  if (nameOnly) return nameOnly
  if (c.identity.basis === "handle_only") return "a handle alone identifies nobody — an anonymous poster is never deanonymized"
  if (c.identity.basis === "none") return "no identity the person published or a verified record key"
  if (c.identity.basis === "published_contact") {
    if (!c.rights.publishedContactPermitted) return `a ${c.rights.sourceClass} page's terms do not permit using a member's contact point — answered through our own inbound resource instead`
    if (!c.identity.email && !c.identity.phone) return "published_contact claimed with no email or phone"
  }
  const fresh = freshnessProblem({ publishedAt: c.publishedAt }, PUBLIC_REQUEST_MAX_AGE_DAYS, now, { requireDate: true })
  if (fresh) return fresh
  return null
}

/** PURE — a name alone never joins two records (a page to a person, a property to an owner). */
export function nameOnlyJoinProblem(basis: IdentityBasis | "name_only" | string): string | null {
  return basis === "name_only" ? "a name alone never joins two records — the same name is often a different person; a verified record key or a published contact point is required" : null
}

// ── RESULTS ──────────────────────────────────────────────────────────────────

export type PlayActionKind =
  | "ingest_evidence" | "ingest_person" | "ingest_property" | "manager_signal" | "market_report" | "lead_magnet_draft"
  | "movement_signal" | "arbiter" | "movement_outcome" | "outreach_paused" | "hold" | "none"

export interface PlayAction { kind: PlayActionKind; target: string; detail: Record<string, unknown> }

export interface PlayResult {
  play: PlayKey
  status: "acted" | "nothing_found" | "provider_unconfigured" | "refused"
  evidence: GroundedEvidence[]
  actions: PlayAction[]
  refused: Array<{ what: string; why: string }>
  /** Published beside the result — what this run could not see (CLAUDE.md §2). */
  blindSpots: string[]
  costUsd: number
}

export function emptyResult(play: PlayKey, status: PlayResult["status"], blindSpots: string[] = []): PlayResult {
  return { play, status, evidence: [], actions: [], refused: [], blindSpots, costUsd: 0 }
}

export type EvidenceSubject = Extract<RawDataSubjectKind, "job_civic_event" | "anonymous_question" | "market">

/**
 * PURE — a cited EVIDENCE record for THE ONE producer (an identity-free observation: no author, name, handle, email or
 * phone rides it). The subject kind is stated on the envelope so the Lead door refuses it (canary 8).
 */
export function evidenceRecord(a: {
  subject: EvidenceSubject
  evidence: GroundedEvidence
  market: { city: string | null; state: string | null }
  play: PlayKey
  evidenceClass: EvidenceClass
  rights: SourceRights
  tags?: readonly string[]
  extracted?: Record<string, unknown> | null
  side?: "buyer" | "seller" | "unknown"
}): NormalizedScrapedRecord {
  const e = a.evidence
  return {
    sourceRecordId: `exa-${e.resultId}`,
    source: EXA_PLAY_SOURCE,
    behaviorType: "market_research",
    intentType: a.side ?? "unknown",
    intentSignals: Array.from(new Set([a.subject, "early_opportunity", a.play, ...(a.tags ?? [])])),
    city: a.market.city,
    state: a.market.state,
    sourceUrl: e.sourceUrl,
    rawPayload: {
      id: e.resultId, url: e.sourceUrl, title: e.title, published: e.publishedAt, publisher: e.publisher,
      excerpt: e.quotedBasis, extracted: a.extracted ?? null, source_class: a.rights.sourceClass,
    },
    envelope: {
      subjectKind: a.subject,
      externalEventId: `exa:${e.resultId}`,
      proofUrls: [e.sourceUrl],
      evidence: {
        play: a.play,
        evidence_class: a.evidenceClass,
        citation: { url: e.sourceUrl, title: e.title, publisher: e.publisher, published: e.publishedAt, retrieved_at: e.retrievedAt },
        quoted_basis: e.quotedBasis,
        source_class: a.rights.sourceClass,
        source_terms: a.rights.termsNote,
        claim_boundary: a.subject === "job_civic_event"
          ? "a public announcement and its geographic coverage — no worker is assumed to move and no person is identified"
          : a.subject === "anonymous_question"
            ? "a public question — answered through an inbound resource; the poster is never deanonymized or messaged in the channel"
            : "a market-level observation — education and opt-in invitations, never a personal lead",
      },
    },
  }
}
