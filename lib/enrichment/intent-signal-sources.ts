// lib/enrichment/intent-signal-sources.ts
//
// INTENT / LIFE-CHANGE SIGNAL SOURCES — what the providers this OS ALREADY pays for can tell us, by their REAL response field,
// where the answer is stored, and the PURE reader that turns stored facts into signals (wave 144, lane 144E; owner ruling 11:
// "If a customer's life changes or online intent behaviour shows they are thinking of moving, possibly refinancing, etc., that
// TRIGGERS an action inside the platform … through a governed evaluation and next-best action in the existing manager fabric").
//
// THIS FILE DECIDES NOTHING. It is the SOURCE half lane 144F's arbiter / event reactor consumes (lib/kernel/signal-registry.ts
// is that lane's): every signal it returns is an OBSERVED FACT with its provider, field, observed-at and the intents it bears
// on — never a score, never a threshold, never a channel, never copy. "No invented behaviour": a fact absent from the record
// yields no signal; a value is never inferred from another. (Wave 145F: it also ROUTES a new fact — see THE WATCHER below — but
// the routing only delivers the fact to the ONE responder; the decision stays the manager's / the arbiter's.)
//
// WHAT IT NEVER RETURNS: a protected characteristic (race, religion, national origin, familial status, sex, disability) — the
// full-demographic adapter keeps them off every profile block (versium-client.ts VERSIUM_PROTECTED_CLASS_FIELD; since wave 145 they
// are stored ONLY in the segregated research home, protected-research-store.ts) and nothing here
// reads a field that names one. Age appears ONLY as the birthday-MONTH signal (cards; the education format by band — owner:
// "never age stereotyping"), flagged `sensitivity: "age"` so a consumer can keep it off any targeting surface (the ad arm of
// lib/lead-governance/protected-class-signals.ts refuses it there regardless). Life events (probate, divorce, relocation) are
// SERVICE TOPICS (owner ruling 17), never a targeting segment — flagged `sensitivity: "life_event"`.
//
// Respect source terms, privacy, consent, communication rules: a signal TRIGGERS an evaluation; it does not authorise a send.
// Consent, DNC/TCPA, frequency and the channel are the consumer's gates (lane F: followup-arbiter / contact-channel-policy).

import { realEstateIndicatorsFromProfile } from "@/lib/enrichment/online-presence-store"
import { onlineAudienceSummary } from "@/lib/enrichment/online-audience-store"
import { PROVIDER_FRESHNESS_DAYS, isFresh } from "@/lib/enrichment/provider-dedup"
import { fieldProvenanceOf } from "@/lib/lead-pipeline/enrichment-column-map"
import { canonicalPartyFor } from "@/lib/contact-promotion/lead-domain-boundary"

export type IntentKind = "moving" | "home_sale" | "home_purchase" | "refinance" | "property_engagement" | "market_engagement" | "life_event" | "relationship_moment"
export type SignalEntity = "raw_lead" | "lead" | "contact" | "lifetime_customer"

/** One provider-backed signal SOURCE — the census row lane F reads (and the notes' `## Signals available` table). */
export interface IntentSignalSource {
  key: string
  intents: readonly IntentKind[]
  provider: "versium" | "peopledata" | "batchdata" | "rentcast" | "osint" | "first_party"
  /** The capability on CONTACT_PROVIDER_ROUTES (or the first-party door) that produces it. */
  capability: string
  /** The provider's REAL response field(s), verbatim. */
  responseFields: readonly string[]
  /** Where the answer is stored today (table.column or enrichment_profile path); null = available but not stored. */
  storedAt: string | null
  entities: readonly SignalEntity[]
  sensitivity: "property_fact" | "behaviour" | "life_event" | "age" | "engagement"
  /** Where the field was verified. */
  docs: string
}

const VD = "https://api-documentation.versium.com/reference"

/** THE CENSUS — providers the OS already has, each field verified against its vendor's documentation (dates in the notes). */
export const INTENT_SIGNAL_SOURCES: readonly IntentSignalSource[] = Object.freeze([
  // ── Versium full_demographic (online_presence capability) — stored by online-presence-store.ts ──
  { key: "online_real_estate_activity", intents: ["moving", "home_sale", "home_purchase", "property_engagement"], provider: "versium", capability: "online_presence", responseFields: ["Online Presence Indicator - Real Estate"], storedAt: "contacts.enrichment_profile.real_estate_indicators.onlinePresenceRealEstate", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "behaviour", docs: `${VD}/full-demographic-insights` },
  { key: "refinance_date", intents: ["refinance"], provider: "versium", capability: "online_presence", responseFields: ["Refinance Date"], storedAt: "contacts.enrichment_profile.real_estate_indicators.refinanceDate", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "property_fact", docs: `${VD}/full-demographic-insights` },
  { key: "mortgage_purchase_date", intents: ["moving", "home_sale", "refinance"], provider: "versium", capability: "online_presence", responseFields: ["Mortgage Purchase Date"], storedAt: "contacts.enrichment_profile.real_estate_indicators.mortgagePurchaseDate", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "property_fact", docs: `${VD}/full-demographic-insights` },
  { key: "length_of_residence", intents: ["moving", "home_sale"], provider: "versium", capability: "online_presence", responseFields: ["Length of Residence"], storedAt: "contacts.enrichment_profile.real_estate_indicators.lengthOfResidence", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "property_fact", docs: `${VD}/full-demographic-insights` },
  { key: "home_sales_transaction", intents: ["home_sale", "home_purchase"], provider: "versium", capability: "online_presence", responseFields: ["Home Sales Transaction"], storedAt: "contacts.enrichment_profile.real_estate_indicators.homeSalesTransaction", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "property_fact", docs: `${VD}/full-demographic-insights` },
  { key: "investor_activity", intents: ["home_purchase", "property_engagement"], provider: "versium", capability: "online_presence", responseFields: ["Investing Real Estate", "Investing Estimated Residential Properties Owned"], storedAt: "contacts.enrichment_profile.real_estate_indicators.investingRealEstate", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "behaviour", docs: `${VD}/full-demographic-insights` },
  { key: "home_improvement_interest", intents: ["home_sale", "property_engagement"], provider: "versium", capability: "online_presence", responseFields: ["Home Improvement", "Lifestyles Home Improvement", "Decorating and Furnishing"], storedAt: "contacts.enrichment_profile.real_estate_indicators.homeImprovementInterest", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "behaviour", docs: `${VD}/full-demographic-insights` },
  // ── Versium Online Audience (online_audience_match) — a MATCH fact only (the person has linked online identifiers) ──
  { key: "online_audience_matched", intents: ["market_engagement"], provider: "versium", capability: "online_audience_match", responseFields: ["match_counts.online_audience"], storedAt: "contacts.enrichment_profile.online_audience.identifier_count", entities: ["contact", "lifetime_customer"], sensitivity: "engagement", docs: `${VD}/online-audience-append-api-new` },
  // ── Versium demographic (basic) — DOB is YEAR+MONTH only ──
  { key: "birthday_month", intents: ["relationship_moment"], provider: "versium", capability: "owner_contact", responseFields: ["DOB"], storedAt: "contacts.enrichment_profile.birth_year_month", entities: ["contact", "lifetime_customer"], sensitivity: "age", docs: `${VD}/demographic-output-sample` },
  // ── PeopleData (person_profile) ──
  { key: "location_history", intents: ["moving"], provider: "peopledata", capability: "person_profile", responseFields: ["location_names", "location_metro"], storedAt: "contacts.enrichment_profile.location_history", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "life_event", docs: "https://docs.peopledatalabs.com/docs/fields" },
  { key: "job_change", intents: ["moving", "home_purchase", "life_event"], provider: "peopledata", capability: "person_profile", responseFields: ["job_start_date", "job_company_name", "job_title"], storedAt: "contacts.enrichment_profile.job_start_date", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "life_event", docs: "https://docs.peopledatalabs.com/docs/fields" },
  { key: "birth_date", intents: ["relationship_moment"], provider: "peopledata", capability: "person_profile", responseFields: ["birth_date"], storedAt: "contacts.enrichment_profile.birth_date", entities: ["contact", "lifetime_customer"], sensitivity: "age", docs: "https://docs.peopledatalabs.com/docs/fields" },
  // ── BatchData seller signals (motivated_seller_list) — stored as rows by lib/external/batchdata-seller-signals.ts ──
  { key: "batchdata_seller_signal", intents: ["home_sale"], provider: "batchdata", capability: "motivated_seller_list", responseFields: ["quickLists (preforeclosure, absentee-owner, vacant, high-equity, tax-default, inherited, expired / withdrawn listing …)"], storedAt: "motivated_seller_signals.signal_type", entities: ["raw_lead", "lead", "contact"], sensitivity: "property_fact", docs: "https://developer.batchdata.com/docs/batchdata/batchdata-v1/operations/create-a-property-search" },
  // ── OSINT people search (ZenRows) — public life events ──
  { key: "public_life_event", intents: ["life_event", "moving", "home_sale"], provider: "osint", capability: "person.osint_search", responseFields: ["life_events[].type", "last_life_event_detected"], storedAt: "contacts.life_events / contacts.last_life_event_detected", entities: ["contact", "lifetime_customer"], sensitivity: "life_event", docs: "lib/osint-client.ts (public-web search; no vendor schema)" },
  // ── First-party (no provider) — the person's own actions ──
  { key: "home_anniversary", intents: ["relationship_moment", "home_sale", "refinance"], provider: "first_party", capability: "crm.home_anniversary", responseFields: ["contacts.home_anniversary"], storedAt: "contacts.home_anniversary", entities: ["lifetime_customer"], sensitivity: "property_fact", docs: "scripts/schema-snapshot.ts (contacts)" },
  { key: "home_value_request", intents: ["home_sale", "refinance"], provider: "first_party", capability: "signal.home_value_seller_intent", responseFields: ["home_value_seller_intent (manager signal)"], storedAt: "manager_signals.signal_type", entities: ["lead", "contact", "lifetime_customer"], sensitivity: "engagement", docs: "lib/kernel/signal-registry.ts" },
] satisfies readonly IntentSignalSource[])

/** One observed signal — a FACT with its provenance; the consumer decides what (if anything) to do. */
export interface ObservedIntentSignal {
  key: string
  intents: readonly IntentKind[]
  provider: IntentSignalSource["provider"]
  field: string
  /** The fact, as stored (a date, a band, a boolean true, a count) — never a derived score. */
  value: string | number | boolean
  /** When the provider observed / we stored it (null when the record does not say). */
  observedAt: string | null
  /** Whole months since `value` when `value` is a date (a duration the consumer can reason about; no threshold applied). */
  monthsSince: number | null
  sensitivity: IntentSignalSource["sensitivity"]
}

const SOURCE = new Map(INTENT_SIGNAL_SOURCES.map((s) => [s.key, s]))
const monthsBetween = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))]
  if (!y || !m) return null
  const months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m)
  return months >= 0 ? months : null
}

/**
 * PURE — the signals a contact's STORED record carries. Reads only stored facts (no call, no spend); a fact absent from the
 * record yields nothing. `now` is injectable so the proof is deterministic.
 */
export function intentSignalsFromContact(
  contact: {
    enrichment_profile?: Record<string, unknown> | null
    life_events?: unknown
    last_life_event_detected?: string | null
    home_anniversary?: string | null
  },
  now: Date = new Date(),
): ObservedIntentSignal[] {
  const out: ObservedIntentSignal[] = []
  const push = (key: string, field: string, value: string | number | boolean | null | undefined, observedAt: string | null, dated = false) => {
    if (value === null || value === undefined || value === "" || value === false) return
    const s = SOURCE.get(key)
    if (!s) return
    out.push({ key, intents: s.intents, provider: s.provider, field, value, observedAt, monthsSince: dated && typeof value === "string" ? monthsBetween(value, now) : null, sensitivity: s.sensitivity })
  }
  const profile = contact.enrichment_profile && typeof contact.enrichment_profile === "object" ? contact.enrichment_profile : null
  const ind = realEstateIndicatorsFromProfile(profile)
  if (ind) {
    const at = ind.capturedAt
    push("online_real_estate_activity", "Online Presence Indicator - Real Estate", ind.onlinePresenceRealEstate === true ? true : null, at)
    push("refinance_date", "Refinance Date", ind.refinanceDate, at, true)
    push("mortgage_purchase_date", "Mortgage Purchase Date", ind.mortgagePurchaseDate, at, true)
    push("length_of_residence", "Length of Residence", ind.lengthOfResidence, at)
    push("home_sales_transaction", "Home Sales Transaction", ind.homeSalesTransaction, at)
    push("investor_activity", "Investing Real Estate", ind.investingRealEstate === true ? true : null, at)
    push("home_improvement_interest", "Home Improvement", ind.homeImprovementInterest === true ? true : null, at)
  }
  const oa = onlineAudienceSummary(profile)
  if (oa?.matched) push("online_audience_matched", "match_counts.online_audience", oa.identifierCount, oa.capturedAt)
  const capturedAt = profile && typeof profile.captured_at === "string" ? (profile.captured_at as string) : null
  if (profile && typeof profile.birth_year_month === "string") push("birthday_month", "DOB", profile.birth_year_month as string, capturedAt)
  if (profile && typeof profile.birth_date === "string") push("birth_date", "birth_date", profile.birth_date as string, capturedAt)
  if (profile && Array.isArray(profile.location_history) && profile.location_history.length > 1) push("location_history", "location_names", (profile.location_history as unknown[]).length, capturedAt)
  if (profile && typeof profile.job_start_date === "string") push("job_change", "job_start_date", profile.job_start_date as string, capturedAt, true)
  const lifeTypes = Array.isArray(contact.life_events)
    ? (contact.life_events as unknown[]).map((e) => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).type ?? "") : "")).filter(Boolean)
    : []
  if (lifeTypes.length > 0) push("public_life_event", "life_events[].type", [...new Set(lifeTypes)].join(","), contact.last_life_event_detected ?? null)
  if (contact.home_anniversary) push("home_anniversary", "contacts.home_anniversary", contact.home_anniversary, null, true)
  return out
}

// ── THE PUSH (wave 144, lane 144Z — rulings 10 + 11; lane 144F Still open 11) ──────────────────────────────────────────────
// The facts above were only PULLED: read on a contact's next evaluation, so a newly stored behaviour / life-event fact triggered
// nothing by itself. The writers that land them (online-presence-store.ts persistRealEstateIndicators, contact-enrichment-core.ts
// enrichContactRecord + runLifeChangeCheck) now hand their BEFORE / AFTER rows here, and each NEW fact a change can rest on is
// published once on the manager bus (`online_intent_detected`, Data Steward → AI ISA — lib/kernel/signal-registry.ts), whose
// registered handler answers it through the ONE life-change responder. Only `behaviour` and `life_event` facts are a change (the
// source's own sensitivity flag — never a threshold invented here): an `age` fact never leaves this module, a stored property fact
// is history the equity / refinance triggers own.
//
// ── THE WATCHER (wave 145, lane 145F — owner ruling 11: "revisit versium enrichment and how intent signals are going to read them
// when it happens. need a watcher or something") ─────────────────────────────────────────────────────────────────────────────
// SOURCE UPDATE → FIELD / PROVENANCE CHANGE → INTENT EVALUATION → CANONICAL PERSON → SIGNAL REACTIVATION → EXISTING MANAGER / ARBITER
// → NEXT-BEST ACTION. Every NEW behaviour / life-event fact becomes ONE durable event — an agent_action_ledger row
// (`enrichment.intent_fact.observed`, Data Steward) keyed by the FACT (provider + key + value: a re-capture of an unchanged value is
// NOT a change — the 144Z diff keyed on the observation time too, so a stale re-buy that re-stamped captured_at re-announced every
// unchanged fact) and carrying source, field, provenance (the block's field_provenance stamp) and freshness. The ledger's unique
// idempotency key makes it consumed ONCE: a retry, a second writer or the sweep replays, never routes twice. It is routed to the
// CANONICAL party (contract C2 — a lead whose contact_id is set is OUT of the lead domain and is answered as its contact):
//   · a contact → ONE `online_intent_detected` bus line PER FACT (dedupe off: a second fact is no longer absorbed by an open line)
//     → the AI ISA's handler → the ONE life-change responder (lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal);
//   · a lead without a contact → that SAME responder with subject `lead` (it records the lead's signal_reactivations row for the
//     ISA's lead loops — leads are reached by email / mail only). The bus handler resolves contacts only.
// Two doors, one key: the writers' push (publishNewIntentFacts — BEFORE / AFTER diff at the write) and the sweep
// (watchEnrichmentFactChanges — rows any writer, the queue drain included, stamped since the cursor; run on the 15-minute
// enrichment-processor tick). FRESHNESS: a fact is routed only inside BOTH its provider's window (provider-dedup.ts
// PROVIDER_FRESHNESS_DAYS) and the tenant's life-event window (followup_policy.sphere.lifeEventWindowDays — the arbiter admits nothing
// older); an undated fact counts as observed at the write that stored it. NO PROVIDER IS CALLED HERE: Versium and PeopleData do not
// push, so a fact exists only once OUR budget-gated, gap-only enrichment stored it — the sweep never invents a real-time signal.

/** PURE. A short, stable digest of a fact value (FNV-1a) — the value itself (a life-event type, a date) never rides the key. */
function factDigest(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, "0")
}

/** PURE. A fact's identity — provider + key + value. Never the observation time (a re-captured unchanged value is the same fact). */
function intentFactKey(fact: Pick<ObservedIntentSignal, "provider" | "key" | "value">): string {
  return `${fact.provider}:${fact.key}:${factDigest(String(fact.value))}`
}

/** PURE. The behaviour / life-event facts the AFTER row carries that the BEFORE row did not (same fact identity — intentFactKey). */
export function newIntentFacts(
  before: Parameters<typeof intentSignalsFromContact>[0] | null | undefined,
  after: Parameters<typeof intentSignalsFromContact>[0],
  now: Date = new Date(),
): ObservedIntentSignal[] {
  const seen = new Set((before ? intentSignalsFromContact(before, now) : []).map(intentFactKey))
  return intentSignalsFromContact(after, now).filter((o) => isChangeFact(o) && !seen.has(intentFactKey(o)))
}

/** Only the source's own `behaviour` / `life_event` sensitivity is a change (age never; a stored property fact is history). */
const isChangeFact = (o: ObservedIntentSignal): boolean => o.sensitivity === "behaviour" || o.sensitivity === "life_event"

/** The provider windows (provider-dedup.ts PROVIDER_FRESHNESS_DAYS — one table) a fact's observation must sit inside. */
const PROVIDER_WINDOW_DAYS: Partial<Record<IntentSignalSource["provider"], number>> = {
  versium: PROVIDER_FRESHNESS_DAYS.versium_online_presence,
  peopledata: PROVIDER_FRESHNESS_DAYS.peopledata_profile,
}

interface IntentFactFreshness {
  /** The observation the window is measured from (the fact's own date, else the write that stored it). */
  observedAt: string
  dated: boolean
  windowDays: number
  fresh: boolean
}

/** PURE. Is the fact still current? Inside its provider window AND the tenant's life-event window (a missing / future time is not). */
function intentFactFreshness(fact: ObservedIntentSignal, writtenAt: string, lifeEventWindowDays: number, now: Date): IntentFactFreshness {
  const observedAt = fact.observedAt ?? writtenAt
  const windowDays = Math.min(PROVIDER_WINDOW_DAYS[fact.provider] ?? lifeEventWindowDays, lifeEventWindowDays)
  return { observedAt, dated: fact.observedAt !== null, windowDays, fresh: isFresh(observedAt, windowDays, now) }
}

/** Where each source's provenance stamp lives in enrichment_profile.field_provenance (the ONE provenance shape, wave 100C). */
const PROVENANCE_KEY: Readonly<Record<string, string>> = Object.freeze({
  online_real_estate_activity: "real_estate_indicators", investor_activity: "real_estate_indicators", home_improvement_interest: "real_estate_indicators",
  public_life_event: "life_events", location_history: "location_history", job_change: "job_start_date",
})

/** PURE. The provenance a routed fact carries: the source census row + the stored stamp (null when the record holds none — said). */
function intentFactProvenance(fact: ObservedIntentSignal, record: Parameters<typeof intentSignalsFromContact>[0]): Record<string, unknown> {
  const s = SOURCE.get(fact.key)
  const stamp = fieldProvenanceOf(record.enrichment_profile ?? null)[PROVENANCE_KEY[fact.key] ?? fact.key]
  const st = stamp && typeof stamp === "object" ? (stamp as Record<string, unknown>) : null
  return {
    provider: fact.provider, capability: s?.capability ?? null, field: fact.field, stored_at: s?.storedAt ?? null, docs: s?.docs ?? null,
    stamp: st ? { source: st.source ?? null, capability: st.capability ?? null, retrieved_at: st.retrievedAt ?? null, purpose: st.purpose ?? null, match_confidence: st.matchConfidence ?? null } : null,
  }
}

/** The canonical party a fact is answered for (contract C2). */
type IntentParty = { type: "contact"; id: string } | { type: "lead"; id: string }

/**
 * PURE (contract C2). TOMBSTONE (wave 145, lane 145Z — lane 145F Outside-lane 5): the inline lead/contact rule that stood here
 * ("a lead with a contact_id is answered as that contact … otherwise the lead itself") is merged onto its named survivor,
 * lib/contact-promotion/lead-domain-boundary.ts canonicalPartyFor. What this adapter KEEPS of its own: an INACTIVE lead with no
 * contact is out of every domain (nothing to answer) — the boundary has no is_active input, so that half stays here.
 */
function canonicalIntentParty(lead: { id: string; contact_id?: string | null; is_active?: boolean | null }): IntentParty | null {
  const party = canonicalPartyFor({ id: lead.id, contact_id: lead.contact_id ?? null })
  if (party.type === "contact") return { type: "contact", id: party.id }
  if (party.type !== "lead") return null
  if (lead.is_active === false) return null
  return { type: "lead", id: party.id }
}

type IntentFactRoute = "routed" | "replayed" | "refused" | "not_a_change"

export interface IntentFactDeps {
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  publish?: typeof import("@/lib/kernel/manager-signals").publishManagerSignal
  respond?: typeof import("@/lib/ai-isa/followup-arbiter").respondToLifeChangeSignal
  /** The tenant's life-event window (default: loadFollowupPolicy). */
  lifeEventWindowDays?: number
}

/** The ledger WHY of a routed fact — from the responder's kind vocabulary (LIFE_CHANGE_SIGNAL_KINDS), never a second one. */
function intentFactReasonCode(kind: string | undefined): "SELLER_FOLLOWUP_INTENT_INCREASE" | "PROPERTY_VALUE_CHANGE" | "BUYER_PROPERTY_MATCH" | "NURTURE_TOUCH" {
  if (kind === "home_sale" || kind === "moving") return "SELLER_FOLLOWUP_INTENT_INCREASE"
  if (kind === "equity" || kind === "refinance") return "PROPERTY_VALUE_CHANGE"
  if (kind === "buying") return "BUYER_PROPERTY_MATCH"
  return "NURTURE_TOUCH"
}

/**
 * ONE fact → ONE durable, consumed-once event → its canonical party. Never throws (a refusal is the return value). The brokerage and
 * the party are the CALLER's verified target (a writer's tenant-anchored row, the sweep's tenant-pinned read) — never a payload.
 */
async function routeIntentFact(
  svc: unknown,
  a: { brokerageId: string; party: IntentParty; fact: ObservedIntentSignal; freshness: IntentFactFreshness; provenance: Record<string, unknown>; door: "writer_push" | "sweep" },
  deps: IntentFactDeps,
): Promise<IntentFactRoute> {
  try {
    const arbiter = await import("@/lib/ai-isa/followup-arbiter")
    const signalType = arbiter.intentFactSignalType(a.fact)
    if (!signalType) return "not_a_change"
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const factKey = intentFactKey(a.fact)
    const idempotencyKey = `intent_fact:${a.brokerageId}:${a.party.type}:${a.party.id}:${factKey}`
    let out: IntentFactRoute = "replayed"
    await ledger<IntentFactRoute>(
      {
        brokerageId: a.brokerageId, action: "enrichment.intent_fact.observed", actor: { type: "manager", managerKey: "data_steward" },
        subject: { type: a.party.type, id: a.party.id }, idempotencyKey, reasonCode: intentFactReasonCode(arbiter.LIFE_CHANGE_SIGNAL_KINDS[signalType]),
        reasonDetail: `${a.fact.provider} · ${a.fact.field} → ${signalType} (${a.door})`.slice(0, 500), systemSource: "enrichment_fact_watcher",
        detail: { fact_key: factKey, key: a.fact.key, signal_type: signalType, sensitivity: a.fact.sensitivity, intents: [...a.fact.intents], freshness: a.freshness, provenance: a.provenance, door: a.door },
      },
      async () => {
        if (a.party.type === "contact") {
          const publish = deps.publish ?? (await import("@/lib/kernel/manager-signals")).publishManagerSignal
          const r = await publish({
            brokerageId: a.brokerageId, fromManager: "data_steward", toManager: "ai_isa", signalType: "online_intent_detected",
            message: `A provider we already use recorded a new ${a.fact.sensitivity === "life_event" ? "life-event" : "online-intent"} fact (${a.fact.provider} · ${a.fact.field}).`,
            entityType: "contact", entityId: a.party.id, contactId: a.party.id, dedupe: false,
            payload: { key: a.fact.key, provider: a.fact.provider, field: a.fact.field, intents: [...a.fact.intents], sensitivity: a.fact.sensitivity, observed_at: a.fact.observedAt, fact_key: factKey, idempotency_key: idempotencyKey, freshness: a.freshness, provenance: a.provenance, door: a.door },
          }, svc as never)
          if (!r.ok) console.warn(`[intent-signal-sources] online_intent_detected not published for ${a.party.id}: ${r.reason ?? "refused"}`)
          return (out = r.ok ? "routed" : "refused")
        }
        const respond = deps.respond ?? arbiter.respondToLifeChangeSignal
        const r = await respond(svc as never, {
          brokerageId: a.brokerageId, subject: { type: "lead", id: a.party.id }, signalType, source: `enrichment:${a.fact.provider}`,
          detail: { key: a.fact.key, field: a.fact.field, fact_key: factKey, door: a.door },
        })
        if (r.action === "refused") console.warn(`[intent-signal-sources] lead ${a.party.id} fact not answered: ${r.reason}`)
        return (out = r.action === "refused" ? "refused" : "routed")
      },
      { settle: (r) => ({ status: r === "routed" ? "executed" : r === "refused" ? "failed" : "skipped", outcome: r, error: r === "refused" ? "the route refused (see the log line)" : null }), replay: () => (out = "replayed") },
      { client: svc as never },
    )
    return out
  } catch (e) {
    console.warn("[intent-signal-sources] fact route threw (non-blocking):", e instanceof Error ? e.message : e)
    return "refused"
  }
}

/** The tenant's life-event window (the arbiter's admission window), read once per call; the platform default when unreadable. */
async function lifeEventWindowFor(svc: unknown, brokerageId: string, deps: IntentFactDeps): Promise<number> {
  if (typeof deps.lifeEventWindowDays === "number") return deps.lifeEventWindowDays
  const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
  return (await loadFollowupPolicy(svc as never, brokerageId)).policy.sphere.lifeEventWindowDays
}

export interface IntentFactTally { published: number; refused: number; replayed: number; stale: number }

/** Route a list of candidate facts for ONE party: fresh → routeIntentFact; stale → counted, never routed. */
async function routeFacts(
  svc: unknown,
  a: { brokerageId: string; party: IntentParty; facts: ObservedIntentSignal[]; record: Parameters<typeof intentSignalsFromContact>[0]; writtenAt: string; windowDays: number; now: Date; door: "writer_push" | "sweep" },
  deps: IntentFactDeps,
  tally: IntentFactTally,
): Promise<void> {
  for (const fact of a.facts) {
    const freshness = intentFactFreshness(fact, a.writtenAt, a.windowDays, a.now)
    if (!freshness.fresh) { tally.stale++; continue }
    const r = await routeIntentFact(svc, { brokerageId: a.brokerageId, party: a.party, fact, freshness, provenance: intentFactProvenance(fact, a.record), door: a.door }, deps)
    if (r === "routed") tally.published++
    else if (r === "replayed") tally.replayed++
    else if (r === "refused") tally.refused++
  }
}

/**
 * THE WRITERS' DOOR. Each NEW behaviour / life-event fact a write landed on a contact (newIntentFacts) → its own durable, consumed-
 * once event → ONE `online_intent_detected` bus line (routeIntentFact). The brokerage and contact are the WRITER's verified target,
 * never a payload. Never throws: a refused route is counted and logged — the write it follows already succeeded and is not undone.
 */
export async function publishNewIntentFacts(
  svc: unknown,
  target: { brokerageId: string; contactId: string },
  before: Parameters<typeof intentSignalsFromContact>[0] | null | undefined,
  after: Parameters<typeof intentSignalsFromContact>[0],
  now: Date = new Date(),
  deps: IntentFactDeps = {},
): Promise<IntentFactTally> {
  const tally: IntentFactTally = { published: 0, refused: 0, replayed: 0, stale: 0 }
  const fresh = newIntentFacts(before, after, now)
  if (fresh.length === 0 || !target.brokerageId || !target.contactId) return tally
  try {
    const windowDays = await lifeEventWindowFor(svc, target.brokerageId, deps)
    await routeFacts(svc, { brokerageId: target.brokerageId, party: { type: "contact", id: target.contactId }, facts: fresh, record: after, writtenAt: now.toISOString(), windowDays, now, door: "writer_push" }, deps, tally)
  } catch (e) {
    // Whatever was not yet accounted for when it threw is a refusal (never silently "fine").
    const accounted = tally.published + tally.replayed + tally.stale + tally.refused
    tally.refused += Math.max(0, fresh.length - accounted)
    console.warn("[intent-signal-sources] publish threw (non-blocking):", e instanceof Error ? e.message : e)
  }
  return tally
}

export interface EnrichmentWatchResult extends IntentFactTally {
  contactsScanned: number
  leadsScanned: number
  /** Leads routed to their contact (C2) / leads with no party (inactive, no contact). */
  leadsAsContact: number
  leadsOutOfDomain: number
  errors: string[]
}

/** The newest enrichment stamp a row carries (the moment its undated facts were stored). */
const newestStamp = (...stamps: Array<string | null | undefined>): string | null => {
  const ts = stamps.map((s) => (s ? Date.parse(s) : NaN)).filter((t) => Number.isFinite(t))
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null
}

/**
 * THE SWEEP — the watcher's second door, for every writer that does not push (the queue drain's lead AND contact branches, a
 * hand edit of enrichment_profile, a future writer). Reads, tenant-pinned, the contacts and leads whose enrichment stamps moved
 * since the cursor (`windowMinutes`, default 6 h — wider than the 15-minute tick that runs it, so a missed tick loses nothing;
 * the fact key makes the overlap free), takes each behaviour / life-event fact OBSERVED since the cursor (an older carried fact
 * is not new), and routes it to its canonical party. Never calls a provider; never throws; every refused read is counted.
 */
export async function watchEnrichmentFactChanges(
  svc: { from: (t: string) => any },
  brokerageId: string,
  opts: { now?: Date; windowMinutes?: number; limit?: number } = {},
  deps: IntentFactDeps = {},
): Promise<EnrichmentWatchResult> {
  const out: EnrichmentWatchResult = { published: 0, refused: 0, replayed: 0, stale: 0, contactsScanned: 0, leadsScanned: 0, leadsAsContact: 0, leadsOutOfDomain: 0, errors: [] }
  if (!brokerageId) return { ...out, errors: ["no brokerage"] }
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - (opts.windowMinutes ?? 360) * 60_000).toISOString()
  const limit = opts.limit ?? 200
  const sinceMs = Date.parse(since)
  const observedSince = (f: ObservedIntentSignal, writtenAt: string) => Date.parse(f.observedAt ?? writtenAt) >= sinceMs
  try {
    const windowDays = await lifeEventWindowFor(svc, brokerageId, deps)

    const { data: contacts, error: cErr } = await svc.from("contacts")
      .select("id, enrichment_profile, life_events, last_life_event_detected, home_anniversary, last_enriched_at, enriched_at")
      .eq("brokerage_id", brokerageId).is("deleted_at", null)
      .or(`last_enriched_at.gte.${since},enriched_at.gte.${since},last_life_event_detected.gte.${since}`)
      .limit(limit)
    if (cErr) out.errors.push(`contacts read refused: ${cErr.message}`)
    for (const c of (cErr ? [] : (contacts ?? [])) as Array<Record<string, any>>) {
      out.contactsScanned++
      const writtenAt = newestStamp(c.last_enriched_at, c.enriched_at, c.last_life_event_detected) ?? now.toISOString()
      const facts = intentSignalsFromContact(c, now).filter((f) => isChangeFact(f) && observedSince(f, writtenAt))
      await routeFacts(svc, { brokerageId, party: { type: "contact", id: String(c.id) }, facts, record: c, writtenAt, windowDays, now, door: "sweep" }, deps, out)
    }

    const { data: leads, error: lErr } = await svc.from("leads")
      .select("id, contact_id, is_active, enrichment_profile, life_events, last_enriched_at")
      .eq("brokerage_id", brokerageId).gte("last_enriched_at", since)
      .limit(limit)
    if (lErr) out.errors.push(`leads read refused: ${lErr.message}`)
    for (const l of (lErr ? [] : (leads ?? [])) as Array<Record<string, any>>) {
      out.leadsScanned++
      const party = canonicalIntentParty({ id: String(l.id), contact_id: l.contact_id ?? null, is_active: l.is_active ?? null })
      if (!party) { out.leadsOutOfDomain++; continue }
      if (party.type === "contact") out.leadsAsContact++
      const writtenAt = newestStamp(l.last_enriched_at) ?? now.toISOString()
      const facts = intentSignalsFromContact(l, now).filter((f) => isChangeFact(f) && observedSince(f, writtenAt))
      await routeFacts(svc, { brokerageId, party, facts, record: l, writtenAt, windowDays, now, door: "sweep" }, deps, out)
    }
  } catch (e) {
    out.errors.push(`sweep threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}
