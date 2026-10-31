// lib/intent/movement-signals.ts
//
// REAL ESTATE LIFE & MOVEMENT SIGNALS — contract C9 (wave 147, lane 147B; owner rulings 3 + 4, 2026-10-31).
//
//   person / property → source → evidence → observed_at → confidence (verified | reported | inferred | unknown)
//     → event_relevance → next_appropriate_action (research | offer_help | wait | human) → outcome
//
// THE NEEDLE IN THE HAYSTACK, LAWFULLY. A single keyword is never a move. A family that will list in nine months leaves small,
// independent traces — a seller net-proceeds calculation in their portal, a street-use permit for a dumpster, a public "can anyone
// recommend an agent?" post, a new job in another metro on their licensed profile. Each trace is recorded here as ONE typed C9
// record that says how we know it (the epistemic class is enforced in the TYPE: an inferred record cannot carry a verification
// reference, and its label can never read as a fact), the source's licence / consent / outreach posture is stamped AT THE RECORD,
// and then the traces are COMBINED (scoreMovementCombination — corroboration across independent source kinds, recency decay, a
// single source capped, the score explaining itself line by line). The manager / arbiter chooses what to do
// (decideMovementNextAction — an expert, structured prompt over a CLOSED menu the policy computed; AI explains, deterministic
// services calculate and gate) and the outcome closes the loop (recordMovementOutcome → movementSourceWeights).
//
// SURVIVORS (LAW 1 / LAW 2 — this module composes, it does not re-implement):
//   sources        lib/intent/movement-source-registry.ts (composed from INTENT_SIGNAL_SOURCES, SOURCE_MAP, the first-party tables)
//   the responder  lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal (READ ONLY here — lane 147G owns it), routeToAgent
//   the bus        lib/kernel/manager-signals.ts publishManagerSignal → `online_intent_detected` (Data Steward → AI ISA, HANDLED by the
//                  ONE life-change responder — lib/kernel/signal-registry.ts); no new signal_type is minted
//   party (C2)     lib/contact-promotion/lead-domain-boundary.ts canonicalPartyFor
//   evidence       lib/kernel/action-ledger.ts withActionLedger (intent.movement_signal.record / .decide / .outcome)
//   model          lib/ai/models.ts generateObjectRouted (features `followup_arbitration`, `behavioral_pattern_detect` — booked)
//   who sees raw   lib/auth/lead-visibility.ts LEAD_DESK_USER_TYPES (and m892's RLS: public.is_lead_visible_role())
//   protected      lib/lead-governance/protected-class-signals.ts protectedClassReasonFor (the ONE classifier)
//   policy window  lib/ai-isa/followup-policy.ts loadFollowupPolicy (sphere.lifeEventWindowDays — no window invented here)
//
// PRIVACY, AT THE RECORD (not the reader): no intimate inference from private behaviour (a divorce / probate can only be a public
// record or the person's own disclosure — an inferred one is REFUSED, and m892 refuses it again in the database); a third party's
// claim about a named person's intimate life is refused; a source whose terms forbid automated capture refuses an automated
// record; a source not permitted on standard terms refuses entirely. Protected proxies are STORED (ruling 2: research is
// purpose-controlled, never dropped) and flagged `targeting_prohibited` — movementAudienceEligible refuses them for any audience.
//
// NOT server-only: simulator-driven (scripts/movement-signals-guard.ts) like the kernel modules it composes.

import type { IntentKind } from "@/lib/enrichment/intent-signal-sources"
import type { ObservedIntentSignal } from "@/lib/enrichment/intent-signal-sources"
import type { LifeChangeKind, LifeChangeSignal } from "@/lib/ai-isa/followup-arbiter"
import { canonicalPartyFor } from "@/lib/contact-promotion/lead-domain-boundary"
import { protectedClassReasonFor } from "@/lib/lead-governance/protected-class-signals"
import { LEAD_DESK_USER_TYPES } from "@/lib/auth/lead-visibility"
import { canonicalLifeEventType, type LifeEventType } from "@/lib/enrichment/life-event-vocabulary"
import {
  CONTEXT_RELEVANCE, COST_CLASSES, EPISTEMIC_RANK, INTIMATE_RELEVANCE, MOVEMENT_RELEVANCE, NEIGHBOURLY_HELPERS, RESEARCH_STRATEGIES,
  movementSource, movementSourceKeyForIntentSource,
  type EpistemicClass, type MovementRelevance, type MovementSignalSource, type MovementSourceKind, type NeighbourlyHelper, type ResearchStrategy,
} from "@/lib/intent/movement-source-registry"

export * from "@/lib/intent/movement-source-registry"

type Svc = { from: (t: string) => any }
const DAY_MS = 86_400_000

// ── C9: the record ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MOVEMENT_NEXT_ACTIONS = Object.freeze(["research", "offer_help", "wait", "human"] as const)
export type MovementNextAction = (typeof MOVEMENT_NEXT_ACTIONS)[number]

export const MOVEMENT_OUTCOMES = Object.freeze(["listed", "purchased", "moved", "appointment", "engaged", "declined", "no_change", "false_positive", "opted_out"] as const)
export type MovementOutcome = (typeof MOVEMENT_OUTCOMES)[number]
export const MOVEMENT_POSITIVE_OUTCOMES: ReadonlySet<MovementOutcome> = new Set(["listed", "purchased", "moved", "appointment", "engaged"])

export type MovementSide = "buyer" | "seller" | "both" | "unknown"

export type MovementSubject =
  | { type: "contact"; id: string }
  | { type: "lead"; id: string }
  | { type: "raw_lead"; id: string }
  | { type: "property"; addressKey: string; address: string }
  | { type: "territory"; territoryKey: string }

/** How the subject was tied to the evidence. A name-only match never rides automated outreach (it may be a different person). */
export type IdentityMatch = "record_key" | "verified_match" | "name_only" | "none"

/** Authoritative records only — the issuer (court / recorder / permit office / MLS) or our own system-of-record row. */
export type VerifiedReferenceKind = "court_record" | "recorder_record" | "permit_record" | "open_data_record" | "mls_record" | "first_party_row"
export type ReportedReferenceKind = "public_post" | "provider_field" | "person_message" | "news" | "vendor_compiled_record"

interface EvidenceBase {
  /** One plain sentence — what was observed. Never an inference dressed as an observation. */
  summary: string
  /** Field / filter names the evidence rests on (run through the ONE protected-class classifier). */
  fields?: readonly string[]
}

/**
 * THE EPISTEMIC RULE, IN THE TYPE. Each class carries only what it may carry:
 *   verified — an authoritative reference (issuer / system of record) with its id and when it was retrieved;
 *   reported — who reported it (the person themselves, a third party, a provider) and where;
 *   inferred — the observations it rests on (ids) and the method — and NO reference field at all (`reference?: never`), so an
 *              inference can never be passed off with a verification attached;
 *   unknown  — why it is unknown.
 */
export type MovementEvidence =
  | (EvidenceBase & { confidence: "verified"; reference: { kind: VerifiedReferenceKind; id: string; url?: string | null; retrievedAt: string }; reportedBy?: never; basis?: never })
  | (EvidenceBase & { confidence: "reported"; reportedBy: "self" | "third_party" | "provider"; reference: { kind: ReportedReferenceKind; id: string; url?: string | null; retrievedAt: string; quote?: string | null }; basis?: never })
  | (EvidenceBase & { confidence: "inferred"; basis: readonly string[]; method: string; reference?: never; reportedBy?: never })
  | (EvidenceBase & { confidence: "unknown"; reason: string; reference?: never; reportedBy?: never; basis?: never })

export interface MovementSignalInput {
  brokerageId: string
  subject: MovementSubject
  sourceKey: string
  evidence: MovementEvidence
  /** When the source observed the event (ISO). */
  observedAt: string
  eventRelevance: MovementRelevance
  intents?: readonly IntentKind[]
  side?: MovementSide
  identity: IdentityMatch
  capturedBy: "automation" | "staff" | "person"
  /** The adapter's own protected-proxy reading (marriage, a household change); the builder ORs the classifier and the source's flag. */
  protectedProxy?: boolean
  propertyAddress?: string | null
}

export type MovementOutreach = "none" | "email_mail_only" | "consent_gated" | "address_correction_only"

export interface MovementSignalRecord extends Required<Pick<MovementSignalInput, "brokerageId" | "subject" | "sourceKey" | "evidence" | "observedAt" | "eventRelevance" | "identity" | "capturedBy">> {
  sourceKind: MovementSourceKind
  intents: readonly IntentKind[]
  side: MovementSide
  confidence: EpistemicClass
  protectedProxy: boolean
  /** Always true for a protected proxy or an intimate event: never an audience, never steering, never eligibility. */
  targetingProhibited: boolean
  sensitivity: "intimate_service_topic" | "protected_proxy" | "behaviour" | "property_fact" | "market_context"
  dataRights: { collection: string; storage: string; terms: string; costClass: string; status: string }
  outreach: MovementOutreach
  propertyAddress: string | null
  idempotencyKey: string
  /** Chosen by the manager / arbiter (decideMovementNextAction) — never by the source. */
  nextAction: null
  outcome: null
}

export type MovementRefusalCode =
  | "missing_tenant" | "unknown_source" | "source_not_permitted" | "source_waiting_external" | "manual_capture_only"
  | "above_source_ceiling" | "intimate_inference" | "third_party_intimate" | "anonymous_first_party" | "relevance_not_offered_by_source"
  | "bad_observed_at" | "bad_evidence" | "bad_subject"

export type MovementBuild = { ok: true; record: MovementSignalRecord } | { ok: false; code: MovementRefusalCode; reason: string }

/** PURE. FNV-1a digest (a stable key component — the value itself never rides a key). */
export function movementDigest(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, "0")
}

function subjectKey(s: MovementSubject): string {
  if (s.type === "property") return `property:${s.addressKey}`
  if (s.type === "territory") return `territory:${s.territoryKey}`
  return `${s.type}:${s.id}`
}

const evidenceIdentity = (e: MovementEvidence): string =>
  e.confidence === "verified" || e.confidence === "reported" ? `${e.reference.kind}:${e.reference.id}`
    : e.confidence === "inferred" ? `basis:${[...e.basis].sort().join(",")}` : `unknown:${e.reason}`

/**
 * PURE. Input → a C9 record, or the reason it may not exist. Source licence, consent and outreach rules are enforced HERE (at the
 * record — a reader never has to remember them). Never throws.
 */
function buildMovementSignal(input: MovementSignalInput): MovementBuild {
  const no = (code: MovementRefusalCode, reason: string): MovementBuild => ({ ok: false, code, reason })
  if (!input || !input.brokerageId) return no("missing_tenant", "no verified tenant")
  const src = movementSource(input.sourceKey)
  if (!src) return no("unknown_source", `"${input.sourceKey}" is not in the movement source registry`)
  if (src.licence.collection === "not_permitted") return no("source_not_permitted", `${src.key}: ${src.licence.terms}`)
  if (src.status === "waiting_external" || src.licence.collection === "contract_required") return no("source_waiting_external", `${src.key} needs a licence / processing agreement first (WAITING_EXTERNAL)`)
  if (src.licence.collection === "manual_only" && input.capturedBy === "automation") return no("manual_capture_only", `${src.key}: automated capture is not permitted — a person records what they lawfully saw (${src.licence.terms})`)
  if (!(MOVEMENT_RELEVANCE as readonly string[]).includes(input.eventRelevance) || !src.relevance.includes(input.eventRelevance)) return no("relevance_not_offered_by_source", `${src.key} does not bear on ${String(input.eventRelevance)}`)
  const e = input.evidence
  if (!e || typeof e.summary !== "string" || e.summary.trim().length < 5) return no("bad_evidence", "evidence needs a one-sentence summary")
  if (e.confidence === "verified" && (!e.reference?.id || !e.reference.retrievedAt)) return no("bad_evidence", "a verified record names its authoritative reference and when it was retrieved")
  if (e.confidence === "reported" && (!e.reference?.id || !e.reportedBy)) return no("bad_evidence", "a reported record names who reported it and where")
  if (e.confidence === "inferred" && (!Array.isArray(e.basis) || e.basis.length === 0 || !e.method)) return no("bad_evidence", "an inference names the observations it rests on and its method")
  if (e.confidence === "inferred" && (e as { reference?: unknown }).reference !== undefined) return no("bad_evidence", "an inference may not carry a verification reference")
  if (EPISTEMIC_RANK[e.confidence] > EPISTEMIC_RANK[src.maxConfidence]) return no("above_source_ceiling", `${src.key} can be at most "${src.maxConfidence}" — "${e.confidence}" would overstate what the source knows`)
  // ── privacy: no intimate inference, no gossip ──
  if (INTIMATE_RELEVANCE.has(input.eventRelevance)) {
    if (e.confidence === "inferred" || e.confidence === "unknown") return no("intimate_inference", `${input.eventRelevance} is never inferred — only a public record or the person's own disclosure establishes it`)
    // A third party's POST about a named person's intimate life is gossip, never evidence; a PUBLISHED notice (a court notice, an
    // obituary — reference kind news / court_record) is a public record and stays name-only until a person confirms the identity.
    if (e.confidence === "reported" && e.reportedBy === "third_party" && e.reference.kind === "public_post") return no("third_party_intimate", `a third party's post about a named person's ${input.eventRelevance} is not evidence`)
    if (src.kind === "first_party_behaviour" && !(e.confidence === "reported" && e.reportedBy === "self")) return no("intimate_inference", `${input.eventRelevance} is never read from behaviour on our surfaces — only from the person's own words`)
  }
  const observed = Date.parse(input.observedAt)
  if (!Number.isFinite(observed) || observed > Date.now() + DAY_MS) return no("bad_observed_at", "observed_at must be a real time, not in the future")
  // ── subject + consent ──
  const s = input.subject
  if (!s || !s.type) return no("bad_subject", "no subject")
  if ((s.type === "contact" || s.type === "lead" || s.type === "raw_lead") && !s.id) return no("bad_subject", "a person subject needs its id")
  if (s.type === "property" && !s.addressKey) return no("bad_subject", "a property subject needs its normalized address key")
  if (s.type === "territory" && !s.territoryKey) return no("bad_subject", "a territory subject needs its key")
  if (s.type === "territory" && !CONTEXT_RELEVANCE.has(input.eventRelevance)) return no("bad_subject", "only market / community context is recorded against a territory")
  if (src.kind === "first_party_behaviour" && input.identity !== "record_key") return no("anonymous_first_party", "first-party behaviour is recorded only for a person identified by their own action")
  // ── protected proxies: STORED, flagged, never targeted ──
  const classified = (e.fields ?? []).some((f) => protectedClassReasonFor(f) !== null)
  const protectedProxy = !!(input.protectedProxy || classified || (src.protectedProxy && (input.eventRelevance === "life_stage" || INTIMATE_RELEVANCE.has(input.eventRelevance))))
  const intimate = INTIMATE_RELEVANCE.has(input.eventRelevance)
  const sensitivity: MovementSignalRecord["sensitivity"] = intimate ? "intimate_service_topic" : protectedProxy ? "protected_proxy"
    : CONTEXT_RELEVANCE.has(input.eventRelevance) ? "market_context" : src.kind === "property_public_record" ? "property_fact" : "behaviour"
  // ── outreach, at the record ──
  const outreach: MovementOutreach =
    s.type === "raw_lead" || s.type === "property" || s.type === "territory" ? "none"
      : src.licence.outreach === "none_automated" ? "none"
      : src.licence.outreach === "address_correction_only" ? "address_correction_only"
      : s.type === "lead" ? "email_mail_only" : "consent_gated"
  const day = new Date(observed).toISOString().slice(0, 10)
  const idempotencyKey = `movement:${input.brokerageId}:${subjectKey(s)}:${src.key}:${input.eventRelevance}:${movementDigest(`${evidenceIdentity(e)}|${day}`)}`
  return {
    ok: true,
    record: {
      brokerageId: input.brokerageId, subject: s, sourceKey: src.key, sourceKind: src.kind, evidence: e, observedAt: new Date(observed).toISOString(),
      eventRelevance: input.eventRelevance, intents: [...(input.intents ?? src.intents)], side: input.side ?? "unknown", identity: input.identity,
      capturedBy: input.capturedBy, confidence: e.confidence, protectedProxy, targetingProhibited: protectedProxy || intimate || input.eventRelevance === "life_stage",
      sensitivity, dataRights: { collection: src.licence.collection, storage: src.licence.storage, terms: src.licence.terms, costClass: src.costClass, status: src.status },
      outreach, propertyAddress: input.propertyAddress ?? (s.type === "property" ? s.address : null), idempotencyKey, nextAction: null, outcome: null,
    },
  }
}

/** PURE. The label a human reads. An inference NEVER reads as a fact: no "verified", no "confirmed", always "not a fact". */
function movementEvidenceLabel(e: MovementEvidence): string {
  switch (e.confidence) {
    case "verified": return `Verified — ${e.reference.kind.replace(/_/g, " ")} ${e.reference.id}`
    case "reported": return `Reported by ${e.reportedBy === "self" ? "the person themselves" : e.reportedBy === "provider" ? "a data provider" : "a third party"} — not independently checked`
    case "inferred": return `Inferred from ${e.basis.length} observation${e.basis.length === 1 ? "" : "s"} (${e.method}) — an inference, not a fact`
    default: return `Unknown — ${e.reason}`
  }
}


// ── adapters: the survivors' shapes → C9 (pure) ──────────────────────────────────────────────────────────────────────────────

const PROVIDER_REFERENCE_KIND: Readonly<Record<string, ReportedReferenceKind>> = Object.freeze({ batchdata: "vendor_compiled_record", osint: "public_post" })

/** A 145F provider fact (intentSignalsFromContact) → C9. Modeled indicators are `inferred`; vendor-reported fields `reported`. */
export function movementSignalFromIntentFact(
  fact: ObservedIntentSignal,
  a: { brokerageId: string; subject: { type: "contact" | "lead"; id: string }; writtenAt: string },
): MovementBuild {
  const key = movementSourceKeyForIntentSource(fact.key)
  const src = key ? movementSource(key) : undefined
  if (!key || !src) return { ok: false, code: "unknown_source", reason: `${fact.key} is not a movement source (MOVEMENT_EXCLUDED_INTENT_SOURCES)` }
  const relevance = src.relevance[0]
  const field = fact.field
  const evidence: MovementEvidence = src.maxConfidence === "inferred"
    ? { confidence: "inferred", basis: [`${fact.provider}:${fact.key}`], method: `${fact.provider} modeled indicator "${field}"`, summary: `${fact.provider} recorded "${field}" for this person`, fields: [field] }
    : src.maxConfidence === "verified"
      ? { confidence: "verified", reference: { kind: "first_party_row", id: `${fact.key}:${String(fact.value).slice(0, 40)}`, retrievedAt: fact.observedAt ?? a.writtenAt }, summary: `our own record: ${field}`, fields: [field] }
      : { confidence: "reported", reportedBy: "provider", reference: { kind: PROVIDER_REFERENCE_KIND[fact.provider] ?? "provider_field", id: `${fact.provider}:${fact.key}:${movementDigest(String(fact.value))}`, retrievedAt: fact.observedAt ?? a.writtenAt }, summary: `${fact.provider} reports "${field}" for this person`, fields: [field] }
  return buildMovementSignal({
    brokerageId: a.brokerageId, subject: a.subject, sourceKey: key, evidence, observedAt: fact.observedAt ?? a.writtenAt,
    eventRelevance: relevance, intents: fact.intents, identity: "verified_match", capturedBy: "automation",
  })
}

/** A 146D first-party change (search / portal start or resumption) → C9 (verified: the person's own rows). */
export function movementSignalFromFirstPartyChange(a: {
  brokerageId: string; party: { type: "contact" | "lead"; id: string }; family: "search" | "portal"; tables: readonly string[]; latestAt: string; change: "started" | "resumed"
}): MovementBuild {
  const sourceKey = a.family === "portal" ? "fp_portal_resumed" : a.tables.includes("saved_properties") ? "fp_saved_homes" : a.tables.includes("property_views") ? "fp_repeat_property_views" : "fp_site_sessions"
  return buildMovementSignal({
    brokerageId: a.brokerageId, subject: a.party, sourceKey, eventRelevance: "property_event", identity: "record_key", capturedBy: "automation", observedAt: a.latestAt,
    evidence: { confidence: "verified", reference: { kind: "first_party_row", id: `${a.tables.join("+")}:${a.latestAt}`, retrievedAt: a.latestAt }, summary: `${a.family} engagement ${a.change} on our own surfaces (${a.tables.join(", ")})` },
  })
}

/** calculator_type → its registry row (first-party consented behaviour). */
export const CALCULATOR_MOVEMENT_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  seller_net: "fp_calc_seller_net", moving_cost: "fp_calc_moving_cost", neighborhood_compare: "fp_calc_neighborhood_compare",
  mortgage_comparison: "fp_calc_mortgage_comparison", investment_analyzer: "fp_calc_investment",
})

/** A calculator_history row → C9 (verified first-party action). */
export function movementSignalFromCalculatorRow(brokerageId: string, row: { id: string; contact_id?: string | null; lead_id?: string | null; calculator_type?: string | null; created_at?: string | null }): MovementBuild {
  const key = CALCULATOR_MOVEMENT_SOURCE[String(row.calculator_type ?? "")]
  if (!key) return { ok: false, code: "unknown_source", reason: `calculator ${String(row.calculator_type)} is not a movement source` }
  const subject = row.contact_id ? { type: "contact" as const, id: row.contact_id } : row.lead_id ? { type: "lead" as const, id: row.lead_id } : null
  if (!subject) return { ok: false, code: "anonymous_first_party", reason: "a calculator row with no person" }
  const src = movementSource(key)!
  const at = row.created_at ?? new Date().toISOString()
  return buildMovementSignal({
    brokerageId, subject, sourceKey: key, eventRelevance: src.relevance[0], identity: "record_key", capturedBy: "automation", observedAt: at,
    evidence: { confidence: "verified", reference: { kind: "first_party_row", id: `calculator_history:${row.id}`, retrievedAt: at }, summary: `ran the ${String(row.calculator_type).replace(/_/g, " ")} calculator in their portal` },
  })
}

/**
 * Every life event of THE one vocabulary (lib/enrichment/life-event-vocabulary.ts — CLAUDE.md §6) → ONE relevance. WAVE 147 (lane
 * 147Z): keyed on the SURVIVOR spellings only — the retired `divorce` / `death_in_family` rows (and the dead `probate` /
 * `probate_filing` keys no life-event writer ever wrote) are read through canonicalLifeEventType, not restated here; a key that is
 * not a LifeEventType is a type error, so this table can never drift from the vocabulary again.
 */
export const LIFE_EVENT_RELEVANCE: Readonly<Record<LifeEventType, { relevance: MovementRelevance; protectedProxy: boolean } | null>> = Object.freeze({
  divorce_filing: { relevance: "divorce", protectedProxy: true },
  inheritance: { relevance: "probate_estate", protectedProxy: false }, death_in_household: { relevance: "probate_estate", protectedProxy: false },
  relocation: { relevance: "relocation", protectedProxy: false }, job_change: { relevance: "life_stage", protectedProxy: false }, job_change_to_non_local: { relevance: "relocation", protectedProxy: false },
  marriage: { relevance: "life_stage", protectedProxy: true }, retirement: { relevance: "life_stage", protectedProxy: true }, new_baby: { relevance: "life_stage", protectedProxy: true },
  kids_graduated: { relevance: "life_stage", protectedProxy: true }, empty_nester: { relevance: "life_stage", protectedProxy: true },
  // financial distress is a property event (pre-foreclosure is a recorded notice); bankruptcy is not a movement signal here
  foreclosure_filing: { relevance: "property_event", protectedProxy: false }, bankruptcy: null,
})

/** A contacts.life_events element (OSINT / web-mention writer) → C9. A web mention is a NAME-ONLY identity until a person confirms. */
export function movementSignalFromLifeEvent(
  a: { brokerageId: string; contactId: string; event: { event?: string; type?: string; details?: string; source?: string; url?: string | null; publishedDate?: string | null; date?: string | null } ; detectedAt: string },
): MovementBuild {
  const raw = String(a.event.type ?? a.event.event ?? "").toLowerCase()
  const canon = canonicalLifeEventType(raw)
  const token = canon ?? raw
  const map = canon ? LIFE_EVENT_RELEVANCE[canon] : null
  if (!map) return { ok: false, code: "relevance_not_offered_by_source", reason: `life event "${token}" is not a movement signal` }
  const at = a.event.publishedDate ?? a.event.date ?? a.detectedAt
  const ref = a.event.url ?? a.event.source ?? `life_events:${token}`
  return buildMovementSignal({
    brokerageId: a.brokerageId, subject: { type: "contact", id: a.contactId }, sourceKey: "pp_web_mention_life_event", eventRelevance: map.relevance,
    identity: "name_only", capturedBy: "automation", observedAt: at, protectedProxy: map.protectedProxy,
    evidence: { confidence: "reported", reportedBy: "third_party", reference: { kind: "news", id: ref, url: a.event.url ?? null, retrievedAt: a.detectedAt }, summary: `a published public page mentions this name with "${token.replace(/_/g, " ")}"` },
  })
}

/** A motivated_seller_signals row (permit / violation / quickList) → C9. Issuer open data is verified; a vendor compilation reported. */
export function movementSignalFromSellerSignalRow(brokerageId: string, row: { id: string; lead_id?: string | null; contact_id?: string | null; signal_type?: string | null; signal_strength?: string | null; detected_via?: string | null; detected_at?: string | null; signal_details?: Record<string, unknown> | null }): MovementBuild {
  const type = String(row.signal_type ?? "")
  const via = String(row.detected_via ?? "")
  const subject = row.contact_id ? { type: "contact" as const, id: row.contact_id } : row.lead_id ? { type: "lead" as const, id: row.lead_id } : null
  if (!subject) return { ok: false, code: "bad_subject", reason: "a seller-signal row with no person" }
  const at = row.detected_at ?? new Date().toISOString()
  const issuer = via === "socrata" || via === "arcgis"
  const sourceKey = issuer ? (type === "code_violation" ? "pr_code_violation" : "pr_permit_activity") : "pr_batchdata_quicklist"
  const inherited = /inherit|probate|estate/.test(type)
  const relevance: MovementRelevance = inherited && !issuer ? "probate_estate" : "property_event"
  const details = row.signal_details ?? {}
  const address = typeof details.address === "string" ? details.address : typeof details.property_address === "string" ? details.property_address : null
  const evidence: MovementEvidence = issuer
    ? { confidence: "verified", reference: { kind: "permit_record", id: String(details.permit_id ?? details.dedupe_key ?? row.id), url: typeof details.source_url === "string" ? details.source_url : null, retrievedAt: at }, summary: `${type.replace(/_/g, " ")} on the owner's address (${via} open data)` }
    : { confidence: "reported", reportedBy: "provider", reference: { kind: "vendor_compiled_record", id: `motivated_seller_signals:${row.id}`, retrievedAt: at }, summary: `${via || "vendor"} lists this property under "${type.replace(/_/g, " ")}"` }
  return buildMovementSignal({ brokerageId, subject, sourceKey, eventRelevance: relevance, identity: "verified_match", capturedBy: "automation", observedAt: at, evidence, intents: ["home_sale"], side: "seller", propertyAddress: address })
}

// ── the AI classifier for public text (posts, announcements) — an expert, structured prompt; the model never sets the class ─────

export const MOVEMENT_CLASSIFIER_SYSTEM = [
  "ROLE: You are the behavioural-intent researcher on a real-estate brokerage's AI team. You read ONE piece of public text (a post, a comment, a news item) and say whether it bears on a residential move — nothing else.",
  "BUSINESS CONTEXT: Brokerages want to be the helpful neighbour who notices first — the 'can anyone recommend a realtor?' post, 'we're moving to Denver in the spring', 'starting my new job in Austin next month' — and to offer help without pressure. Most public text is not about a move; saying so is the most common correct answer.",
  "FACTS YOU MAY RELY ON: only the text supplied and the territory named. Do not invent a person, a timeline, a reason, a price or a place. Do not guess who the author is beyond what the text says.",
  "THE DECISION YOU OWN: relevant yes/no; the event_relevance from the closed list; whether the text is ABOUT ITS AUTHOR ('author'), about someone else ('third_party') or unclear; the side (buyer / seller / both / unknown); a timeline BUCKET only if the text states one ('1-3', '3-6', '6-12' months, else 'unknown' — never 30/60/90 days); and ONE verbatim quote (copied exactly from the text, at most 200 characters) that supports your reading.",
  "YOU DO NOT DECIDE how certain the platform is: the platform assigns verified / reported / inferred itself from the source and your quote. You never decide what anyone does next.",
  "PRIVACY BOUNDARY: a divorce, a death, an illness, a pregnancy or a household change about a THIRD PARTY is never relevant — answer relevant=false. Never reason from race, colour, religion, sex, disability, familial status, national origin, marital status or age, and never mention them. A school mentioned in the text is about a place, never a guess that the author has children.",
  "ESCALATION: if the text describes distress, danger, a legal dispute or a complaint, set needs_person=true and keep the reading minimal.",
  "OUTPUT CONTRACT — JSON only: {relevant: boolean, event_relevance: one of divorce|probate_estate|relocation|seeking_agent|life_stage|property_event|market_event|community_change|null, about: 'author'|'third_party'|'unclear', side: 'buyer'|'seller'|'both'|'unknown', timeline_bucket: '1-3'|'3-6'|'6-12'|'unknown', quote: string|null, needs_person: boolean, note: string (one sentence, plain words)}.",
].join("\n")

export interface MovementTextClassification {
  relevant: boolean
  eventRelevance: MovementRelevance | null
  about: "author" | "third_party" | "unclear"
  side: MovementSide
  timelineBucket: "1-3" | "3-6" | "6-12" | "unknown"
  quote: string | null
  needsPerson: boolean
  note: string
  source: "ai" | "refused"
  refusedWhy?: string
}

export type MovementClassify = (a: { brokerageId: string; system: string; prompt: string }) => Promise<Record<string, unknown>>

async function defaultClassify(a: { brokerageId: string; system: string; prompt: string }): Promise<Record<string, unknown>> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const schema = z.object({
    relevant: z.boolean(), event_relevance: z.string().nullable(), about: z.string(), side: z.string(),
    timeline_bucket: z.string(), quote: z.string().nullable(), needs_person: z.boolean(), note: z.string(),
  })
  const { object } = await generateObjectRouted({ feature: "behavioral_pattern_detect", brokerageId: a.brokerageId, manager: "data_steward", system: a.system, prompt: a.prompt, schema, temperature: 0, maxTokens: 300 })
  return object as Record<string, unknown>
}

/**
 * Public text → a validated reading. The DETERMINISTIC validator refuses an off-list relevance, a quote that is not a verbatim
 * substring of the text (no invented evidence), and any intimate reading about a third party. Never throws.
 */
export async function classifyPublicMovementText(
  a: { brokerageId: string; text: string; territory?: string | null; sourceKey: string },
  deps: { classify?: MovementClassify } = {},
): Promise<MovementTextClassification> {
  const refused = (why: string): MovementTextClassification => ({ relevant: false, eventRelevance: null, about: "unclear", side: "unknown", timelineBucket: "unknown", quote: null, needsPerson: false, note: why, source: "refused", refusedWhy: why })
  const text = String(a.text ?? "").slice(0, 4000)
  if (text.trim().length < 8) return refused("no text to read")
  let raw: Record<string, unknown>
  try {
    raw = await (deps.classify ?? defaultClassify)({ brokerageId: a.brokerageId, system: MOVEMENT_CLASSIFIER_SYSTEM, prompt: JSON.stringify({ source: a.sourceKey, territory: a.territory ?? null, text }) })
  } catch (e) {
    return refused(`the model was unavailable (${e instanceof Error ? e.message : String(e)})`)
  }
  const rel = raw.event_relevance === null || raw.event_relevance === undefined ? null : String(raw.event_relevance)
  if (rel !== null && !(MOVEMENT_RELEVANCE as readonly string[]).includes(rel)) return refused(`"${rel}" is not a movement relevance`)
  const about = raw.about === "author" || raw.about === "third_party" ? raw.about : "unclear"
  const quote = typeof raw.quote === "string" && raw.quote.trim() ? raw.quote.trim().slice(0, 200) : null
  if (raw.relevant === true && (!quote || !text.includes(quote))) return refused("the quote is not a verbatim part of the text — no invented evidence")
  if (raw.relevant === true && rel && INTIMATE_RELEVANCE.has(rel as MovementRelevance) && about !== "author") return refused("an intimate life event about someone other than the author is never a signal")
  const side = raw.side === "buyer" || raw.side === "seller" || raw.side === "both" ? raw.side : "unknown"
  const tb = raw.timeline_bucket === "1-3" || raw.timeline_bucket === "3-6" || raw.timeline_bucket === "6-12" ? raw.timeline_bucket : "unknown"
  return { relevant: raw.relevant === true && rel !== null, eventRelevance: rel as MovementRelevance | null, about, side, timelineBucket: tb, quote, needsPerson: raw.needs_person === true, note: String(raw.note ?? "").slice(0, 300), source: "ai" }
}

/**
 * PURE. A public post the acquisition lanes stored + its reading → C9. The class is the PLATFORM's: `reported` (self) only when the
 * model's verbatim quote shows the author speaking for themselves; otherwise an `inferred` keyword-level reading.
 */
export function movementSignalFromPublicPost(a: {
  brokerageId: string; subject: MovementSubject; sourceKey: string; postId: string; url?: string | null; postedAt: string; retrievedAt: string; reading: MovementTextClassification; keywordBasis?: readonly string[]
}): MovementBuild {
  const r = a.reading
  if (!r.relevant || !r.eventRelevance) return { ok: false, code: "bad_evidence", reason: `not a movement post (${r.refusedWhy ?? r.note})` }
  const evidence: MovementEvidence = r.about === "author" && r.quote
    ? { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: a.postId, url: a.url ?? null, retrievedAt: a.retrievedAt, quote: r.quote }, summary: `the author posted publicly: "${r.quote}"` }
    : { confidence: "inferred", basis: [a.postId, ...(a.keywordBasis ?? [])], method: "public-post reading without an author-voiced quote", summary: `a public post reads as ${r.eventRelevance.replace(/_/g, " ")}` }
  return buildMovementSignal({
    brokerageId: a.brokerageId, subject: a.subject, sourceKey: a.sourceKey, evidence, observedAt: a.postedAt, eventRelevance: r.eventRelevance,
    side: r.side, identity: a.subject.type === "raw_lead" ? "record_key" : "verified_match", capturedBy: "automation",
  })
}

// ── COMBINATION — scored combinations, never a single keyword; the score explains itself (requirement 4) ──────────────────────

/** Prior points per source strength tier — PRIORS, labelled as such; outcomes re-weight them (movementSourceWeights). */
export const STRENGTH_POINTS = Object.freeze({ strong: 40, moderate: 25, weak: 12, context: 6 })
export const CONFIDENCE_FACTOR: Readonly<Record<EpistemicClass, number>> = Object.freeze({ verified: 1, reported: 0.75, inferred: 0.4, unknown: 0 })
export const IDENTITY_FACTOR: Readonly<Record<IdentityMatch, number>> = Object.freeze({ record_key: 1, verified_match: 1, name_only: 0.4, none: 0.6 })
/** One source kind alone stays under the "warm" line … */
export const SINGLE_KIND_CAP = 44
/** … inferences alone stay "watch" … */
export const INFERRED_ONLY_CAP = 40
/** … and market / community context adds at most this much, and never scores alone. */
export const CONTEXT_CAP = 10
export const CORROBORATION_BONUS = 8
export const MOVEMENT_BANDS = Object.freeze([{ band: "act", min: 65 }, { band: "warm", min: 45 }, { band: "watch", min: 20 }, { band: "none", min: 0 }] as const)
export type MovementBand = (typeof MOVEMENT_BANDS)[number]["band"]

/** The fields a stored row / a built record share (the scorer reads either). */
export interface ScorableMovement {
  id: string
  sourceKey: string
  eventRelevance: MovementRelevance
  confidence: EpistemicClass
  identity: IdentityMatch
  observedAt: string
  evidence?: MovementEvidence | null
  protectedProxy?: boolean
}

export interface MovementContribution {
  id: string
  sourceKey: string
  sourceKind: MovementSourceKind | "unregistered"
  relevance: MovementRelevance
  confidence: EpistemicClass
  points: number
  /** The contribution after every factor; 0 when superseded by a stronger record of the same source + relevance. */
  value: number
  superseded: boolean
  reason: string
}

export interface MovementCombination {
  score: number
  band: MovementBand
  dominantRelevance: MovementRelevance | null
  independentKinds: MovementSourceKind[]
  corroborated: boolean
  contributions: MovementContribution[]
  caps: string[]
  explanation: string
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** PURE. The combination for ONE subject's records (+ the territory's context rows). Deterministic; `now` injectable. */
function scoreMovementCombination(records: readonly ScorableMovement[], opts: { now?: Date; weights?: Readonly<Record<string, number>> } = {}): MovementCombination {
  const now = opts.now ?? new Date()
  const contributions: MovementContribution[] = []
  for (const r of records) {
    const src = movementSource(r.sourceKey)
    const points = src ? STRENGTH_POINTS[src.strength] : 0
    const ageDays = Math.max(0, (now.getTime() - Date.parse(r.observedAt)) / DAY_MS)
    const halfLife = src?.halfLifeDays ?? 30
    const recency = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / halfLife) : 0
    const learned = opts.weights?.[r.sourceKey] ?? 1
    const value = points * CONFIDENCE_FACTOR[r.confidence] * IDENTITY_FACTOR[r.identity] * recency * learned
    const label = r.evidence ? movementEvidenceLabel(r.evidence) : r.confidence
    contributions.push({
      id: r.id, sourceKey: r.sourceKey, sourceKind: src?.kind ?? "unregistered", relevance: r.eventRelevance, confidence: r.confidence, points, value: round1(value), superseded: false,
      reason: `${label} — ${r.sourceKey} → ${r.eventRelevance}: ${points} prior pts × ${r.confidence} ${CONFIDENCE_FACTOR[r.confidence]} × identity ${r.identity} ${IDENTITY_FACTOR[r.identity]} × recency ${round1(recency)} (${Math.round(ageDays)}d, half-life ${halfLife}d)${learned !== 1 ? ` × learned ${round1(learned)}` : ""} = ${round1(value)}`,
    })
  }
  // A repeated trace from the SAME source for the SAME relevance never stacks — only its strongest record counts.
  const best = new Map<string, MovementContribution>()
  for (const c of contributions) {
    const k = `${c.sourceKey}|${c.relevance}`
    const cur = best.get(k)
    if (!cur || c.value > cur.value) { if (cur) cur.superseded = true; best.set(k, c) } else c.superseded = true
  }
  const live = contributions.filter((c) => !c.superseded && c.value > 0)
  const personal = live.filter((c) => !CONTEXT_RELEVANCE.has(c.relevance))
  const context = live.filter((c) => CONTEXT_RELEVANCE.has(c.relevance))
  const caps: string[] = []
  const byRel = new Map<MovementRelevance, number>()
  for (const c of personal) byRel.set(c.relevance, (byRel.get(c.relevance) ?? 0) + c.value)
  const dominantRelevance = [...byRel.entries()].sort((a, b) => b[1] - a[1] || MOVEMENT_RELEVANCE.indexOf(a[0]) - MOVEMENT_RELEVANCE.indexOf(b[0]))[0]?.[0] ?? null
  const kinds = [...new Set(personal.map((c) => c.sourceKind).filter((k): k is MovementSourceKind => k !== "unregistered"))]
  let score = personal.reduce((s, c) => s + c.value, 0)
  if (kinds.length > 1) { const bonus = CORROBORATION_BONUS * Math.min(2, kinds.length - 1); score += bonus; caps.push(`+${bonus} corroboration: ${kinds.length} independent source kinds (${kinds.join(", ")})`) }
  // The person's OWN deliberate act or words (a strong first-party source, identified by their own row) stands alone; anything
  // else from one source kind is capped — a single keyword, a single scrape, a single provider flag is never a move.
  const selfDeclared = personal.some((c) => { const s = movementSource(c.sourceKey); return s?.kind === "first_party_behaviour" && s.strength === "strong" && EPISTEMIC_RANK[c.confidence] >= EPISTEMIC_RANK.reported })
  if (kinds.length <= 1 && !selfDeclared && score > SINGLE_KIND_CAP) { caps.push(`capped at ${SINGLE_KIND_CAP}: one source kind only — a single source is never a move`); score = SINGLE_KIND_CAP }
  if (personal.length > 0 && !personal.some((c) => EPISTEMIC_RANK[c.confidence] >= EPISTEMIC_RANK.reported) && score > INFERRED_ONLY_CAP) { caps.push(`capped at ${INFERRED_ONLY_CAP}: inferences only — nothing verified or reported`); score = INFERRED_ONLY_CAP }
  if (context.length > 0) {
    if (personal.length === 0) caps.push("market / community context alone never scores — it only modifies a person's own evidence")
    else { const add = Math.min(CONTEXT_CAP, context.reduce((s, c) => s + c.value, 0)); score += add; caps.push(`+${round1(add)} context (market / community, capped at ${CONTEXT_CAP})`) }
  }
  score = Math.max(0, Math.min(100, Math.round(score)))
  const band = (MOVEMENT_BANDS.find((b) => score >= b.min) ?? MOVEMENT_BANDS[MOVEMENT_BANDS.length - 1]).band
  const lines = live.sort((a, b) => b.value - a.value).map((c) => c.reason)
  const explanation = live.length === 0
    ? "No movement evidence inside the window."
    : `Score ${score} (${band})${dominantRelevance ? ` for ${dominantRelevance.replace(/_/g, " ")}` : ""}: ${kinds.length} independent source kind${kinds.length === 1 ? "" : "s"}. ${lines.join(" | ")}${caps.length ? ` | ${caps.join(" | ")}` : ""}`
  return { score, band, dominantRelevance, independentKinds: kinds, corroborated: kinds.length > 1, contributions, caps, explanation }
}

// ── LEARNING — outcomes re-weight the sources (requirement 8) ────────────────────────────────────────────────────────────────

/** A source's weight moves only once it has this many closed outcomes (a statistical floor, not a business rule). */
export const LEARNING_MIN_SAMPLE = 20
export const LEARNING_WEIGHT_BOUNDS = Object.freeze({ min: 0.5, max: 1.5 })

export interface MovementSourceLearning { n: number; positives: number; precision: number; weight: number }

/** PURE. Closed outcomes → per-source weights (Laplace-smoothed precision relative to the tenant's own baseline, bounded). */
function movementSourceWeights(rows: ReadonlyArray<{ source_key: string; outcome: string | null }>): Record<string, MovementSourceLearning> {
  const closed = rows.filter((r) => r.outcome && (MOVEMENT_OUTCOMES as readonly string[]).includes(r.outcome))
  const pos = (o: string | null) => MOVEMENT_POSITIVE_OUTCOMES.has(o as MovementOutcome)
  const base = (closed.filter((r) => pos(r.outcome)).length + 1) / (closed.length + 2)
  const by = new Map<string, { n: number; p: number }>()
  for (const r of closed) { const e = by.get(r.source_key) ?? { n: 0, p: 0 }; e.n++; if (pos(r.outcome)) e.p++; by.set(r.source_key, e) }
  const out: Record<string, MovementSourceLearning> = {}
  for (const [k, e] of by) {
    const precision = (e.p + 1) / (e.n + 2)
    const weight = e.n >= LEARNING_MIN_SAMPLE ? Math.min(LEARNING_WEIGHT_BOUNDS.max, Math.max(LEARNING_WEIGHT_BOUNDS.min, precision / base)) : 1
    out[k] = { n: e.n, positives: e.p, precision: round1(precision * 100) / 100, weight: Math.round(weight * 100) / 100 }
  }
  return out
}

const weightsOf = (l: Record<string, MovementSourceLearning>): Record<string, number> => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v.weight]))

// ── THE DECISION — the manager / arbiter chooses; the source never does (requirement 6) ──────────────────────────────────────

export type MovementSubjectClass = "raw_lead" | "lead" | "contact" | "lifetime" | "property" | "territory"

export interface MovementAllowed { allowed: MovementNextAction[]; why: Partial<Record<MovementNextAction, string>>; helpers: NeighbourlyHelper[]; research: ResearchStrategy[] }

/** PURE. The CLOSED menu the policy permits for this subject and this evidence — the model only ever chooses inside it. */
function allowedMovementActions(
  combo: MovementCombination,
  records: readonly (ScorableMovement & { outreach?: MovementOutreach })[],
  ctx: { subjectClass: MovementSubjectClass },
): MovementAllowed {
  const why: MovementAllowed["why"] = { wait: "always permitted — waiting for corroboration is a legitimate answer" }
  const allowed: MovementNextAction[] = ["wait"]
  const dom = combo.dominantRelevance
  if (ctx.subjectClass === "territory" || !dom) return { allowed, why, helpers: [], research: [] }
  const decisive = records.filter((r) => r.eventRelevance === dom)
  const research = [...RESEARCH_STRATEGIES]
    .filter((s) => s.corroborates.includes(dom) && s.costClass !== "contract_required")
    .sort((a, b) => COST_CLASSES.indexOf(a.costClass) - COST_CLASSES.indexOf(b.costClass))
  if (research.length > 0) { allowed.push("research"); why.research = `cheapest first: ${research.map((s) => `${s.key} (${s.costClass})`).join(", ")}` }
  allowed.push("human"); why.human = INTIMATE_RELEVANCE.has(dom) ? `${dom} is a person's conversation — only a person answers it` : "a person may always take it"
  const person = ctx.subjectClass === "lead" || ctx.subjectClass === "contact" || ctx.subjectClass === "lifetime"
  const reachable = decisive.some((r) => r.outreach && r.outreach !== "none" && r.outreach !== "address_correction_only")
  const strongEnough = combo.band === "warm" || combo.band === "act"
  const solid = decisive.some((r) => EPISTEMIC_RANK[r.confidence] >= EPISTEMIC_RANK.reported && (r.identity === "record_key" || r.identity === "verified_match"))
  const sensitive = INTIMATE_RELEVANCE.has(dom) || decisive.some((r) => r.protectedProxy && dom === "life_stage")
  const blocks: string[] = []
  if (!person) blocks.push(`a ${ctx.subjectClass} has consented to nothing`)
  if (!reachable) blocks.push("no decisive record permits outreach (source terms / subject class)")
  if (!strongEnough) blocks.push(`the combination is only "${combo.band}"`)
  if (!solid) blocks.push("no verified / reported evidence with a confirmed identity")
  if (sensitive) blocks.push(`${dom} is never answered by an automated offer`)
  if (blocks.length === 0) { allowed.push("offer_help"); why.offer_help = "a warm, corroborated, reachable person — the arbiter chooses the experience under consent / DNC / TCPA / frequency" }
  else why.offer_help = `not offered: ${blocks.join("; ")}`
  const maxConf = decisive.reduce((m, r) => Math.max(m, EPISTEMIC_RANK[r.confidence]), 0)
  const helpers = NEIGHBOURLY_HELPERS.filter((h) => h.requires.relevance.includes(dom) && maxConf >= EPISTEMIC_RANK[h.requires.minConfidence] && (!h.requires.personIdentified || (person && solid)) && !h.requires.requestedByPerson)
  return { allowed, why, helpers, research }
}

export const MOVEMENT_DECISION_SYSTEM = [
  "ROLE: You are the movement-signal judgment of a real-estate brokerage's AI team (the AI ISA for leads and contacts, the Sphere of Influence manager for past clients, the Data Steward for unidentified records). You decide the ONE next appropriate step for ONE person or property after early signs that they may be starting to move.",
  "BUSINESS CONTEXT: The brokerage wants to be the helpful neighbour who notices first and offers help without pressure. Being early is worthless if it feels like surveillance: a person who senses they are being watched is lost for good. Waiting for one more independent sign is often the best answer.",
  "FACTS YOU MAY RELY ON: only the supplied evidence keys — the combination score and band, each contribution's source, epistemic class, age and reason, the subject class, the allowed actions with their reasons, the eligible neighbourly helpers and the research strategies (cheapest first). An 'inferred' contribution is a guess, never a fact; 'reported' is unchecked. Do not invent a person, a reason for a move, a timeline, a price or a fact not supplied.",
  "THE DECISION YOU OWN: choose exactly one action from `allowed` — RESEARCH (corroborate with the cheapest strategy that can close the gap; free and first-party before paid), OFFER_HELP (hand to the follow-up arbiter, which picks the experience and channel under consent, do-not-contact, quiet hours and frequency — you never write the message), WAIT (hold until new evidence arrives; no timer), or HUMAN (a person handles it). Name the helper keys (from `helpers`) and research keys (from `research`) that fit.",
  "PRIVACY AND COMPLIANCE BOUNDARY: divorce, probate / a death, and household or life-stage changes are a person's own business — they go to a HUMAN, never an automated offer, never a message that mentions the event, never a segment. Never reason from race, colour, religion, sex, disability, familial status, national origin, marital status or age. Fair-housing copy rules apply to public marketing, not to this internal decision — but no decision may steer, exclude or target anyone by a protected trait.",
  "ESCALATION RULE: choose HUMAN when the evidence is sensitive, contradictory, name-only, or when anything suggests distress, a dispute or a complaint. When unsure between OFFER_HELP and WAIT, choose WAIT.",
  "OUTPUT CONTRACT — JSON only: {action: one of the allowed actions, rationale: 1-3 plain sentences a broker would accept, helper_keys: string[], research_keys: string[], evidence: string[] (contribution ids you relied on), confidence: number 0..1}.",
].join("\n")

export type MovementDecide = (a: { brokerageId: string; system: string; prompt: string }) => Promise<Record<string, unknown>>

export interface MovementDecision {
  action: MovementNextAction
  rationale: string
  helperKeys: string[]
  researchKeys: string[]
  evidence: string[]
  confidence: number
  source: "ai" | "deterministic"
  fallbackReason: string | null
  allowed: MovementNextAction[]
}

async function defaultDecide(a: { brokerageId: string; system: string; prompt: string }): Promise<Record<string, unknown>> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const schema = z.object({ action: z.string(), rationale: z.string(), helper_keys: z.array(z.string()), research_keys: z.array(z.string()), evidence: z.array(z.string()), confidence: z.number() })
  const { object } = await generateObjectRouted({ feature: "followup_arbitration", brokerageId: a.brokerageId, manager: "ai_isa", system: a.system, prompt: a.prompt, schema, temperature: 0.2, maxTokens: 400 })
  return object as Record<string, unknown>
}

/** PURE. The policy's own answer when the model is unavailable or refused — the most conservative permitted step. */
function deterministicMovementAction(combo: MovementCombination, allowed: MovementAllowed): MovementNextAction {
  const dom = combo.dominantRelevance
  if (dom && INTIMATE_RELEVANCE.has(dom) && combo.band !== "none" && allowed.allowed.includes("human")) return "human"
  if (allowed.allowed.includes("offer_help") && combo.band === "act") return "offer_help"
  if (allowed.allowed.includes("research") && combo.band !== "none") return "research"
  return "wait"
}

/** The model chooses INSIDE the closed menu; anything it cannot or may not answer falls to the policy's answer, with the reason. */
async function decideMovementNextAction(
  a: { brokerageId: string; subjectClass: MovementSubjectClass; combination: MovementCombination; allowed: MovementAllowed },
  deps: { decide?: MovementDecide } = {},
): Promise<MovementDecision> {
  const { combination: combo, allowed } = a
  const fallback = (why: string): MovementDecision => {
    const action = deterministicMovementAction(combo, allowed)
    return { action, rationale: `The policy's conservative step: ${allowed.why[action] ?? action}. (${why})`, helperKeys: action === "offer_help" || action === "human" ? allowed.helpers.map((h) => h.key) : [], researchKeys: action === "research" ? allowed.research.slice(0, 2).map((s) => s.key) : [], evidence: combo.contributions.filter((c) => !c.superseded && c.value > 0).map((c) => c.id), confidence: 1, source: "deterministic", fallbackReason: why, allowed: allowed.allowed }
  }
  if (allowed.allowed.length === 1) return fallback("only one step is permitted")
  const supplied = new Set(combo.contributions.map((c) => c.id))
  let raw: Record<string, unknown>
  try {
    raw = await (deps.decide ?? defaultDecide)({
      brokerageId: a.brokerageId, system: MOVEMENT_DECISION_SYSTEM,
      prompt: JSON.stringify({
        subject_class: a.subjectClass,
        combination: { score: combo.score, band: combo.band, dominant_relevance: combo.dominantRelevance, independent_kinds: combo.independentKinds, caps: combo.caps },
        contributions: combo.contributions.filter((c) => !c.superseded && c.value > 0).map((c) => ({ id: c.id, source: c.sourceKey, kind: c.sourceKind, relevance: c.relevance, class: c.confidence, value: c.value, reason: c.reason })),
        allowed: allowed.allowed.map((x) => ({ action: x, why: allowed.why[x] ?? "" })),
        not_allowed: (MOVEMENT_NEXT_ACTIONS.filter((x) => !allowed.allowed.includes(x))).map((x) => ({ action: x, why: allowed.why[x] ?? "not permitted" })),
        helpers: allowed.helpers.map((h) => ({ key: h.key, title: h.title, offer: h.offer, never: h.never })),
        research: allowed.research.map((s) => ({ key: s.key, cost_class: s.costClass, what: s.what })),
      }),
    })
  } catch (e) {
    return fallback(`the model was unavailable (${e instanceof Error ? e.message : String(e)})`)
  }
  const action = String(raw.action ?? "").toLowerCase() as MovementNextAction
  if (!allowed.allowed.includes(action)) return fallback(`the model chose "${String(raw.action)}", which is not permitted here`)
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : ""
  if (rationale.length < 10) return fallback("the model gave no rationale")
  const evidence = Array.isArray(raw.evidence) ? [...new Set((raw.evidence as unknown[]).filter((x): x is string => typeof x === "string" && supplied.has(x)))] : []
  if (evidence.length === 0) return fallback("the model cited no evidence the platform supplied")
  const helperKeys = Array.isArray(raw.helper_keys) ? (raw.helper_keys as unknown[]).filter((x): x is string => typeof x === "string" && allowed.helpers.some((h) => h.key === x)) : []
  const researchKeys = Array.isArray(raw.research_keys) ? (raw.research_keys as unknown[]).filter((x): x is string => typeof x === "string" && allowed.research.some((s) => s.key === x)) : []
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0
  return { action, rationale: rationale.slice(0, 600), helperKeys, researchKeys, evidence, confidence, source: "ai", fallbackReason: null, allowed: allowed.allowed }
}

// ── the arbiter's spellings (no new vocabulary — lib/ai-isa/followup-arbiter.ts LIFE_CHANGE_SIGNAL_KINDS) ────────────────────────

/** PURE. A movement reading → the responder's existing signal_reactivations spelling (`responderType` — NOT a bus signal type) + kind, and the bus payload the AI ISA's handler maps back to
 *  the same kind (intentFactSignalType). Context relevance maps to null — market / community never route alone. */
function lifeChangeTypeFor(r: { relevance: MovementRelevance; side?: MovementSide; intents?: readonly IntentKind[]; verified?: boolean }):
  { responderType: string; kind: LifeChangeKind; bus: { sensitivity: "life_event" | "behaviour"; intents: IntentKind[] } } | null {
  switch (r.relevance) {
    case "divorce": return { responderType: r.verified ? "divorce_filing" : "life_event", kind: "life_event", bus: { sensitivity: "life_event", intents: ["life_event"] } }
    case "probate_estate": return { responderType: r.verified ? "probate_filing" : "life_event", kind: "life_event", bus: { sensitivity: "life_event", intents: ["life_event"] } }
    case "life_stage": return { responderType: "life_event", kind: "life_event", bus: { sensitivity: "life_event", intents: ["life_event"] } }
    case "relocation": return { responderType: "moving_intent", kind: "moving", bus: { sensitivity: "behaviour", intents: ["moving"] } }
    case "seeking_agent":
      if (r.side === "seller") return { responderType: "home_sale_interest", kind: "home_sale", bus: { sensitivity: "behaviour", intents: ["home_sale"] } }
      if (r.side === "buyer") return { responderType: "buying_intent", kind: "buying", bus: { sensitivity: "behaviour", intents: ["home_purchase"] } }
      return { responderType: "moving_intent", kind: "moving", bus: { sensitivity: "behaviour", intents: ["moving"] } }
    case "property_event": {
      const first = (r.intents ?? [])[0]
      if (first === "home_purchase") return { responderType: "buying_intent", kind: "buying", bus: { sensitivity: "behaviour", intents: ["home_purchase"] } }
      if (first === "refinance") return { responderType: "refinance_opportunity", kind: "refinance", bus: { sensitivity: "behaviour", intents: ["refinance"] } }
      if (first === "moving") return { responderType: "moving_intent", kind: "moving", bus: { sensitivity: "behaviour", intents: ["moving"] } }
      if (first === "home_sale") return { responderType: "home_sale_interest", kind: "home_sale", bus: { sensitivity: "behaviour", intents: ["home_sale"] } }
      return { responderType: "property_engagement", kind: "engagement", bus: { sensitivity: "behaviour", intents: ["property_engagement"] } }
    }
    default: return null
  }
}

// ── persistence + routing (m892 movement_signals) ────────────────────────────────────────────────────────────────────────────

export interface MovementRow {
  id: string; brokerage_id: string; subject_type: string; contact_id: string | null; lead_id: string | null; raw_lead_id: string | null
  property_address_key: string | null; territory_key: string | null; source_key: string; source_kind: string; confidence: EpistemicClass
  identity_match: IdentityMatch; event_relevance: MovementRelevance; intents: string[]; side: MovementSide; evidence: MovementEvidence
  observed_at: string; outreach: MovementOutreach; protected_proxy: boolean; next_action: MovementNextAction | null; outcome: MovementOutcome | null
}

/** PURE. The m892 row for a built record (exact column names — scripts/movement-signals-guard.ts checks them against the migration). */
function movementRowFor(r: MovementSignalRecord): Record<string, unknown> {
  const s = r.subject
  return {
    brokerage_id: r.brokerageId, subject_type: s.type,
    contact_id: s.type === "contact" ? s.id : null, lead_id: s.type === "lead" ? s.id : null, raw_lead_id: s.type === "raw_lead" ? s.id : null,
    property_address_key: s.type === "property" ? s.addressKey : null, property_address: r.propertyAddress, territory_key: s.type === "territory" ? s.territoryKey : null,
    source_key: r.sourceKey, source_kind: r.sourceKind, confidence: r.confidence, identity_match: r.identity, event_relevance: r.eventRelevance,
    intents: [...r.intents], side: r.side, evidence: r.evidence, observed_at: r.observedAt, captured_by: r.capturedBy, sensitivity: r.sensitivity,
    protected_proxy: r.protectedProxy, targeting_prohibited: r.targetingProhibited, data_rights: r.dataRights, outreach: r.outreach, idempotency_key: r.idempotencyKey,
  }
}

const scorable = (row: MovementRow): ScorableMovement & { outreach: MovementOutreach } => ({
  id: row.id, sourceKey: row.source_key, eventRelevance: row.event_relevance, confidence: row.confidence, identity: row.identity_match,
  observedAt: row.observed_at, evidence: row.evidence, protectedProxy: row.protected_proxy, outreach: row.outreach,
})

/** The ledger WHY of a movement action (the m693 vocabulary — no new code, no CHECK owed). */
function movementReasonCode(rel: MovementRelevance | null): "SELLER_FOLLOWUP_INTENT_INCREASE" | "BUYER_PROPERTY_MATCH" | "NURTURE_TOUCH" | "NO_ACTION_NEEDED" {
  if (!rel || CONTEXT_RELEVANCE.has(rel)) return "NO_ACTION_NEEDED"
  if (rel === "property_event" || rel === "relocation" || rel === "probate_estate" || rel === "divorce") return "SELLER_FOLLOWUP_INTENT_INCREASE"
  if (rel === "seeking_agent") return "BUYER_PROPERTY_MATCH"
  return "NURTURE_TOUCH"
}

export interface MovementDeps {
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  publish?: typeof import("@/lib/kernel/manager-signals").publishManagerSignal
  respond?: typeof import("@/lib/ai-isa/followup-arbiter").respondToLifeChangeSignal
  routeToAgent?: typeof import("@/lib/ai-isa/followup-arbiter").routeToAgent
  notifyAdmins?: (p: { brokerageId: string; title: string; body: string; entityType: string; entityId: string | null }) => Promise<number>
  decide?: MovementDecide
  /** The tenant's life-event window (default: loadFollowupPolicy sphere.lifeEventWindowDays). */
  windowDays?: number
  now?: Date
}

async function windowDaysFor(svc: Svc, brokerageId: string, deps: MovementDeps): Promise<number> {
  if (typeof deps.windowDays === "number") return deps.windowDays
  const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
  return (await loadFollowupPolicy(svc as never, brokerageId)).policy.sphere.lifeEventWindowDays
}

export type MovementRecordResult =
  | { status: "recorded"; id: string; evaluation: MovementEvaluation | null }
  | { status: "replayed"; id: string | null }
  | { status: "refused"; code: string; reason: string }

/**
 * ONE C9 record → m892, behind ONE consumed-once ledger event (`intent.movement_signal.record`), then the subject is re-evaluated
 * (the manager's decision). `route: false` records only (a survivor door that already routed the fact). Never throws.
 */
export async function recordMovementSignal(svc: Svc, input: MovementSignalInput | MovementSignalRecord, deps: MovementDeps & { route?: boolean } = {}): Promise<MovementRecordResult> {
  try {
    // A pre-built record (the watcher's, with its change key) is RE-VALIDATED — the record-time rules hold on every path, never
    // only on the builder's; only its idempotency key is kept.
    const fields: MovementSignalInput = "idempotencyKey" in input
      ? { brokerageId: input.brokerageId, subject: input.subject, sourceKey: input.sourceKey, evidence: input.evidence, observedAt: input.observedAt, eventRelevance: input.eventRelevance, intents: input.intents, side: input.side, identity: input.identity, capturedBy: input.capturedBy, protectedProxy: input.protectedProxy, propertyAddress: input.propertyAddress }
      : input
    const built = buildMovementSignal(fields)
    if (!built.ok) return { status: "refused", code: built.code, reason: built.reason }
    const r: MovementSignalRecord = "idempotencyKey" in input ? { ...built.record, idempotencyKey: input.idempotencyKey } : built.record
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    let id: string | null = null
    // Set inside the ledger's callbacks (run / replay) — typed wide so the closure assignments are not narrowed away.
    let status = "replayed" as "recorded" | "replayed" | "refused"
    let reason = ""
    await ledger<"recorded" | "replayed" | "refused">(
      {
        brokerageId: r.brokerageId, action: "intent.movement_signal.record", actor: { type: "manager", managerKey: "data_steward" },
        subject: r.subject.type === "property" ? { type: "property", ref: r.subject.addressKey } : r.subject.type === "territory" ? { type: "territory", ref: r.subject.territoryKey } : { type: r.subject.type, id: r.subject.id },
        idempotencyKey: r.idempotencyKey, reasonCode: movementReasonCode(r.eventRelevance), systemSource: "movement_signals",
        reasonDetail: `${r.sourceKey} → ${r.eventRelevance} (${r.confidence}, identity ${r.identity})`.slice(0, 500),
        detail: { source_key: r.sourceKey, source_kind: r.sourceKind, confidence: r.confidence, event_relevance: r.eventRelevance, outreach: r.outreach, sensitivity: r.sensitivity, targeting_prohibited: r.targetingProhibited, data_rights: r.dataRights },
      },
      async () => {
        const { data, error } = await svc.from("movement_signals").insert(movementRowFor(r)).select("id").single()
        if (error) {
          if (String((error as { code?: string }).code) === "23505") return (status = "replayed")
          reason = `movement_signals insert refused: ${error.message}`
          return (status = "refused")
        }
        id = (data as { id: string }).id
        return (status = "recorded")
      },
      { settle: (s) => ({ status: s === "recorded" ? "executed" : s === "refused" ? "failed" : "skipped", outcome: s, error: s === "refused" ? reason : null }),
        // WAVE 147 (147Z — census II.2): a REFUSED claim recorded nothing — a refusal with its reason, never "replayed".
        replay: (claim) => (claim.kind === "refused" ? ((reason = `the action ledger refused the record: ${claim.error}`), (status = "refused")) : (status = "replayed")) },
      { client: svc as never },
    )
    if (status === "refused") return { status: "refused", code: "persist_refused", reason }
    if (status === "replayed" || !id) return { status: "replayed", id }
    const evaluation = deps.route === false || r.subject.type === "territory" ? null : await evaluateMovementSubject(svc, { brokerageId: r.brokerageId, subject: r.subject }, deps)
    return { status: "recorded", id, evaluation }
  } catch (e) {
    return { status: "refused", code: "threw", reason: e instanceof Error ? e.message : String(e) }
  }
}

export interface MovementEvaluation {
  status: "decided" | "replayed" | "refused" | "nothing_to_decide"
  reason: string
  combination?: MovementCombination
  decision?: MovementDecision
  routed?: { via: "bus" | "responder" | "agent_task" | "admins" | "none"; ok: boolean; detail?: string }
}

/** Resolve the subject class, tenant-pinned (C2: a converted lead is answered as its contact). */
async function subjectClassFor(svc: Svc, brokerageId: string, s: MovementSubject): Promise<{ ok: true; cls: MovementSubjectClass; contactId: string | null; leadId: string | null; agentId: string | null; zip: string | null } | { ok: false; reason: string }> {
  if (s.type === "property") return { ok: true, cls: "property", contactId: null, leadId: null, agentId: null, zip: null }
  if (s.type === "territory") return { ok: true, cls: "territory", contactId: null, leadId: null, agentId: null, zip: null }
  if (s.type === "raw_lead") return { ok: true, cls: "raw_lead", contactId: null, leadId: null, agentId: null, zip: null }
  let contactId: string | null = s.type === "contact" ? s.id : null
  const leadId: string | null = s.type === "lead" ? s.id : null
  if (s.type === "lead") {
    const { data, error } = await svc.from("leads").select("id, contact_id, is_active").eq("id", s.id).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `lead read refused: ${error.message}` }
    if (!data) return { ok: false, reason: "lead not in this brokerage" }
    const party = canonicalPartyFor(data as { id?: string | null; contact_id?: string | null })
    if (party.type === "contact") contactId = party.id
    else if ((data as { is_active?: boolean | null }).is_active === false) return { ok: false, reason: "inactive lead — out of every domain" }
    else return { ok: true, cls: "lead", contactId: null, leadId, agentId: null, zip: null }
  }
  const { data, error } = await svc.from("contacts").select("id, contact_type, agent_id, zip_code").eq("id", contactId).eq("brokerage_id", brokerageId).is("deleted_at", null).maybeSingle()
  if (error) return { ok: false, reason: `contact read refused: ${error.message}` }
  if (!data) return { ok: false, reason: "contact not in this brokerage" }
  const c = data as { contact_type?: string | null; agent_id?: string | null; zip_code?: string | null }
  const { isLifetimeRelationshipType } = await import("@/lib/contact-types")
  return { ok: true, cls: isLifetimeRelationshipType(c.contact_type ?? null) ? "lifetime" : "contact", contactId, leadId, agentId: c.agent_id ?? null, zip: c.zip_code ? String(c.zip_code).slice(0, 5) : null }
}

/** Read the subject's open movement rows inside the window (+ its territory's context) and the tenant's learned weights. */
async function loadSubjectEvidence(svc: Svc, brokerageId: string, s: MovementSubject, zip: string | null, contactId: string | null, sinceIso: string):
  Promise<{ ok: true; rows: MovementRow[]; weights: Record<string, number>; blind: string[] } | { ok: false; reason: string }> {
  const blind: string[] = []
  let q = svc.from("movement_signals").select("*").eq("brokerage_id", brokerageId).is("outcome", null).gte("observed_at", sinceIso)
  // C2: a converted lead is answered as its contact — and the traces recorded against the lead before conversion still count.
  if (contactId && s.type === "lead") q = q.or(`contact_id.eq.${contactId},lead_id.eq.${s.id}`)
  else if (contactId) q = q.eq("contact_id", contactId)
  else if (s.type === "lead") q = q.eq("lead_id", s.id)
  else if (s.type === "raw_lead") q = q.eq("raw_lead_id", s.id)
  else if (s.type === "property") q = q.eq("property_address_key", s.addressKey)
  else if (s.type === "territory") q = q.eq("territory_key", s.territoryKey)
  const { data, error } = await q.order("observed_at", { ascending: false }).limit(200)
  if (error) return { ok: false, reason: `movement_signals read refused: ${error.message}` }
  const rows = [...((data ?? []) as MovementRow[])]
  if (zip) {
    const { data: ctx, error: cErr } = await svc.from("movement_signals").select("*").eq("brokerage_id", brokerageId).eq("territory_key", `zip:${zip}`).gte("observed_at", sinceIso).limit(50)
    if (cErr) blind.push(`territory context not read (${cErr.message})`)
    else rows.push(...((ctx ?? []) as MovementRow[]))
  }
  const { data: closed, error: wErr } = await svc.from("movement_signals").select("source_key, outcome").eq("brokerage_id", brokerageId).not("outcome", "is", null).limit(2000)
  if (wErr) blind.push(`learned weights not read (${wErr.message}) — priors used`)
  const weights = wErr ? {} : weightsOf(movementSourceWeights((closed ?? []) as Array<{ source_key: string; outcome: string | null }>))
  return { ok: true, rows, weights, blind }
}

/**
 * THE MANAGER'S TURN for one subject: evidence → combination → closed menu → decision (AI inside the menu) → act → stamp the rows.
 * One ledger event per (subject, evidence set) — the same evidence is never decided twice; NEW evidence is a new decision. Never throws.
 */
async function evaluateMovementSubject(svc: Svc, a: { brokerageId: string; subject: MovementSubject }, deps: MovementDeps = {}): Promise<MovementEvaluation> {
  const now = deps.now ?? new Date()
  try {
    const cls = await subjectClassFor(svc, a.brokerageId, a.subject)
    if (!cls.ok) return { status: "refused", reason: cls.reason }
    const windowDays = await windowDaysFor(svc, a.brokerageId, deps)
    const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString()
    const ev = await loadSubjectEvidence(svc, a.brokerageId, a.subject, cls.zip, cls.contactId, since)
    if (!ev.ok) return { status: "refused", reason: ev.reason }
    const own = ev.rows.filter((r) => r.subject_type !== "territory")
    if (own.length === 0) return { status: "nothing_to_decide", reason: "no open movement evidence inside the window" }
    const combination = scoreMovementCombination(ev.rows.map(scorable), { now, weights: ev.weights })
    const allowed = allowedMovementActions(combination, ev.rows.map(scorable), { subjectClass: cls.cls })
    const ids = own.map((r) => r.id).sort()
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const manager = cls.cls === "lifetime" ? "sphere_of_influence" : cls.cls === "lead" || cls.cls === "contact" ? "ai_isa" : "data_steward"
    const subjectRef = cls.contactId ? { type: "contact", id: cls.contactId } : a.subject.type === "property" ? { type: "property", ref: a.subject.addressKey } : a.subject.type === "territory" ? { type: "territory", ref: a.subject.territoryKey } : { type: a.subject.type, id: a.subject.id }
    let out: MovementEvaluation = { status: "replayed", reason: "this evidence set was already decided — not decided twice", combination }
    await ledger<MovementEvaluation>(
      {
        brokerageId: a.brokerageId, action: "intent.movement_signal.decide", actor: { type: "manager", managerKey: manager }, subject: subjectRef,
        idempotencyKey: `movement_decide:${a.brokerageId}:${subjectKey(a.subject)}:${movementDigest(ids.join(","))}`, reasonCode: movementReasonCode(combination.dominantRelevance),
        reasonDetail: combination.explanation.slice(0, 500), systemSource: "movement_signals", policyKey: "followup_policy",
        detail: { score: combination.score, band: combination.band, dominant: combination.dominantRelevance, kinds: combination.independentKinds, caps: combination.caps, allowed: allowed.allowed, why: allowed.why, evidence_ids: ids, blind_spots: ev.blind },
      },
      async () => {
        const decision = await decideMovementNextAction({ brokerageId: a.brokerageId, subjectClass: cls.cls, combination, allowed }, { decide: deps.decide })
        const routed = await actOnMovementDecision(svc, { brokerageId: a.brokerageId, cls, combination, decision, rows: own, now }, deps)
        const { data: upd, error: uErr } = await svc.from("movement_signals")
          .update({ next_action: decision.action, decided_by: manager, decided_at: now.toISOString(), updated_at: now.toISOString(), decision: { source: decision.source, rationale: decision.rationale, helper_keys: decision.helperKeys, research_keys: decision.researchKeys, evidence: decision.evidence, confidence: decision.confidence, fallback_reason: decision.fallbackReason, score: combination.score, band: combination.band, explanation: combination.explanation.slice(0, 2000), routed } })
          .eq("brokerage_id", a.brokerageId).in("id", ids).select("id")
        const stamped = uErr ? 0 : (upd ?? []).length
        if (stamped !== ids.length) console.warn(`[movement-signals] decision stamped ${stamped} of ${ids.length} rows${uErr ? ` (${uErr.message})` : ""}`)
        return (out = { status: "decided", reason: `${decision.action} (${decision.source})${stamped !== ids.length ? ` — ${stamped}/${ids.length} rows stamped` : ""}`, combination, decision, routed })
      },
      { settle: (r) => ({ status: r.routed?.ok === false ? "failed" : "executed", outcome: r.decision?.action ?? r.status, error: r.routed?.ok === false ? r.routed.detail ?? "route refused" : null }),
        // WAVE 147 (147Z — census II.2): a REFUSED claim decided nothing — a refusal with its reason, never "already decided".
        replay: (claim) => (claim.kind === "refused" ? (out = { status: "refused", reason: `the action ledger refused the decision: ${claim.error}`, combination }) : out) },
      { client: svc as never },
    )
    return out
  } catch (e) {
    return { status: "refused", reason: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Carry the decision out through the EXISTING doors — the bus / the ONE responder / the agent's task / the admins. */
async function actOnMovementDecision(
  svc: Svc,
  a: { brokerageId: string; cls: { cls: MovementSubjectClass; contactId: string | null; leadId: string | null; agentId: string | null }; combination: MovementCombination; decision: MovementDecision; rows: MovementRow[]; now: Date },
  deps: MovementDeps,
): Promise<NonNullable<MovementEvaluation["routed"]>> {
  const dom = a.combination.dominantRelevance
  const decisive = a.rows.filter((r) => r.event_relevance === dom)
  const lead = decisive[0]
  if (a.decision.action === "research" || a.decision.action === "wait" || !dom || !lead) return { via: "none", ok: true, detail: a.decision.action }
  if (a.decision.action === "offer_help") {
    const t = lifeChangeTypeFor({ relevance: dom, side: lead.side, intents: lead.intents as IntentKind[], verified: decisive.some((r) => r.confidence === "verified") })
    if (!t) return { via: "none", ok: false, detail: `${dom} has no responder spelling (context never routes alone)` }
    if (a.cls.contactId) {
      const publish = deps.publish ?? (await import("@/lib/kernel/manager-signals")).publishManagerSignal
      const r = await publish({
        brokerageId: a.brokerageId, fromManager: "data_steward", toManager: "ai_isa", signalType: "online_intent_detected", dedupe: false,
        message: `Early movement signs (${dom.replace(/_/g, " ")}, score ${a.combination.score}) — the manager chose to offer help; the arbiter picks how.`,
        entityType: "contact", entityId: a.cls.contactId, contactId: a.cls.contactId,
        payload: { key: `movement:${dom}`, provider: "movement_signals", field: lead.source_key, intents: t.bus.intents, sensitivity: t.bus.sensitivity, movement_signal_ids: decisive.map((r) => r.id), score: a.combination.score, band: a.combination.band, helper_keys: a.decision.helperKeys },
      }, svc as never)
      return { via: "bus", ok: r.ok, detail: r.ok ? "online_intent_detected → the ONE life-change responder" : r.reason }
    }
    if (a.cls.leadId) {
      const respond = deps.respond ?? (await import("@/lib/ai-isa/followup-arbiter")).respondToLifeChangeSignal
      const r = await respond(svc as never, { brokerageId: a.brokerageId, subject: { type: "lead", id: a.cls.leadId }, signalType: t.responderType, strength: a.combination.score, source: `movement:${lead.source_key}`, now: a.now, detail: { movement_signal_ids: decisive.map((x) => x.id), band: a.combination.band } })
      return { via: "responder", ok: r.action !== "refused", detail: `${r.action}: ${r.reason}` }
    }
    return { via: "none", ok: false, detail: "offer_help needs a lead or contact" }
  }
  // HUMAN — a person, never an automated message. The words the person reads are redacted for intimate topics.
  const body = `${agentFacingMovementSummary({ eventRelevance: dom, evidence: lead.evidence, confidence: lead.confidence })} ${a.decision.rationale}`.slice(0, 880)
  if (a.cls.contactId && a.cls.agentId) {
    const route = deps.routeToAgent ?? (await import("@/lib/ai-isa/followup-arbiter")).routeToAgent
    const ok = await route(svc as never, { brokerageId: a.brokerageId, contactId: a.cls.contactId, agentId: a.cls.agentId, now: a.now, title: "A neighbourly moment to check in", description: body })
    return { via: "agent_task", ok, detail: ok ? "followup_moment_due task for the contact's agent" : "the agent task was refused" }
  }
  const notify = deps.notifyAdmins ?? (async (p) => (await import("@/lib/notifications/brokerage-admins")).notifyBrokerageAdmins(svc as never, p.brokerageId, { type: "movement_signal_review", title: p.title, body: p.body, entityType: p.entityType, entityId: p.entityId }))
  const n = await notify({ brokerageId: a.brokerageId, title: "Early movement signs need a person", body, entityType: a.cls.contactId ? "contact" : a.cls.leadId ? "lead" : "movement_signal", entityId: a.cls.contactId ?? a.cls.leadId ?? lead.id })
  return { via: "admins", ok: n > 0, detail: `${n} lead-desk admin(s) told` }
}

// ── OUTCOMES — close the loop (requirement 8) ────────────────────────────────────────────────────────────────────────────────

export type MovementOutcomeResult = { status: "recorded" | "replayed" | "refused"; reason: string }

/**
 * One outcome on one movement record, ledgered once (`intent.movement_signal.outcome`). The tenant is the caller's verified one.
 * EXPORTED (wave 147, lane 147Z — lane 147I U1 / lane 147B "Still open" 4): the human disposition door
 * (app/actions/movement-signals.ts markMovementSignalOutcomeAction — a lead-desk seat marks false_positive / declined) is its
 * product caller beside the automatic reconciler below.
 */
export async function recordMovementOutcome(
  svc: Svc,
  a: { brokerageId: string; signalId: string; outcome: MovementOutcome; evidence: Record<string, unknown>; actor: { type: "user"; userId: string } | { type: "manager"; managerKey: string }; now?: Date },
  deps: Pick<MovementDeps, "ledger"> = {},
): Promise<MovementOutcomeResult> {
  if (!a.brokerageId || !a.signalId) return { status: "refused", reason: "missing tenant or signal" }
  if (!(MOVEMENT_OUTCOMES as readonly string[]).includes(a.outcome)) return { status: "refused", reason: `"${a.outcome}" is not a movement outcome` }
  try {
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const now = a.now ?? new Date()
    let out: MovementOutcomeResult = { status: "replayed", reason: "this outcome was already recorded" }
    await ledger<MovementOutcomeResult>(
      {
        brokerageId: a.brokerageId, action: "intent.movement_signal.outcome", actor: a.actor.type === "user" ? { type: "user", userId: a.actor.userId } : { type: "manager", managerKey: a.actor.managerKey },
        subject: { type: "movement_signal", id: a.signalId }, idempotencyKey: `movement_outcome:${a.brokerageId}:${a.signalId}`, reasonCode: "NO_ACTION_NEEDED",
        reasonDetail: `outcome ${a.outcome}`, systemSource: "movement_signals", detail: { outcome: a.outcome, evidence: a.evidence },
      },
      async () => {
        const { data, error } = await svc.from("movement_signals").update({ outcome: a.outcome, outcome_at: now.toISOString(), outcome_evidence: a.evidence, updated_at: now.toISOString() })
          .eq("id", a.signalId).eq("brokerage_id", a.brokerageId).is("outcome", null).select("id")
        if (error) return (out = { status: "refused", reason: `update refused: ${error.message}` })
        // An UPDATE that matches nothing RESOLVES (CLAUDE.md §3) — count it.
        if ((data ?? []).length === 0) return (out = { status: "refused", reason: "no open movement record with that id in this brokerage" })
        return (out = { status: "recorded", reason: `${a.outcome} recorded` })
      },
      { settle: (r) => ({ status: r.status === "recorded" ? "executed" : "failed", outcome: r.status, error: r.status === "refused" ? r.reason : null }),
        // WAVE 147 (147Z — census II.2): a REFUSED claim recorded no outcome — said as a refusal, never "already recorded".
        replay: (claim) => (claim.kind === "refused" ? (out = { status: "refused", reason: `the action ledger refused the outcome: ${claim.error}` }) : out) },
      { client: svc as never },
    )
    return out
  } catch (e) {
    return { status: "refused", reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The outcome sweep: open movement records are closed by what actually happened — a listing for the person (listed), a
 * transaction (purchased), an opt-out (opted_out) — or, once the tenant's window has passed with nothing, no_change. Each close is
 * one ledgered outcome. Tenant-pinned; never throws; refused reads are counted and named.
 */
export async function reconcileMovementOutcomes(svc: Svc, brokerageId: string, deps: MovementDeps = {}): Promise<{ closed: Record<string, number>; scanned: number; errors: string[] }> {
  const out = { closed: {} as Record<string, number>, scanned: 0, errors: [] as string[] }
  try {
    const now = deps.now ?? new Date()
    const windowDays = await windowDaysFor(svc, brokerageId, deps)
    const { data, error } = await svc.from("movement_signals").select("id, contact_id, observed_at, event_relevance").eq("brokerage_id", brokerageId).is("outcome", null).not("contact_id", "is", null).limit(500)
    if (error) return { ...out, errors: [`movement_signals read refused: ${error.message}`] }
    const rows = (data ?? []) as Array<{ id: string; contact_id: string; observed_at: string }>
    out.scanned = rows.length
    const ids = [...new Set(rows.map((r) => r.contact_id))]
    if (ids.length === 0) return out
    const first = (m: Map<string, string>, k: string, at: string) => { const cur = m.get(k); if (!cur || at < cur) m.set(k, at) }
    const listed = new Map<string, string>(), bought = new Map<string, string>(), optedOut = new Map<string, string>()
    const { data: ls, error: lErr } = await svc.from("listings").select("seller_contact_id, contact_id, created_at").eq("brokerage_id", brokerageId).in("seller_contact_id", ids)
    if (lErr) out.errors.push(`listings read refused: ${lErr.message}`)
    for (const l of (lErr ? [] : ls ?? []) as Array<{ seller_contact_id: string | null; created_at: string | null }>) if (l.seller_contact_id && l.created_at) first(listed, l.seller_contact_id, l.created_at)
    const { data: tx, error: tErr } = await svc.from("transactions").select("buyer_contact_id, created_at, status").eq("brokerage_id", brokerageId).in("buyer_contact_id", ids)
    if (tErr) out.errors.push(`transactions read refused: ${tErr.message}`)
    for (const t of (tErr ? [] : tx ?? []) as Array<{ buyer_contact_id: string | null; created_at: string | null; status: string | null }>) if (t.buyer_contact_id && t.created_at && t.status !== "lost") first(bought, t.buyer_contact_id, t.created_at)
    const { data: cs, error: cErr } = await svc.from("contacts").select("id, opted_out_at").eq("brokerage_id", brokerageId).in("id", ids)
    if (cErr) out.errors.push(`contacts read refused: ${cErr.message}`)
    for (const c of (cErr ? [] : cs ?? []) as Array<{ id: string; opted_out_at: string | null }>) if (c.opted_out_at) optedOut.set(c.id, c.opted_out_at)
    for (const r of rows) {
      const after = (m: Map<string, string>) => { const at = m.get(r.contact_id); return at && at >= r.observed_at ? at : null }
      const lapsed = Date.parse(r.observed_at) < now.getTime() - windowDays * DAY_MS
      const verdict: { outcome: MovementOutcome; evidence: Record<string, unknown> } | null =
        after(optedOut) ? { outcome: "opted_out", evidence: { opted_out_at: after(optedOut) } }
          : after(listed) ? { outcome: "listed", evidence: { listing_created_at: after(listed) } }
          : after(bought) ? { outcome: "purchased", evidence: { transaction_created_at: after(bought) } }
          : lapsed ? { outcome: "no_change", evidence: { window_days: windowDays } } : null
      if (!verdict) continue
      const res = await recordMovementOutcome(svc, { brokerageId, signalId: r.id, outcome: verdict.outcome, evidence: verdict.evidence, actor: { type: "manager", managerKey: "data_steward" }, now }, deps)
      if (res.status === "recorded") out.closed[verdict.outcome] = (out.closed[verdict.outcome] ?? 0) + 1
      else if (res.status === "refused") out.errors.push(`${r.id}: ${res.reason}`)
    }
  } catch (e) {
    out.errors.push(`sweep threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}

// ── THE ARBITER'S HOOK — lib/ai-isa/followup-arbiter.ts loadLifeChangeSignals calls this (one-line wiring, lane 147G) ───────────

export interface ArbiterMovementContext { signals: LifeChangeSignal[]; helpers: NeighbourlyHelper[]; explanation: string | null; blindSpot: string | null }

/**
 * The movement evidence for ONE contact, combined, in the arbiter's own shape: at most one LifeChangeSignal for the dominant
 * relevance (its existing spelling, strength = the combination score), plus the neighbourly helpers the evidence supports and the
 * combination's own explanation. A refused read is a published blind spot, never a failed evaluation. Never throws.
 * WIRED (wave 147, lane 147Z): lib/ai-isa/followup-arbiter.ts MOVEMENT_SIGNAL_CONSUMER calls this with the arbiter's own window
 * (`sinceIso`, = followup_policy.sphere.lifeEventWindowDays); `windowDays` stays for direct callers. THE EPISTEMIC GATE (lane G's
 * seam contract + C9): the dominant relevance becomes a LifeChangeSignal only when at least one VERIFIED or REPORTED record
 * carries it — an inferred-only combination is evidence for research, never a life change the follow-up acts on.
 */
export async function movementSignalsForArbiter(svc: Svc, a: { brokerageId: string; contactId: string; now: Date; windowDays?: number; sinceIso?: string }): Promise<ArbiterMovementContext> {
  const empty = (blindSpot: string | null): ArbiterMovementContext => ({ signals: [], helpers: [], explanation: null, blindSpot })
  try {
    if (!a.brokerageId || !a.contactId) return empty("movement: no tenant or contact")
    const sinceMs = a.sinceIso ? Date.parse(a.sinceIso) : typeof a.windowDays === "number" ? a.now.getTime() - a.windowDays * DAY_MS : NaN
    if (!Number.isFinite(sinceMs)) return empty("movement: no window (sinceIso or windowDays) — nothing read")
    const since = new Date(sinceMs).toISOString()
    const { data: c, error: cErr } = await svc.from("contacts").select("id, zip_code").eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
    if (cErr) return empty(`movement: contact not read (${cErr.message})`)
    if (!c) return empty("movement: contact not in this brokerage")
    const ev = await loadSubjectEvidence(svc, a.brokerageId, { type: "contact", id: a.contactId }, (c as { zip_code?: string | null }).zip_code ? String((c as { zip_code: string }).zip_code).slice(0, 5) : null, a.contactId, since)
    if (!ev.ok) return empty(`movement: ${ev.reason}`)
    if (ev.rows.length === 0) return { ...empty(ev.blind.length ? `movement: ${ev.blind.join("; ")}` : null) }
    const combo = scoreMovementCombination(ev.rows.map(scorable), { now: a.now, weights: ev.weights })
    const allowed = allowedMovementActions(combo, ev.rows.map(scorable), { subjectClass: "contact" })
    const dom = combo.dominantRelevance
    const decisive = ev.rows.filter((r) => r.event_relevance === dom)
    // The epistemic gate: an inference (alone) never reads as a life change — the arbiter acts only on what a record verifies or reports.
    const grounded = decisive.filter((r) => r.confidence === "verified" || r.confidence === "reported")
    const t = dom && combo.band !== "none" && grounded.length > 0 ? lifeChangeTypeFor({ relevance: dom, side: grounded[0]?.side, intents: grounded[0]?.intents as IntentKind[], verified: grounded.some((r) => r.confidence === "verified") }) : null
    const newest = grounded.reduce((m, r) => Math.max(m, Date.parse(r.observed_at) || 0), 0)
    const signals: LifeChangeSignal[] = t ? [{ type: t.responderType, kind: t.kind, strength: combo.score, daysAgo: newest ? Math.max(0, Math.floor((a.now.getTime() - newest) / DAY_MS)) : 0 }] : []
    const blind = [...ev.blind, ...(dom && combo.band !== "none" && grounded.length === 0 ? [`the ${dom.replace(/_/g, " ")} evidence is inferred only — research, not a life change`] : [])]
    return { signals, helpers: signals.length > 0 ? allowed.helpers : [], explanation: combo.explanation, blindSpot: blind.length ? `movement: ${blind.join("; ")}` : null }
  } catch (e) {
    return empty(`movement: ${(e as Error)?.message ?? String(e)}`)
  }
}

// ── who sees what (requirement 10) ───────────────────────────────────────────────────────────────────────────────────────────

/** Raw movement signals are a LEAD-DESK read: the ONE roster (lib/auth/lead-visibility.ts) — m892's RLS mirrors it with
 *  public.is_lead_visible_role(). Agents read only agentFacingMovementSummary's words (an intimate event is never named to them). */
export const MOVEMENT_RAW_SIGNAL_VIEWERS: ReadonlySet<string> = LEAD_DESK_USER_TYPES

/** One movement record as the lead desk reads it (the human disposition door — app/actions/movement-signals.ts). */
export interface LeadDeskMovementRecord {
  id: string; subject: { type: string; id: string | null; ref: string | null }; sourceKey: string; relevance: MovementRelevance; confidence: EpistemicClass
  identity: IdentityMatch; observedAt: string; outcome: MovementOutcome | null; nextAction: MovementNextAction | null; evidence: string; protectedProxy: boolean
}

/**
 * WAVE 147 (lane 147Z — lane 147I U1, lane 147B "Still open" 4): the LEAD DESK's read of this tenant's movement records, newest
 * first — the evidence label says HOW we know (verified / reported / inferred), never more. The CALLER proves the seat is on
 * MOVEMENT_RAW_SIGNAL_VIEWERS and passes the SESSION tenant (§4); this reader pins every row to it. A refused read is said.
 */
export async function listMovementRecordsForLeadDesk(svc: Svc, a: { brokerageId: string; limit?: number; openOnly?: boolean }): Promise<{ records: LeadDeskMovementRecord[]; error: string | null }> {
  if (!a.brokerageId) return { records: [], error: "no tenant" }
  let q = svc.from("movement_signals")
    .select("id, subject_type, contact_id, lead_id, raw_lead_id, property_address_key, territory_key, source_key, confidence, identity_match, event_relevance, evidence, observed_at, outcome, next_action, protected_proxy")
    .eq("brokerage_id", a.brokerageId)
  if (a.openOnly) q = q.is("outcome", null)
  const { data, error } = await q.order("observed_at", { ascending: false }).limit(Math.min(Math.max(a.limit ?? 50, 1), 200))
  if (error) return { records: [], error: `movement records unreadable: ${error.message}` }
  const records = ((data ?? []) as Array<Record<string, any>>).map((r) => ({
    id: String(r.id),
    subject: { type: String(r.subject_type), id: r.contact_id ?? r.lead_id ?? r.raw_lead_id ?? null, ref: r.property_address_key ?? r.territory_key ?? null },
    sourceKey: String(r.source_key), relevance: r.event_relevance as MovementRelevance, confidence: r.confidence as EpistemicClass, identity: r.identity_match as IdentityMatch,
    observedAt: String(r.observed_at), outcome: (r.outcome ?? null) as MovementOutcome | null, nextAction: (r.next_action ?? null) as MovementNextAction | null,
    evidence: r.evidence ? `${(r.evidence as MovementEvidence).summary ?? ""} — ${movementEvidenceLabel(r.evidence as MovementEvidence)}` : "no evidence recorded",
    protectedProxy: r.protected_proxy === true,
  }))
  return { records, error: null }
}

/**
 * The PUBLISHED freshness of each no-push source (owner ruling 3: "its freshness published"; m893 names the lead desk as the
 * reader of movement_source_polls — the watcher, lib/intent/movement-source-watcher.ts, is its only writer). Read-only. A source
 * that never succeeded promises NO freshness (null), never a number it cannot keep.
 */
export async function movementSourceFreshness(svc: Svc, brokerageId: string): Promise<{ sources: Array<{ sourceKey: string; lastPolledAt: string | null; lastSuccessAt: string | null; lastError: string | null; promisedFreshnessMinutes: number | null }>; error: string | null }> {
  if (!brokerageId) return { sources: [], error: "no tenant" }
  const { data, error } = await svc.from("movement_source_polls").select("source_key, last_polled_at, last_success_at, last_error, promised_freshness_minutes").eq("brokerage_id", brokerageId).order("source_key", { ascending: true }).limit(100)
  if (error) return { sources: [], error: `source freshness unreadable: ${error.message}` }
  return {
    sources: ((data ?? []) as Array<Record<string, any>>).map((r) => ({
      sourceKey: String(r.source_key), lastPolledAt: r.last_polled_at ?? null, lastSuccessAt: r.last_success_at ?? null, lastError: r.last_error ?? null,
      promisedFreshnessMinutes: r.last_success_at && typeof r.promised_freshness_minutes === "number" ? r.promised_freshness_minutes : null,
    })),
    error: null,
  }
}

/** PURE. The words an agent (or any non-lead-desk reader) sees. An intimate event is never named outside the lead desk. */
function agentFacingMovementSummary(r: { eventRelevance: MovementRelevance; evidence: MovementEvidence; confidence: EpistemicClass }): string {
  if (INTIMATE_RELEVANCE.has(r.eventRelevance)) return "A sensitive, publicly recorded life event was noted for this person. Talk with your broker before reaching out, and never mention it — offer something genuinely useful instead."
  if (r.eventRelevance === "life_stage") return "A life change may be under way for this person (their own disclosure or a public profile). Reach out personally about something useful — never about the change itself."
  const what = r.eventRelevance.replace(/_/g, " ")
  return `Early ${what} signs: ${r.evidence.summary}. ${movementEvidenceLabel(r.evidence)}.`
}
