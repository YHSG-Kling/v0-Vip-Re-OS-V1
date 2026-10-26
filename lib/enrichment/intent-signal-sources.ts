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
// yields no signal; a value is never inferred from another.
//
// WHAT IT NEVER RETURNS: a protected characteristic (race, religion, national origin, familial status, sex, disability) — the
// full-demographic adapter drops them before they are stored (versium-client.ts VERSIUM_PROTECTED_CLASS_FIELD) and nothing here
// reads a field that names one. Age appears ONLY as the birthday-MONTH signal (cards; the education format by band — owner:
// "never age stereotyping"), flagged `sensitivity: "age"` so a consumer can keep it off any targeting surface (the ad arm of
// lib/lead-governance/protected-class-signals.ts refuses it there regardless). Life events (probate, divorce, relocation) are
// SERVICE TOPICS (owner ruling 17), never a targeting segment — flagged `sensitivity: "life_event"`.
//
// Respect source terms, privacy, consent, communication rules: a signal TRIGGERS an evaluation; it does not authorise a send.
// Consent, DNC/TCPA, frequency and the channel are the consumer's gates (lane F: followup-arbiter / contact-channel-policy).

import { realEstateIndicatorsFromProfile } from "@/lib/enrichment/online-presence-store"
import { onlineAudienceSummary } from "@/lib/enrichment/online-audience-store"

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

/** PURE. The behaviour / life-event facts the AFTER row carries that the BEFORE row did not (same key + value + observation). */
export function newIntentFacts(
  before: Parameters<typeof intentSignalsFromContact>[0] | null | undefined,
  after: Parameters<typeof intentSignalsFromContact>[0],
  now: Date = new Date(),
): ObservedIntentSignal[] {
  const id = (o: ObservedIntentSignal) => `${o.key}|${String(o.value)}|${o.observedAt ?? ""}`
  const seen = new Set((before ? intentSignalsFromContact(before, now) : []).map(id))
  return intentSignalsFromContact(after, now).filter((o) => (o.sensitivity === "behaviour" || o.sensitivity === "life_event") && !seen.has(id(o)))
}

/**
 * Publish each NEW behaviour / life-event fact a write landed on a contact (newIntentFacts) as ONE `online_intent_detected` bus
 * signal per fact (the bus dedupes per open contact — the evaluation reads every stored fact, so one open line suffices). The
 * brokerage and contact are the WRITER's verified target, never a payload. Never throws: a refused publish is counted and logged —
 * the write it follows already succeeded and is not undone.
 */
export async function publishNewIntentFacts(
  svc: unknown,
  target: { brokerageId: string; contactId: string },
  before: Parameters<typeof intentSignalsFromContact>[0] | null | undefined,
  after: Parameters<typeof intentSignalsFromContact>[0],
  now: Date = new Date(),
): Promise<{ published: number; refused: number }> {
  const fresh = newIntentFacts(before, after, now)
  if (fresh.length === 0 || !target.brokerageId || !target.contactId) return { published: 0, refused: 0 }
  let published = 0, refused = 0
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    for (const f of fresh) {
      const r = await publishManagerSignal({
        brokerageId: target.brokerageId, fromManager: "data_steward", toManager: "ai_isa",
        signalType: "online_intent_detected",
        message: `A provider we already use recorded a new ${f.sensitivity === "life_event" ? "life-event" : "online-intent"} fact (${f.provider} · ${f.field}).`,
        entityType: "contact", entityId: target.contactId, contactId: target.contactId,
        payload: { key: f.key, provider: f.provider, field: f.field, intents: [...f.intents], sensitivity: f.sensitivity, observed_at: f.observedAt },
      }, svc as never)
      if (r.ok) published++
      else { refused++; console.warn(`[intent-signal-sources] online_intent_detected not published for ${target.contactId}: ${r.reason ?? "refused"}`) }
    }
  } catch (e) {
    refused += fresh.length - published
    console.warn("[intent-signal-sources] publish threw (non-blocking):", e instanceof Error ? e.message : e)
  }
  return { published, refused }
}
