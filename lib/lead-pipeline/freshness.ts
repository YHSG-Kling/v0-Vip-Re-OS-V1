// lib/lead-pipeline/freshness.ts
//
// THE FRESHNESS POLICY PER SIGNAL TYPE (wave 151, lane 151C). PURE: no client, no `server-only`, no clock of its own
// (every function takes `now`), so the producer, the pipeline, the planner and the proof import the same rule.
//
// Owner, verbatim (wave 151): "lead acquisitions should be checking how old the activity is because you don't want to
// bring in old and stale data." Directive 151C: "Use different freshness policies for different signal types. A social
// post about moving last week is not equivalent to a seven-year-old article. An old deed transfer may be useful property
// history but not a fresh intention to move. Do not acquire stale leads simply because a list provider returned them."
//
// SURVIVORS THIS EXTENDS (LAW 1 — none is replaced, each is named):
//   · the per-SOURCE client window — source-intent-map.ts SOURCE_RECENCY / recencyWindowForSource (wave 91): one number
//     per source, applied at the producer's Gate 1b. It knows the source, not the SIGNAL: a BatchData owner record carries
//     `windowDays: null` because the deed date is not the activity date, and a scraped post is judged by one 60-day
//     window whatever it says. This file keeps that window as a CEILING (a narrower source window still narrows) and adds
//     the signal class, the anchor (which date counts), the history verdict and the hold;
//   · the per-subject TTL — raw-record-types.ts RAWDATA_TTL_DAYS (C35): how long an observation answers. Read here as
//     `ttlExpiresAt`; an expired TTL is a hold ("re-observe before any spend");
//   · the OSINT filing window — osint-sourcer.ts OSINT_FILING_MAX_AGE_DAYS (60: "pre-foreclosure data 30-60 days old
//     has already been worked") — the public_record_filing policy below carries the SAME number, and the proof holds the
//     two equal;
//   · lead ENRICHMENT freshness — lib/enrichment/lead-freshness.ts (a lead's re-buy window). A different question
//     ("did we already buy this person's profile recently?"); it stays where it is.
//
// WHAT IS A HOLD. A stale, contradicted, TTL-expired or history-only observation is HELD with its reason — never bought
// (planner), never enriched (pipeline: processing_status 'held_stale', m967), never pretended fresh. Holding is not
// deletion: the observation stays at its evidence level (an old deed is property history; a dead listing is a listing
// fact). An UNDATED observation is KEPT at a 0.5 score — the owner's wave-91 rule ("nothing proves it stale") — and the
// planner's blind spot says how many were undated.
//
// These are OPERATIONAL windows, owner-tunable, never an outreach schedule and never a legal retention rule.

import { resolveSourceKey, SOURCE_MAP, SOURCE_RECENCY, DEFAULT_ACQUISITION_RECENCY_DAYS, type SourceKey } from "./source-intent-map"

/** One vocabulary — raw_scraped_leads.freshness_verdict CHECK (m967) holds the same words.
 *  @proofSeam scripts/acquisition-door-guard.ts holds this equal to the m967 CHECK (and scripts/check-vocabulary-guard.ts
 *  MIRRORS once m967 is applied); the product reader is isFreshnessVerdict below (lib/lead-pipeline/pipeline-processor.ts). */
export const FRESHNESS_VERDICTS = ["fresh", "aging", "stale", "history", "undated", "contradicted"] as const
export type FreshnessVerdict = (typeof FRESHNESS_VERDICTS)[number]

/** The SIGNAL classes — what kind of event or fact an observation reports. Each has its own policy. */
const SIGNAL_CLASSES = [
  "expressed_intent_post",  // a person's own words about moving / buying / selling (social, forum, wanted ad)
  "anonymous_question",     // a public question with no stated identity (review / community question)
  "listing_status_event",   // a listing appeared / expired / was withdrawn / dropped its price (FSBO, portal, expired)
  "public_record_filing",   // a recorder / court filing (pre-foreclosure, lis pendens, tax lien, probate, divorce …)
  "ownership_transfer",     // a deed / sale recorded — property HISTORY once it is old, never a fresh intention
  "permit_civic_event",     // a permit or civic / job event tied to a place
  "market_article",         // a cited market-level fact (evidence-only subject)
  "owner_profile_pull",     // an owner / property record bought from a list vendor (a standing population)
  "investor_population",    // a cash-buyer / buy-box population (standing)
  "first_party_behavior",   // the tenant's own observed behaviour (site dwell, own email engagement, own inbox)
  "verified_relationship",  // a verified owner ↔ person relationship
] as const
export type SignalClass = (typeof SIGNAL_CLASSES)[number]

type FreshnessAnchor = "signal_at" | "observed_at" | "last_verified_at"

export interface FreshnessPolicy {
  signalClass: SignalClass
  /** Which date the age is measured from. An EVENT ages from its own date; a PULLED record ages from its verification. */
  anchor: FreshnessAnchor
  /** ≤ freshDays → fresh. */
  freshDays: number
  /** ≤ staleDays → aging; beyond → `beyondStale`. */
  staleDays: number
  /** What an observation older than staleDays IS: stale INTENT (hold), or property / place HISTORY (kept as evidence, held for intent spend). */
  beyondStale: "stale" | "history"
  /** How often the source itself refreshes this kind of signal (days); null = a live / event feed. */
  updateCadenceDays: number | null
  /** An observation with no anchor date: "kept" (the wave-91 rule — scored 0.5) or "hold". */
  undated: "kept" | "hold"
  why: string
}

/** The OSINT filing window this file agrees with (osint-sourcer.ts OSINT_FILING_MAX_AGE_DAYS — the proof holds them equal). */
const FILING_STALE_DAYS = 60

/** @proofSeam scripts/acquisition-door-guard.ts reads the anchors / windows directly; the product readers are
 *  evaluateFreshness and expectedSourceFreshness below (the producer, the pipeline, the planner, pre-pull-dedup). */
export const FRESHNESS_POLICIES: Readonly<Record<SignalClass, FreshnessPolicy>> = Object.freeze({
  expressed_intent_post: { signalClass: "expressed_intent_post", anchor: "signal_at", freshDays: 14, staleDays: DEFAULT_ACQUISITION_RECENCY_DAYS, beyondStale: "stale", updateCadenceDays: null, undated: "kept",
    why: "a post about moving last week is fresh; the same words two months on describe a different moment in that person's life" },
  anonymous_question: { signalClass: "anonymous_question", anchor: "signal_at", freshDays: 14, staleDays: DEFAULT_ACQUISITION_RECENCY_DAYS, beyondStale: "stale", updateCadenceDays: null, undated: "kept",
    why: "a question goes unanswered or answered within weeks; an old one is a topic, not a person to help now" },
  listing_status_event: { signalClass: "listing_status_event", anchor: "signal_at", freshDays: 30, staleDays: 120, beyondStale: "stale", updateCadenceDays: 1, undated: "kept",
    why: "a listing that expired or dropped its price is a seller decision in motion for weeks, not seasons (RAWDATA_TTL_DAYS listing = 120)" },
  public_record_filing: { signalClass: "public_record_filing", anchor: "signal_at", freshDays: 30, staleDays: FILING_STALE_DAYS, beyondStale: "stale", updateCadenceDays: 7, undated: "kept",
    why: "pre-foreclosure data 30-60 days old has already been worked by every list buyer (osint-sourcer.ts OSINT_FILING_MAX_AGE_DAYS)" },
  ownership_transfer: { signalClass: "ownership_transfer", anchor: "signal_at", freshDays: 90, staleDays: 365, beyondStale: "history", updateCadenceDays: 30, undated: "kept",
    why: "a deed recorded this quarter says who just arrived; an old deed is property history, not a fresh intention to move" },
  permit_civic_event: { signalClass: "permit_civic_event", anchor: "signal_at", freshDays: 45, staleDays: 180, beyondStale: "history", updateCadenceDays: 7, undated: "kept",
    why: "a permit precedes a sale by weeks to months (permit-sourcer.ts PERMIT_SOURCER_LOOKBACK_DAYS = 45); after that it is a fact about the house" },
  market_article: { signalClass: "market_article", anchor: "signal_at", freshDays: 30, staleDays: 180, beyondStale: "stale", updateCadenceDays: null, undated: "kept",
    why: "a market fact answers for a month (RAWDATA_TTL_DAYS market = 30); a seven-year-old article answers nothing about today" },
  owner_profile_pull: { signalClass: "owner_profile_pull", anchor: "last_verified_at", freshDays: 90, staleDays: 365, beyondStale: "stale", updateCadenceDays: 30, undated: "kept",
    why: "an owner record ages from when the vendor last verified it, never from the deed date — long tenure is the signal, not a stale one" },
  investor_population: { signalClass: "investor_population", anchor: "last_verified_at", freshDays: 90, staleDays: 365, beyondStale: "stale", updateCadenceDays: 30, undated: "kept",
    why: "a cash-buyer population is standing; it is re-verified, not re-dated" },
  first_party_behavior: { signalClass: "first_party_behavior", anchor: "signal_at", freshDays: 30, staleDays: 90, beyondStale: "stale", updateCadenceDays: null, undated: "kept",
    why: "the tenant's own observed behaviour is live; three months of silence is a different state" },
  verified_relationship: { signalClass: "verified_relationship", anchor: "last_verified_at", freshDays: 365, staleDays: 730, beyondStale: "stale", updateCadenceDays: null, undated: "kept",
    why: "a verified owner ↔ person relationship holds for a year before it must be re-verified" },
})

/** The DEFAULT class per source — typed over SourceKey so a new source cannot ship without a freshness policy. */
const SOURCE_SIGNAL_CLASS: Readonly<Record<SourceKey, SignalClass>> = Object.freeze({
  zenrows_zillow: "listing_status_event", zenrows_realtor: "listing_status_event", zenrows_homes: "listing_status_event",
  craigslist_fsbo: "listing_status_event", facebook_marketplace: "listing_status_event", rental_listing: "listing_status_event",
  fsbo_site_listing: "listing_status_event", expired_listing: "listing_status_event",
  nextdoor_intent: "expressed_intent_post", facebook_group: "expressed_intent_post", instagram_intent: "expressed_intent_post",
  reddit_intent: "expressed_intent_post", reddit_relocation: "expressed_intent_post", craigslist_wanted: "expressed_intent_post",
  linkedin_relocation: "expressed_intent_post", google_phrase_intent: "expressed_intent_post", agent_seeking_phrase_intent: "expressed_intent_post",
  facebook_recommend_realtor: "expressed_intent_post", realty_site_chatter: "expressed_intent_post", new_construction_intent: "expressed_intent_post",
  tavily_intent: "expressed_intent_post", exa_buyer_intent: "expressed_intent_post", external_behavior: "expressed_intent_post",
  review_acquisition_intent: "anonymous_question",
  permit_prelisting_intent: "permit_civic_event",
  osint_signal: "public_record_filing",
  batchdata_motivated: "owner_profile_pull", batchdata_smart_search: "owner_profile_pull",
  batchdata_cash_buyer: "investor_population", batchdata_buybox: "investor_population",
  site_visitor_intent: "first_party_behavior", email_engagement_intent: "first_party_behavior",
  inbound_email_unknown: "first_party_behavior", rental_to_buyer_graduation: "first_party_behavior",
})

/** Trigger / behaviour tokens that REFINE the class (a BatchData pull stamps every quickList the parcel is on). */
const FILING_TOKENS = new Set(["pre_foreclosure", "foreclosure", "lis_pendens", "notice_of_default", "tax_lien", "involuntary_lien", "probate", "divorce", "bankruptcy", "auction", "eviction", "code_violation", "tax_delinquent"])
const LISTING_TOKENS = new Set(["expired", "expired_listing", "canceled_listing", "failed_listing", "price_reduced", "withdrawn", "fsbo", "fsbo_listing", "listing_expired"])
const TRANSFER_TOKENS = new Set(["sold", "deed", "deed_transfer", "ownership_transfer", "sale_recorded", "quitclaim", "recent_sale", "new_owner"])

export interface SignalDescriptor {
  source: string
  behaviorType?: string | null
  intentSignals?: readonly string[] | null
  subjectKind?: string | null
}

/**
 * PURE — the signal class of one observation. The subject kind wins for the evidence-only subjects (a market article
 * is a market article whichever feed carried it); the trigger / behaviour tokens refine a vendor pull (a parcel on the
 * pre-foreclosure list is a FILING, a parcel on the expired list a LISTING EVENT, a recent sale a TRANSFER); otherwise the
 * source's default. An unregistered source is judged as an expressed-intent post (fail toward recent, never toward stale).
 */
function classifySignal(d: SignalDescriptor): SignalClass {
  if (d.subjectKind === "market") return "market_article"
  if (d.subjectKind === "anonymous_question") return "anonymous_question"
  if (d.subjectKind === "job_civic_event") return "permit_civic_event"
  const tokens = new Set([...(d.intentSignals ?? []), d.behaviorType ?? ""].map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean))
  if ([...tokens].some((t) => TRANSFER_TOKENS.has(t))) return "ownership_transfer"
  if ([...tokens].some((t) => FILING_TOKENS.has(t))) return "public_record_filing"
  if ([...tokens].some((t) => LISTING_TOKENS.has(t))) return "listing_status_event"
  const key = resolveSourceKey(d.source)
  return key in SOURCE_MAP ? SOURCE_SIGNAL_CLASS[key] : "expressed_intent_post"
}

export interface FreshnessInput extends SignalDescriptor {
  /** The activity's own date (raw-record-types.ts recordSignalDate → raw_scraped_leads.signal_at). */
  signalAt: string | null
  /** When the producer first observed it (raw_scraped_leads.observed_at / created_at). */
  observedAt: string | null
  /** When a source most recently re-confirmed it (raw_scraped_leads.last_verified_at, m967; a replay bumps it). */
  lastVerifiedAt?: string | null
  /** raw_scraped_leads.ttl_expires_at (C35). Past it, the observation must be re-observed before any spend. */
  ttlExpiresAt?: string | null
  /** False when the event is known to be over (the listing relisted / sold, the filing released). */
  stillActive?: boolean | null
  /** Newer evidence that contradicts the signal (a later "we are staying" post, a later sale). */
  contradictedAt?: string | null
  /** False when the observation sits outside the territory — weighs the score; the territory GATE owns the refusal. */
  territoryRelevant?: boolean | null
  /** The source's own client window (source-intent-map.ts SOURCE_RECENCY) — a NARROWER window than the policy's still narrows. */
  sourceWindowDays?: number | null
  now?: Date | number
}

export interface FreshnessAssessment {
  verdict: FreshnessVerdict
  signalClass: SignalClass
  policy: string
  anchor: FreshnessAnchor | null
  anchorAt: string | null
  ageDays: number | null
  /** 1 = brand-new, 0 = beyond stale; an undated observation reads 0.5. */
  score: number
  /** HOLD before any spend (purchase, enrichment, promotion). The reason names the policy. */
  hold: boolean
  holdReason: string | null
  /** The observation still supports a CURRENT intention (false for history / stale / contradicted). */
  intentFresh: boolean
  /** The observation is property / place HISTORY — kept as evidence, never read as intent. */
  propertyHistory: boolean
  why: string
}

const DAY_MS = 86_400_000
const parseMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * PURE — the freshness of ONE observation under its signal class's policy. The anchor date is the policy's: an event
 * ages from its own date (signal_at); a pulled record ages from its latest verification (last_verified_at, else
 * observed_at). Contradiction and TTL are read first; then the age against the policy (narrowed by the source window).
 */
export function evaluateFreshness(input: FreshnessInput): FreshnessAssessment {
  const nowMs = input.now instanceof Date ? input.now.getTime() : typeof input.now === "number" ? input.now : Date.now()
  const signalClass = classifySignal(input)
  const policy = FRESHNESS_POLICIES[signalClass]
  const anchorAt: string | null =
    policy.anchor === "signal_at" ? input.signalAt ?? null
    : input.lastVerifiedAt ?? input.observedAt ?? null
  const anchor: FreshnessAnchor | null = anchorAt === null ? null
    : policy.anchor === "signal_at" ? "signal_at"
    : input.lastVerifiedAt ? "last_verified_at" : "observed_at"
  const anchorMs = parseMs(anchorAt)
  const ageDays = anchorMs === null ? null : Math.max(0, (nowMs - anchorMs) / DAY_MS)
  const relevance = input.territoryRelevant === false ? 0.5 : 1
  const base = (verdict: FreshnessVerdict, score: number, hold: boolean, holdReason: string | null, intentFresh: boolean, propertyHistory: boolean, why: string): FreshnessAssessment => ({
    verdict, signalClass, policy: `${signalClass}@fresh${policy.freshDays}/stale${policy.staleDays}`, anchor, anchorAt, ageDays: ageDays === null ? null : round2(ageDays),
    score: round2(Math.max(0, Math.min(1, score * relevance))), hold, holdReason, intentFresh, propertyHistory,
    why: input.territoryRelevant === false ? `${why} · outside the territory (the territory gate owns refusal; weighed ×0.5 here)` : why,
  })

  // 1. Contradiction — newer evidence or a known-over event outranks any age.
  if (input.stillActive === false) {
    return base("contradicted", 0, true, "the event is no longer active (newer evidence says so) — held, never bought or enriched on this signal", false, false,
      `${signalClass}: the event is over — the observation is kept as evidence, not as intent`)
  }
  const contradictedMs = parseMs(input.contradictedAt)
  if (contradictedMs !== null && (anchorMs === null || contradictedMs > anchorMs)) {
    return base("contradicted", 0, true, "newer contradictory evidence outranks this signal — held with the contradiction, never bought", false, false,
      `${signalClass}: contradicted by newer evidence (${input.contradictedAt})`)
  }
  // 2. The C35 answer window (ttl_expires_at). A lapsed TTL holds — but the AGE verdict below names the better reason when
  //    the observation is already beyond its policy (an old deed is property history first; the TTL is incidental).
  const ttlMs = parseMs(input.ttlExpiresAt)
  const ttlLapsed = ttlMs !== null && ttlMs < nowMs
  const ttlHold = (verdict: FreshnessVerdict, history: boolean, detail: string) =>
    base(verdict, 0, true, "the observation's TTL has lapsed — re-observe before any spend", false, history, `${signalClass}: ttl_expires_at ${input.ttlExpiresAt} is past — ${detail}`)
  // 3. Undated — the wave-91 rule: nothing proves it stale; kept at 0.5 (a policy may say hold; a lapsed TTL still holds).
  if (ageDays === null) {
    if (ttlLapsed) return ttlHold(policy.beyondStale === "history" ? "history" : "stale", policy.beyondStale === "history", "undated, and its answer window has lapsed")
    const hold = policy.undated === "hold"
    return base("undated", 0.5, hold, hold ? `an undated ${signalClass.replace(/_/g, " ")} cannot be judged fresh under its policy — held` : null, !hold, false,
      `${signalClass}: no ${policy.anchor} to judge — kept at 0.5 (published blind spot: the gate can only date what the payload dates)`)
  }
  // 4. Age against the policy, narrowed by the source's own window when that is tighter.
  const staleDays = typeof input.sourceWindowDays === "number" && input.sourceWindowDays > 0 ? Math.min(policy.staleDays, input.sourceWindowDays) : policy.staleDays
  const freshDays = Math.min(policy.freshDays, staleDays)
  if (ageDays <= freshDays) {
    if (ttlLapsed) return ttlHold(policy.beyondStale === "history" ? "history" : "stale", policy.beyondStale === "history", `young by age (${round2(ageDays)} days) but its answer window has lapsed`)
    return base("fresh", 1 - 0.3 * (ageDays / Math.max(1, freshDays)), false, null, true, false,
      `${signalClass}: ${round2(ageDays)} days old ≤ ${freshDays} fresh days — ${policy.why}`)
  }
  if (ageDays <= staleDays) {
    if (ttlLapsed) return ttlHold(policy.beyondStale === "history" ? "history" : "stale", policy.beyondStale === "history", `aging (${round2(ageDays)} days) and its answer window has lapsed`)
    const t = (ageDays - freshDays) / Math.max(1, staleDays - freshDays)
    return base("aging", 0.7 - 0.5 * t, false, null, true, false,
      `${signalClass}: ${round2(ageDays)} days old — aging (fresh ≤ ${freshDays}, stale > ${staleDays})`)
  }
  if (policy.beyondStale === "history") {
    return base("history", 0, true, `a ${round2(ageDays)}-day-old ${signalClass.replace(/_/g, " ")} is property history, not a fresh intention — held for intent spend, kept as evidence`, false, true,
      `${signalClass}: ${round2(ageDays)} days old > ${staleDays} — ${policy.why}`)
  }
  return base("stale", 0, true, `a ${round2(ageDays)}-day-old ${signalClass.replace(/_/g, " ")} is stale under its policy (> ${staleDays} days) — held, never bought or enriched`, false, false,
    `${signalClass}: ${round2(ageDays)} days old > ${staleDays} — ${policy.why}`)
}

/**
 * PURE — the freshness a planner may EXPECT from a source before pulling it (no record in hand yet): a live / event feed
 * delivers at the moment of the event (high); a standing population re-verified every `updateCadenceDays` is, on average,
 * half a cadence old. Returned with the policy name so the plan line can say which rule it rode.
 */
export function expectedSourceFreshness(source: string, now?: Date | number): { factor: number; signalClass: SignalClass; policy: string; why: string } {
  const signalClass = classifySignal({ source })
  const p = FRESHNESS_POLICIES[signalClass]
  const windowDays = SOURCE_RECENCY[resolveSourceKey(source) as SourceKey]?.windowDays ?? null
  const midAge = p.updateCadenceDays === null ? 0 : p.updateCadenceDays / 2
  const a = evaluateFreshness({ source, signalAt: new Date((now instanceof Date ? now.getTime() : now ?? Date.now()) - midAge * DAY_MS).toISOString(), observedAt: null, lastVerifiedAt: new Date((now instanceof Date ? now.getTime() : now ?? Date.now()) - midAge * DAY_MS).toISOString(), sourceWindowDays: windowDays, now })
  return { factor: a.score, signalClass, policy: a.policy, why: p.updateCadenceDays === null ? "a live / event feed — fresh at the moment of the event" : `re-verified every ${p.updateCadenceDays} days — on average half a cadence old` }
}

/** The m967 column vocabulary, as a type guard for readers of raw_scraped_leads.freshness_verdict. */
export function isFreshnessVerdict(v: unknown): v is FreshnessVerdict {
  return typeof v === "string" && (FRESHNESS_VERDICTS as readonly string[]).includes(v)
}
