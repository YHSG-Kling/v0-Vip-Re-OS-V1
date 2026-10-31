// lib/enrichment/customer-360.ts
//
// CUSTOMER 360 — contract C6 (wave 146, lane 146D; owner ruling 11, 2026-10-29: "Enrichment should be customer360 which drives
// the outreach"). `customer360For(svc, brokerageId, party)` is a READ over the canonical graph — never a store, never a second
// profile table, never a provider call. Every attribute it returns carries its field-level SOURCE (table · column · provider),
// TIMESTAMP, CONFIDENCE, CONSENT, PURPOSE and OWNERSHIP, and an honest FRESHNESS (real-time first-party write vs a periodic
// provider refresh vs an on-demand gap purchase — a monthly dataset is never called real-time).
//
// IT COMPOSES THE SURVIVORS, IT DOES NOT RE-IMPLEMENT THEM (LAW 1 / LAW 2 — the person-context readers that already exist stay
// the definers of their halves; this is the ONE unified read the arbiter, the managers and the welcome composition consume):
//   identity      lib/kernel/person-identity.ts personForContact / personForLead + summarizePersonEvidence (no cost key, §5)
//   party (C2)    lib/contact-promotion/lead-domain-boundary.ts canonicalPartyFor — a converted lead is read AS its contact
//   provenance    lib/lead-pipeline/enrichment-column-map.ts fieldProvenanceOf (THE one provenance shape, wave 100C)
//   provider facts lib/enrichment/intent-signal-sources.ts intentSignalsFromContact (stored facts only; freshness from
//                 lib/enrichment/provider-dedup.ts PROVIDER_FRESHNESS_DAYS — one table)
//   behaviour     lib/lead-intelligence/behavioral-summary.ts buildBehavioralIntentSummary / buildLeadDecayedIntent (decayed
//                 intent; the OSINT payloads it carries are NOT projected here)
//   household     lib/kernel/relationship-graph.ts household
//   consent       lib/ai-isa/contact-channel-policy.ts voiceReachable / resolveContactChannel; lib/ai-isa/lead-channel-policy.ts
//                 LEAD_ALLOWED_CHANNELS (leads: email / direct mail only)
//   memory        contacts.metadata.context_spine (lib/kernel/conversation-memory.ts — the shared running summary)
//   protected     lib/lead-governance/protected-class-signals.ts protectedClassReasonFor — the ONE classifier
//
// APPEND ≠ INTENT. Every intent observation names its BASIS: `person_stated` / `staff_entered` (a human recorded what the person
// said — CONFIRMED), `first_party_action` (the person did something on our surfaces — observed, NOT confirmed), `provider_append`
// (a vendor's modeled / periodic fact — observed, NOT confirmed), `platform_derived` (our own computation, e.g. the equity scan —
// NOT confirmed). Only a stated basis is ever `confirmed`. The arbiter decides what (if anything) to do; this read decides nothing.
//
// SENSITIVE ATTRIBUTES (ruling 13). The protected-class columns on the record are LABELLED by the one classifier and WITHHELD from
// this outreach-driving view (names + provenance stamps only, never the value) — they are not rewritten, not deleted, not
// "corrected", and their absence never blocks anything. The segregated research store (wave 145F) is never read here. Financial
// columns (credit band, funds, purchase price, commission) are not projected at all (CLAUDE.md §5 — the view carries no financials).
//
// TENANCY. The brokerage is the CALLER's verified tenant (a cron's scanned brokerage, a session's); every read is pinned to it and a
// row outside it is "not in this brokerage". A refused core read refuses the whole view (fail closed); a refused secondary read
// degrades ONLY that slice and is named in `warnings` / `unread` — "nobody checked" never renders as "checked and empty".
//
// NOT server-only (simulator-driven, like the kernel loaders it composes).

import { canonicalPartyFor } from "@/lib/contact-promotion/lead-domain-boundary"
import { personForContact, personForLead, summarizePersonEvidence, type PersonEvidenceSummary } from "@/lib/kernel/person-identity"
import { fieldProvenanceOf } from "@/lib/lead-pipeline/enrichment-column-map"
import { intentSignalsFromContact, type IntentKind } from "@/lib/enrichment/intent-signal-sources"
import { PROVIDER_FRESHNESS_DAYS, isFresh } from "@/lib/enrichment/provider-dedup"
import { protectedClassReasonFor } from "@/lib/lead-governance/protected-class-signals"
import { voiceReachable, resolveContactChannel } from "@/lib/ai-isa/contact-channel-policy"
import { LEAD_ALLOWED_CHANNELS } from "@/lib/ai-isa/lead-channel-policy"
import { isLifetimeRelationshipType } from "@/lib/contact-types"
import {
  CONSENT_CHANNELS, CONSENT_PURPOSES, answerConsentQuestion, consentScopeFor,
  type ConsentAnswerBasis, type ConsentChannel, type ConsentPurpose,
} from "@/lib/kernel/compliance/require-contact-consent"

type Svc = { from: (t: string) => any }
const DAY_MS = 86_400_000

// ── THE SOURCE FACTS — honest freshness and ownership per source (no source is ever called "real-time" unless the row is written
//    at the person's own action) ─────────────────────────────────────────────────────────────────────────────────────────────────

export type C360FreshnessMode =
  /** Written at the person's / staff's own action (a portal visit, a save, a form, a consent event, a staff edit). */
  | "realtime_write"
  /** A provider fact our scheduled / gap-only enrichment stored; the vendor does not push (Versium, PeopleData). */
  | "periodic_provider"
  /** Bought only when a gap exists (an AVM, an online-audience append). */
  | "on_demand"
  /** Our own scheduled computation (the equity scan, the decayed-intent score, the context spine). */
  | "periodic_platform"
  /** No stamp records when the value was written — said, never guessed. */
  | "unknown"

export type C360Ownership =
  /** The tenant's own first-party record (the person's actions on its surfaces, its staff's entries). */
  | "tenant_first_party"
  /** Licensed from a vendor under that vendor's terms (standard terms restrict caching / require deletion on termination —
   *  docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md §4). */
  | "vendor_licensed"
  /** Our own derivation over the tenant's records. */
  | "platform_derived"
  /** Origin unknown (no provenance stamp). */
  | "unknown"

export type C360Basis = "person_stated" | "staff_entered" | "first_party_action" | "provider_append" | "platform_derived" | "unstamped"

export interface C360Freshness {
  mode: C360FreshnessMode
  /** The cadence in words (from the source fact, never invented). */
  cadence: string
  observedAt: string | null
  ageDays: number | null
  /** The window a value still answers the gap (provider windows from PROVIDER_FRESHNESS_DAYS); null = no expiry rule. */
  windowDays: number | null
  /** null = no window applies (a stated value, a first-party row). */
  fresh: boolean | null
}

/** One attribute, with its field-level provenance. */
export interface C360Field {
  value: string | number | boolean | null
  table: string
  column: string
  /** The provenance stamp's source (provider / 'staff' / 'contact' / 'ai_tool'); null when unstamped. */
  source: string | null
  basis: C360Basis
  ownership: C360Ownership
  observedAt: string | null
  /** The stamp's match confidence (0..1 when numeric); null when unstated. */
  confidence: number | null
  purpose: string
  /** The consent basis this attribute is used under (a contact point names its channel's consent), null when none applies. */
  consent: string | null
  freshness: C360Freshness
}

/** The source table · cadence · ownership facts this view reads (the doc's "honest freshness" table is generated from these). */
export const CUSTOMER_360_SOURCES = Object.freeze({
  record: { tables: ["contacts", "leads"], mode: "realtime_write", cadence: "the canonical row; written by its own writers at the moment of the change", ownership: "tenant_first_party" },
  identity: { tables: ["person_identities", "person_identity_evidence"], mode: "realtime_write", cadence: "evidence rows appended at each identity chokepoint (m697)", ownership: "platform_derived" },
  consent: { tables: ["contacts", "leads", "contact_consent_events"], mode: "realtime_write", cadence: "opt-in / opt-out recorded at the moment it is given or withdrawn", ownership: "tenant_first_party" },
  portal: { tables: ["client_portal_activity", "portal_access_logs"], mode: "realtime_write", cadence: "written at each portal visit; the first-party watcher reads it on the 15-minute enrichment-processor tick", ownership: "tenant_first_party" },
  search: { tables: ["saved_properties", "property_views", "website_visitors"], mode: "realtime_write", cadence: "written at each save / view / site session; read by the watcher on the 15-minute tick", ownership: "tenant_first_party" },
  tours: { tables: ["showings", "showing_requests", "tours"], mode: "realtime_write", cadence: "written when a showing / tour is requested or scheduled", ownership: "tenant_first_party" },
  forms: { tables: ["form_submissions"], mode: "realtime_write", cadence: "written at each submission (the promise ledger and welcome are lane 146F / 146C's)", ownership: "tenant_first_party" },
  communications: { tables: ["contacts.metadata.context_spine", "activities", "agent_client_messages"], mode: "realtime_write", cadence: "touches written as they happen; the spine is recomposed by the context-spine-refresh cron", ownership: "tenant_first_party" },
  transactions: { tables: ["transactions"], mode: "realtime_write", cadence: "the deal row; written at each stage change", ownership: "tenant_first_party" },
  household: { tables: ["relationship_edges"], mode: "realtime_write", cadence: "edges derived at the survivor writers (closings, roster, household evidence — m698)", ownership: "platform_derived" },
  behaviour: { tables: ["behavioral_signals", "intelligence_signals_log", "valuation_requests", "isa_outreach_log"], mode: "periodic_platform", cadence: "a decayed score recomputed on read from dated rows (lane 97B)", ownership: "platform_derived" },
  versium: { tables: ["contacts.enrichment_profile.real_estate_indicators", "contacts.enrichment_profile.online_audience"], mode: "periodic_provider", cadence: `stored only when OUR budget-gated gap-only enrichment buys it; Versium does not push; answers the gap for ${PROVIDER_FRESHNESS_DAYS.versium_online_presence} days`, ownership: "vendor_licensed" },
  peopledata: { tables: ["contacts.enrichment_profile (person_profile)"], mode: "periodic_provider", cadence: `PeopleData publishes its dataset in periodic releases and does not push; a stored profile answers the gap for ${PROVIDER_FRESHNESS_DAYS.peopledata_profile} days`, ownership: "vendor_licensed" },
  batchdata: { tables: ["motivated_seller_signals"], mode: "periodic_provider", cadence: "polled property-search quickLists; the Property Subscription PUSH (webhook) only once BatchData provisions it (WAITING_EXTERNAL)", ownership: "vendor_licensed" },
  signals: { tables: ["signal_reactivations"], mode: "realtime_write", cadence: "recorded by the ONE life-change responder when a signal is answered", ownership: "platform_derived" },
} as const)

// ── THE INTENT PLAYBOOKS (ruling 11: "moving, sale, purchase, refinance, equity, household, life events") ───────────────────────
// Each playbook routes through the ONE life-change responder (lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal) under a
// signal_type ALREADY in its vocabulary (LIFE_CHANGE_SIGNAL_KINDS — no new spelling, §6). The responder picks the door by subject
// class: lead → the ISA's lead loops (email / mail only), contact → the governed NBA → arbiter, lifetime → the Sphere.

export type IntentPlaybook = "moving" | "sale" | "purchase" | "refinance" | "equity" | "household" | "life_event"

export const INTENT_PLAYBOOKS: Readonly<Record<IntentPlaybook, { signalType: string; what: string }>> = Object.freeze({
  moving: { signalType: "moving_intent", what: "thinking of moving — a market update for an owner, matching homes for a buyer, a personal call from the agent" },
  sale: { signalType: "home_sale_interest", what: "home-sale interest — a market update / CMA offer, a no-obligation listing conversation" },
  purchase: { signalType: "buying_intent", what: "buying intent — matching properties" },
  refinance: { signalType: "refinance_opportunity", what: "a refinance question — education + an introduction to a licensed lender the client chooses (RESPA §8; never automated)" },
  equity: { signalType: "equity_event", what: "an equity milestone — the in-app equity estimate + the homeowner playbook (lifetime change action)" },
  household: { signalType: "life_event", what: "a household change — a person's conversation (agent intervention only), never an automated message about it, never a segment" },
  life_event: { signalType: "life_event", what: "a life event — a person's conversation (agent intervention only), never a segment" },
})

/** The responder's door per subject class (its own action vocabulary, LifeChangeAction). */
export const PLAYBOOK_ROUTE_BY_CLASS = Object.freeze({
  lead: "lead_signal_recorded",
  contact: "isa_engagement",
  lifetime: "sphere_signal_recorded",
} as const)

/** A provider fact's intents → the playbook it bears on (engagement / relationship moments are not a playbook). */
const PLAYBOOK_BY_INTENT: Readonly<Partial<Record<IntentKind, IntentPlaybook>>> = Object.freeze({
  moving: "moving", home_sale: "sale", home_purchase: "purchase", refinance: "refinance", life_event: "life_event",
})

/** A responder-recorded kind (signal_reactivations.signal_data.kind, LifeChangeKind) → playbook. */
const PLAYBOOK_BY_KIND: Readonly<Record<string, IntentPlaybook>> = Object.freeze({
  moving: "moving", home_sale: "sale", buying: "purchase", refinance: "refinance", equity: "equity", life_event: "life_event",
})

/** Signal types the PERSON explicitly declared (a self-directed tap) — the only reactivation rows that count as stated. */
const STATED_SIGNAL_TYPES: ReadonlySet<string> = new Set(["next_move_intent", "relocation_referral_request"])

// ── the view ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Customer360Slice = "identity" | "lifecycle" | "consent" | "preferences" | "property" | "communications" | "engagement" | "behaviour" | "enrichment" | "intent"
const ALL_SLICES: readonly Customer360Slice[] = Object.freeze(["identity", "lifecycle", "consent", "preferences", "property", "communications", "engagement", "behaviour", "enrichment", "intent"])

export interface C360EngagementFamily {
  /** Rows inside the engagement window. */
  count: number
  lastAt: string | null
  freshness: C360Freshness
  /** True when the read was refused — the family is UNKNOWN, not empty. */
  unread: boolean
}

export interface C360IntentObservation {
  playbook: IntentPlaybook | null
  /** The raw intent / kind as the source names it. */
  signal: string
  basis: C360Basis
  /** Only a stated basis is confirmed (append ≠ intent). */
  confirmed: boolean
  source: string
  observedAt: string | null
  freshness: C360Freshness
}

export interface Customer360 {
  brokerageId: string
  /** What the caller asked for. */
  requested: { type: "contact" | "lead"; id: string }
  /** The canonical party read (contract C2: a converted lead is read as its contact). */
  party: { type: "contact" | "lead"; id: string }
  subjectClass: "lead" | "contact" | "lifetime"
  readAt: string
  slices: Customer360Slice[]
  /** Every projected attribute, keyed `slice.column`. */
  fields: Record<string, C360Field>
  identity: { personId: string | null; evidence: PersonEvidenceSummary | null } | null
  ownership: { agentId: string | null; teamId: string | null }
  consent: {
    allowedChannels: string[]
    /** The channel the existing resolver would pick (contacts: resolveContactChannel; leads: email unless opted out). */
    resolvedChannel: string | null
    voiceReachable: boolean
    optOuts: string[]
    latestEvent: { type: string | null; consented: boolean | null; at: string | null; source: string | null } | null
    /**
     * Wave 147 (lane 147A, contract C8 — "may I text this person about equity?" from the record alone): per channel × purpose,
     * what the CONSENT RECORD says (lib/kernel/compliance/require-contact-consent.ts answerConsentQuestion over consentScopeFor).
     * Contacts only (a lead is email / mail only by policy). ADVISORY: the dispatch gate still decides what may be sent; this is
     * what the arbiter reasons over. `unreadable` when the record could not be read — never "no consent".
     */
    scope?: {
      readable: boolean
      answers: Record<ConsentChannel, Record<ConsentPurpose, { allowed: boolean; basis: ConsentAnswerBasis; consentEventId: string | null }>>
    } | null
  } | null
  engagement: Record<"portal" | "search" | "website" | "tours" | "forms", C360EngagementFamily> | null
  communications: { spineSummary: string | null; lastTouch: string | null; sentiment: string | null; interactionCount: number | null; lastActivityAt: string | null; lastOutboundAt: string | null } | null
  property: { household: Array<{ contactId: string; type: string; confidence: number }>; transactions: Array<{ id: string; role: "buyer" | "seller" | "party"; status: string | null; stage: string | null; closeDate: string | null; address: string | null }> } | null
  behaviour: { score: number; confidence: string; trend: string; evidence: Array<{ type: string; source: string; ageDays: number | null }> } | null
  providerFacts: Array<{ key: string; provider: string; field: string; sensitivity: string; intents: readonly string[]; freshness: C360Freshness }>
  intent: { observations: C360IntentObservation[]; confirmed: IntentPlaybook[]; observedNotConfirmed: IntentPlaybook[]; playbooks: Array<{ playbook: IntentPlaybook; signalType: string; route: string }> } | null
  /** Protected-class columns PRESENT on the record — named with the classifier's reason, the value withheld (ruling 13). */
  protectedWithheld: Array<{ column: string; reason: string; stampSource: string | null; observedAt: string | null }>
  /** Outreach-relevant attributes that are missing (a gap the enrichment rail / a human could fill). */
  gaps: string[]
  /** Attributes whose source window has lapsed. */
  stale: string[]
  /** Slices whose read was refused (degraded, never "empty"). */
  unread: Customer360Slice[]
  warnings: string[]
}

export type Customer360Result = { ok: true; view: Customer360 } | { ok: false; reason: string }

// ── columns (scripts/schema-snapshot.ts — a column the live table lacks would refuse the whole read, PGRST204/42703) ──────────

const CONTACT_CORE = [
  "id", "brokerage_id", "agent_id", "team_id", "first_name", "last_name", "preferred_name", "email", "phone", "phone_secondary",
  "address", "city", "state", "zip_code", "mailing_address", "mailing_city", "mailing_state", "mailing_zip",
  "contact_type", "lifecycle_state", "buyer_stage", "contact_persona", "nurture_status", "status", "created_at", "updated_at", "source", "source_channel",
  "preferred_channel", "preferred_contact_time", "preferred_language", "time_zone", "accessibility_preferences", "salutation_style",
  "home_owner_status", "length_of_residence", "home_value_estimate", "equity_estimate", "property_type", "beds", "baths", "sqft",
  "budget_min", "budget_max", "timeline", "motivation_type", "motivation_confidence", "home_anniversary",
  "enrichment_profile", "last_enriched_at", "enriched_at", "enrichment_source", "life_events", "last_life_event_detected", "metadata",
  "email_opt_out", "email_unsubscribed", "sms_opt_out", "sms_unsubscribed", "phone_opt_out", "call_stop_flag", "direct_mail_opt_out",
  "dnc_status", "tcpa_consent", "tcpa_consent_at", "tcpa_consent_source", "opt_out_channels", "opted_out_at", "ai_outreach_paused",
  "deleted_at",
] as const
const LEAD_CORE = [
  "id", "brokerage_id", "agent_id", "contact_id", "converted_at", "is_active", "first_name", "last_name", "email", "phone", "phone_secondary",
  "address", "city", "state", "zip_code", "mailing_address", "mailing_city", "mailing_state", "mailing_zip",
  "lead_stage", "lead_type", "status", "lifecycle_state", "persona", "created_at", "source", "source_channel", "preferred_channel",
  "home_owner_status", "property_type", "beds", "baths", "sqft", "budget_min", "budget_max", "timeline", "motivation_type", "motivation_confidence",
  "enrichment_profile", "last_enriched_at", "life_events",
  "email_opt_out", "sms_opt_out", "phone_opt_out", "direct_mail_opt_out", "dnc_status", "tcpa_consent", "tcpa_consent_at", "tcpa_consent_source",
  "opt_out_channels", "opted_out_at", "ai_outreach_paused", "long_term_nurture_until",
] as const
/** The demographic columns that MAY sit on a contact. Each is classified by the ONE classifier at read time (never a hard-coded
 *  verdict here): a protected one is named and withheld; an unprotected one would be projected (none of these is today). */
const CONTACT_DEMOGRAPHIC_CANDIDATES = ["age_range", "birthday", "gender", "marital_status", "education_level", "occupation", "household_income", "net_worth_range"] as const

/** slice → the columns it projects (a protected column is never projected whichever slice names it). */
const PROJECTION: Readonly<Record<"identity" | "lifecycle" | "preferences" | "property", readonly string[]>> = Object.freeze({
  identity: ["first_name", "last_name", "preferred_name", "email", "phone", "phone_secondary", "address", "city", "state", "zip_code", "mailing_address", "mailing_city", "mailing_state", "mailing_zip"],
  lifecycle: ["contact_type", "lifecycle_state", "buyer_stage", "contact_persona", "nurture_status", "lead_stage", "lead_type", "persona", "status", "created_at", "source", "source_channel", "converted_at", "long_term_nurture_until"],
  preferences: ["preferred_channel", "preferred_contact_time", "preferred_language", "time_zone", "salutation_style"],
  property: ["home_owner_status", "length_of_residence", "home_value_estimate", "equity_estimate", "property_type", "beds", "baths", "sqft", "budget_min", "budget_max", "timeline", "motivation_type", "home_anniversary"],
})

const CONTACT_POINT_CONSENT: Readonly<Record<string, string>> = Object.freeze({
  email: "email (CAN-SPAM opt-out state)", phone: "voice / SMS (TCPA consent + DNC)", phone_secondary: "voice / SMS (TCPA consent + DNC)",
  address: "direct mail (opt-out state)", mailing_address: "direct mail (opt-out state)",
})

const HUMAN_SOURCES: Readonly<Record<string, C360Basis>> = Object.freeze({ staff: "staff_entered", contact: "person_stated", ai_tool: "person_stated" })

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ageDaysOf = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null
}

function freshnessOf(mode: C360FreshnessMode, cadence: string, observedAt: string | null, windowDays: number | null, now: Date): C360Freshness {
  return { mode, cadence, observedAt, ageDays: ageDaysOf(observedAt, now), windowDays, fresh: windowDays === null ? null : isFresh(observedAt, windowDays, now) }
}

/** A provider stamp's window (PROVIDER_FRESHNESS_DAYS — one table); null for a human / unknown source. */
function providerWindow(source: string | null): number | null {
  const s = (source ?? "").toLowerCase()
  if (s.startsWith("peopledata") || s === "pdl") return PROVIDER_FRESHNESS_DAYS.peopledata_profile
  if (s.startsWith("versium")) return PROVIDER_FRESHNESS_DAYS.versium_online_presence
  return null
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  return Number.isFinite(n) ? (n > 1 && n <= 100 ? n / 100 : n) : null
}

const scalar = (v: unknown): string | number | boolean | null =>
  v === null || v === undefined ? null : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v)

/** One column of the canonical row → a field with its provenance (the stamp when one exists; "unstamped" said, never guessed). */
function projectField(table: string, column: string, value: unknown, stamps: Record<string, unknown>, purpose: string, now: Date): C360Field {
  const st = stamps[column] && typeof stamps[column] === "object" ? (stamps[column] as Record<string, unknown>) : null
  const source = st && typeof st.source === "string" ? st.source : null
  const observedAt = st && typeof st.retrievedAt === "string" ? st.retrievedAt : null
  const human = source ? HUMAN_SOURCES[source] : undefined
  const basis: C360Basis = !st ? "unstamped" : human ?? "provider_append"
  const ownership: C360Ownership = !st ? "unknown" : human ? "tenant_first_party" : "vendor_licensed"
  const window = human ? null : providerWindow(source)
  const mode: C360FreshnessMode = !st ? "unknown" : human ? "realtime_write" : "periodic_provider"
  const cadence = !st ? "no provenance stamp — when and by whom this was written is not recorded"
    : human ? `stated by ${source === "staff" ? "staff" : "the person"} at ${observedAt ?? "an unrecorded time"}`
    : `${source} via ${typeof st.capability === "string" ? st.capability : "an enrichment capability"} (periodic; the vendor does not push)`
  return {
    value: scalar(value), table, column, source, basis, ownership, observedAt,
    confidence: st ? asNumber(st.matchConfidence) : null,
    purpose: st && typeof st.purpose === "string" ? `${purpose} · stamped purpose ${st.purpose}` : purpose,
    consent: CONTACT_POINT_CONSENT[column] ?? null,
    freshness: freshnessOf(mode, cadence, observedAt, window, now),
  }
}

const SLICE_PURPOSE: Readonly<Record<keyof typeof PROJECTION, string>> = Object.freeze({
  identity: "relationship_service · contact points for permitted channels",
  lifecycle: "journey routing (who owns the next action)",
  preferences: "how the person asked to be reached / addressed (accessibility first)",
  property: "the person's stated property situation and search criteria",
})

// ── the read ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * C6 — THE CUSTOMER 360 READ. Tenant-pinned, never throws, never calls a provider, never writes. `slices` narrows the reads (the
 * first-party watcher asks for consent + intent only); the default reads every slice.
 */
export async function customer360For(
  svc: Svc,
  brokerageId: string,
  party: { type: "contact" | "lead"; id: string },
  opts: { now?: Date; slices?: readonly Customer360Slice[]; engagementWindowDays?: number } = {},
): Promise<Customer360Result> {
  try {
    if (!brokerageId || !party?.id || (party.type !== "contact" && party.type !== "lead")) return { ok: false, reason: "missing brokerage or party" }
    const now = opts.now ?? new Date()
    const want = new Set<Customer360Slice>(opts.slices && opts.slices.length > 0 ? opts.slices : ALL_SLICES)
    const windowDays = Math.max(1, opts.engagementWindowDays ?? 90)
    const windowStart = new Date(now.getTime() - windowDays * DAY_MS).toISOString()
    const warnings: string[] = []
    const unread = new Set<Customer360Slice>()

    // ── the canonical party (C2) ──
    let partyRead: { type: "contact" | "lead"; id: string } = { type: party.type, id: party.id }
    let leadRow: Record<string, any> | null = null
    if (party.type === "lead") {
      const { data, error } = await svc.from("leads").select(LEAD_CORE.join(", ")).eq("id", party.id).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return { ok: false, reason: `lead read refused: ${error.message}` }
      if (!data) return { ok: false, reason: "lead not in this brokerage" }
      leadRow = data as Record<string, any>
      const canon = canonicalPartyFor({ id: leadRow.id, contact_id: leadRow.contact_id ?? null })
      if (canon.type === "unresolved") return { ok: false, reason: canon.reason }
      if (canon.type === "contact") partyRead = { type: "contact", id: canon.id }
    }
    let row: Record<string, any>
    let table: "contacts" | "leads"
    if (partyRead.type === "contact") {
      const cols = [...CONTACT_CORE, ...CONTACT_DEMOGRAPHIC_CANDIDATES].join(", ")
      const { data, error } = await svc.from("contacts").select(cols).eq("id", partyRead.id).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return { ok: false, reason: `contact read refused: ${error.message}` }
      if (!data) return { ok: false, reason: "contact not in this brokerage" }
      if ((data as Record<string, unknown>).deleted_at) return { ok: false, reason: "contact is deleted" }
      row = data as Record<string, any>
      table = "contacts"
    } else {
      row = leadRow as Record<string, any>
      table = "leads"
    }
    const subjectClass: Customer360["subjectClass"] = partyRead.type === "lead" ? "lead" : isLifetimeRelationshipType(row.contact_type ?? null) ? "lifetime" : "contact"
    const profile = row.enrichment_profile && typeof row.enrichment_profile === "object" ? (row.enrichment_profile as Record<string, unknown>) : null
    const stamps = fieldProvenanceOf(profile)

    // ── projected fields + the protected-class labels (classified, never hard-coded) ──
    const fields: Record<string, C360Field> = {}
    for (const slice of ["identity", "lifecycle", "preferences", "property"] as const) {
      if (!want.has(slice)) continue
      for (const col of PROJECTION[slice]) {
        if (!(col in row) || protectedClassReasonFor(col)) continue
        fields[`${slice}.${col}`] = projectField(table, col, row[col], stamps, SLICE_PURPOSE[slice], now)
      }
    }
    if (want.has("preferences") && table === "contacts" && row.accessibility_preferences != null) {
      fields["preferences.accessibility_preferences"] = projectField(table, "accessibility_preferences", row.accessibility_preferences, stamps, "accessibility (captions / transcript / no forced autoplay)", now)
    }
    const protectedWithheld: Customer360["protectedWithheld"] = []
    for (const col of table === "contacts" ? CONTACT_DEMOGRAPHIC_CANDIDATES : []) {
      const v = row[col]
      if (v === null || v === undefined || v === "") continue
      const reason = protectedClassReasonFor(col)
      if (!reason) { fields[`identity.${col}`] = projectField(table, col, v, stamps, "relationship_service", now); continue }
      const st = stamps[col] && typeof stamps[col] === "object" ? (stamps[col] as Record<string, unknown>) : null
      protectedWithheld.push({ column: col, reason, stampSource: st && typeof st.source === "string" ? st.source : null, observedAt: st && typeof st.retrievedAt === "string" ? st.retrievedAt : null })
    }

    // ── identity ──
    let identity: Customer360["identity"] = null
    if (want.has("identity")) {
      const r = partyRead.type === "contact"
        ? await personForContact(svc, { brokerageId, contactId: partyRead.id })
        : await personForLead(svc, { brokerageId, leadId: partyRead.id })
      if (!r.ok) { unread.add("identity"); warnings.push(`identity evidence unread: ${r.reason}`); identity = { personId: null, evidence: null } }
      else identity = { personId: r.view?.person.id ?? null, evidence: r.view ? summarizePersonEvidence(r.view) : null }
    }

    // ── consent (from the canonical row the core read already holds — a refused core read refused the whole view) ──
    let consent: Customer360["consent"] = null
    if (want.has("consent")) {
      const optOuts = (["email_opt_out", "email_unsubscribed", "sms_opt_out", "sms_unsubscribed", "phone_opt_out", "call_stop_flag", "direct_mail_opt_out"] as const).filter((c) => row[c] === true)
      const emailOk = !!row.email && row.email_opt_out !== true && row.email_unsubscribed !== true
      const mailOk = !!(row.mailing_address ?? row.address) && row.direct_mail_opt_out !== true
      let allowed: string[]
      let resolved: string | null
      let voice = false
      if (table === "contacts") {
        voice = voiceReachable(row as never)
        const smsOk = !!row.phone && row.tcpa_consent === true && row.sms_opt_out !== true && row.sms_unsubscribed !== true
        allowed = [emailOk ? "email" : null, smsOk ? "sms" : null, voice ? "phone" : null, voice ? "voice_drop" : null, mailOk ? "direct_mail" : null, "in_app"].filter((c): c is string => !!c)
        resolved = resolveContactChannel(row as never)
      } else {
        // A lead is reached by email / direct mail only (lead-channel-policy.ts) — whatever its stored preference says.
        allowed = (LEAD_ALLOWED_CHANNELS as readonly string[]).filter((c) => (c === "email" ? emailOk : mailOk))
        resolved = allowed[0] ?? null
      }
      if (row.ai_outreach_paused === true) warnings.push("AI outreach is paused on this record (ai_outreach_paused) — a human owns the next touch")
      let latestEvent: NonNullable<Customer360["consent"]>["latestEvent"] = null
      const evQ = svc.from("contact_consent_events").select("consent_type, consented, created_at, consent_source").eq("brokerage_id", brokerageId)
      const { data: ev, error: evErr } = await (partyRead.type === "contact" ? evQ.eq("contact_id", partyRead.id) : evQ.eq("lead_id", partyRead.id)).order("created_at", { ascending: false }).limit(1)
      if (evErr) { unread.add("consent"); warnings.push(`consent events unread: ${evErr.message} (the row's own opt-out flags still apply)`) }
      else {
        const e = ((ev ?? []) as Array<Record<string, any>>)[0]
        if (e) latestEvent = { type: e.consent_type ?? null, consented: typeof e.consented === "boolean" ? e.consented : null, at: e.created_at ?? null, source: e.consent_source ?? null }
      }
      // Wave 147 (147A): the consent SCOPE — what each recorded consent grants, per channel and purpose (contacts only).
      let scope: NonNullable<Customer360["consent"]>["scope"] = null
      if (partyRead.type === "contact") {
        const read = await consentScopeFor(svc, { brokerageId, contactId: partyRead.id })
        if (read.error) { unread.add("consent"); warnings.push(`consent scope unread: ${read.error}`) }
        const answers = {} as Record<ConsentChannel, Record<ConsentPurpose, { allowed: boolean; basis: ConsentAnswerBasis; consentEventId: string | null }>>
        for (const ch of CONSENT_CHANNELS) {
          answers[ch] = {} as Record<ConsentPurpose, { allowed: boolean; basis: ConsentAnswerBasis; consentEventId: string | null }>
          for (const pu of CONSENT_PURPOSES) {
            const a = answerConsentQuestion(read, { channel: ch, purpose: pu })
            answers[ch][pu] = { allowed: a.allowed, basis: a.basis, consentEventId: a.consentEventId }
          }
        }
        scope = { readable: !read.error && read.scopeReadable, answers }
      }
      consent = { allowedChannels: allowed, resolvedChannel: resolved, voiceReachable: voice, optOuts, latestEvent, scope }
    }

    // ── engagement (first-party actions — real-time writes) ──
    let engagement: Customer360["engagement"] = null
    if (want.has("engagement") || want.has("intent")) {
      const fam = (key: keyof typeof CUSTOMER_360_SOURCES, count: number, lastAt: string | null, isUnread: boolean): C360EngagementFamily =>
        ({ count, lastAt, unread: isUnread, freshness: freshnessOf("realtime_write", CUSTOMER_360_SOURCES[key].cadence, lastAt, null, now) })
      const newest = (rows: Array<Record<string, any>>, col: string) => rows.map((r) => r[col]).filter((v): v is string => typeof v === "string").sort().pop() ?? null
      const read = async (t: string, cols: string, keyCol: string, tsCol: string) => {
        const { data, error } = await svc.from(t).select(cols).eq("brokerage_id", brokerageId).eq(keyCol, partyRead.id).gte(tsCol, windowStart).limit(500)
        if (error) warnings.push(`${t} unread: ${error.message}`)
        return { rows: (error ? [] : (data ?? [])) as Array<Record<string, any>>, unread: !!error }
      }
      const isContact = partyRead.type === "contact"
      const key = isContact ? "contact_id" : "lead_id"
      const none = { rows: [] as Array<Record<string, any>>, unread: false }
      const [cpa, pal, sav, pv, wv, sh, sr, fs] = await Promise.all([
        isContact ? read("client_portal_activity", "created_at", "contact_id", "created_at") : Promise.resolve(none),
        isContact ? read("portal_access_logs", "accessed_at", "contact_id", "accessed_at") : Promise.resolve(none),
        isContact ? read("saved_properties", "saved_at, dismissed", "contact_id", "saved_at") : Promise.resolve(none),
        isContact ? read("property_views", "last_viewed_at, view_count", "contact_id", "last_viewed_at") : Promise.resolve(none),
        read("website_visitors", "last_seen_at", key, "last_seen_at"),
        isContact ? read("showings", "scheduled_at, status", "contact_id", "scheduled_at") : Promise.resolve(none),
        isContact ? read("showing_requests", "created_at, status", "contact_id", "created_at") : Promise.resolve(none),
        isContact ? read("form_submissions", "created_at, form_name", "contact_id", "created_at") : Promise.resolve(none),
      ])
      const saves = sav.rows.filter((r) => r.dismissed !== true)
      const portalLast = [newest(cpa.rows, "created_at"), newest(pal.rows, "accessed_at")].filter((v): v is string => !!v).sort().pop() ?? null
      const searchLast = [newest(saves, "saved_at"), newest(pv.rows, "last_viewed_at")].filter((v): v is string => !!v).sort().pop() ?? null
      const toursLast = [newest(sh.rows, "scheduled_at"), newest(sr.rows, "created_at")].filter((v): v is string => !!v).sort().pop() ?? null
      engagement = {
        portal: fam("portal", cpa.rows.length + pal.rows.length, portalLast, cpa.unread || pal.unread),
        search: fam("search", saves.length + pv.rows.length, searchLast, sav.unread || pv.unread),
        website: fam("search", wv.rows.length, newest(wv.rows, "last_seen_at"), wv.unread),
        tours: fam("tours", sh.rows.length + sr.rows.length, toursLast, sh.unread || sr.unread),
        forms: fam("forms", fs.rows.length, newest(fs.rows, "created_at"), fs.unread),
      }
      if (Object.values(engagement).some((f) => f.unread)) unread.add("engagement")
    }

    // ── communications (the shared spine + the newest touch / send) ──
    let communications: Customer360["communications"] = null
    if (want.has("communications")) {
      const md = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, any>) : {}
      const spine = md.context_spine && typeof md.context_spine === "object" ? (md.context_spine as Record<string, any>) : null
      let lastActivityAt: string | null = null
      let lastOutboundAt: string | null = null
      if (partyRead.type === "contact") {
        const { data: act, error: actErr } = await svc.from("activities").select("created_at").eq("brokerage_id", brokerageId).eq("contact_id", partyRead.id).order("created_at", { ascending: false }).limit(1)
        if (actErr) { unread.add("communications"); warnings.push(`activities unread: ${actErr.message}`) }
        else lastActivityAt = ((act ?? []) as Array<{ created_at?: string }>)[0]?.created_at ?? null
      }
      const msgQ = svc.from("agent_client_messages").select("sent_at").eq("brokerage_id", brokerageId)
      const { data: msg, error: msgErr } = await (partyRead.type === "contact" ? msgQ.eq("recipient_contact_id", partyRead.id) : msgQ.eq("recipient_lead_id", partyRead.id)).not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(1)
      if (msgErr) { unread.add("communications"); warnings.push(`agent_client_messages unread: ${msgErr.message}`) }
      else lastOutboundAt = ((msg ?? []) as Array<{ sent_at?: string }>)[0]?.sent_at ?? null
      communications = {
        spineSummary: typeof spine?.summary === "string" ? spine.summary : null,
        lastTouch: typeof spine?.lastTouch === "string" ? spine.lastTouch : null,
        sentiment: typeof spine?.sentiment === "string" ? spine.sentiment : null,
        interactionCount: typeof spine?.interactionCount === "number" ? spine.interactionCount : null,
        lastActivityAt, lastOutboundAt,
      }
    }

    // ── property: household + the deals the person was a party to (no financial column is read) ──
    let property: Customer360["property"] = null
    if (want.has("property") && partyRead.type === "contact") {
      const { household } = await import("@/lib/kernel/relationship-graph")
      const hh = await household(svc as never, { brokerageId, contactId: partyRead.id })
      if (!hh.ok) { unread.add("property"); warnings.push(`household unread: ${hh.error}`) }
      const { data: tx, error: txErr } = await svc.from("transactions").select("id, status, stage, close_date, property_address, buyer_contact_id, seller_contact_id, contact_id, deleted_at")
        .eq("brokerage_id", brokerageId).or(`buyer_contact_id.eq.${partyRead.id},seller_contact_id.eq.${partyRead.id},contact_id.eq.${partyRead.id}`).limit(50)
      if (txErr) { unread.add("property"); warnings.push(`transactions unread: ${txErr.message}`) }
      property = {
        household: hh.ok ? hh.members.map((m) => ({ contactId: m.contactId, type: m.type, confidence: m.confidence })) : [],
        transactions: ((txErr ? [] : (tx ?? [])) as Array<Record<string, any>>).filter((t) => !t.deleted_at).map((t) => ({
          id: String(t.id), role: t.buyer_contact_id === partyRead.id ? "buyer" as const : t.seller_contact_id === partyRead.id ? "seller" as const : "party" as const,
          status: t.status ?? null, stage: t.stage ?? null, closeDate: t.close_date ?? null, address: t.property_address ?? null,
        })),
      }
    }

    // ── behaviour (the decayed-intent survivor; the OSINT payloads it carries are NOT projected) ──
    let behaviour: Customer360["behaviour"] = null
    if (want.has("behaviour")) {
      const bs = await import("@/lib/lead-intelligence/behavioral-summary")
      const decayed = partyRead.type === "contact"
        ? (await bs.buildBehavioralIntentSummary(partyRead.id, brokerageId, svc as never, { now })).decayedIntent
        : await bs.buildLeadDecayedIntent(svc as never, brokerageId, { id: partyRead.id, timeline: row.timeline ?? null }, now)
      if (decayed) behaviour = { score: decayed.score, confidence: decayed.confidence, trend: decayed.trend, evidence: decayed.evidence.map((e) => ({ type: e.type, source: e.source, ageDays: e.ageDays })) }
    }

    // ── provider facts (stored only — no call, no spend) ──
    const providerFacts: Customer360["providerFacts"] = []
    const gaps: string[] = []
    const stale: string[] = []
    if (want.has("enrichment") || want.has("intent")) {
      for (const f of intentSignalsFromContact(row, now)) {
        if (f.sensitivity === "age") continue // the birthday month is a relationship-moment input, not an outreach driver — withheld with the protected columns
        const window = f.provider === "versium" ? PROVIDER_FRESHNESS_DAYS.versium_online_presence : f.provider === "peopledata" ? PROVIDER_FRESHNESS_DAYS.peopledata_profile : null
        const mode: C360FreshnessMode = f.provider === "first_party" ? "realtime_write" : "periodic_provider"
        const cadence = f.provider === "versium" ? CUSTOMER_360_SOURCES.versium.cadence : f.provider === "peopledata" ? CUSTOMER_360_SOURCES.peopledata.cadence : f.provider === "first_party" ? CUSTOMER_360_SOURCES.record.cadence : `${f.provider} — stored by its own writer; no push`
        const fr = freshnessOf(mode, cadence, f.observedAt, window, now)
        if (fr.fresh === false) stale.push(`providerFacts.${f.key}`)
        providerFacts.push({ key: f.key, provider: f.provider, field: f.field, sensitivity: f.sensitivity, intents: f.intents, freshness: fr })
      }
      const enrichedAt = (row.last_enriched_at ?? row.enriched_at ?? null) as string | null
      if (!enrichedAt) gaps.push("enrichment: never enriched (the gap-only rail decides whether anything is worth buying)")
      else if (!isFresh(enrichedAt, PROVIDER_FRESHNESS_DAYS.peopledata_profile, now)) stale.push("record.last_enriched_at")
    }
    if (!row.email) gaps.push("identity.email")
    if (!row.phone) gaps.push("identity.phone")
    if (!(row.mailing_address ?? row.address)) gaps.push("identity.mailing_address")
    if (table === "contacts" && !row.preferred_channel) gaps.push("preferences.preferred_channel")
    if (!row.timeline) gaps.push("property.timeline")

    // ── intent context (append ≠ intent) ──
    let intent: Customer360["intent"] = null
    if (want.has("intent")) {
      const observations: C360IntentObservation[] = []
      // (1) stated: the canonical timeline / motivation, confirmed only when a human stamp says who recorded it.
      if (row.timeline) {
        const st = stamps.timeline && typeof stamps.timeline === "object" ? (stamps.timeline as Record<string, unknown>) : null
        const basis: C360Basis = st && typeof st.source === "string" ? HUMAN_SOURCES[st.source] ?? "provider_append" : "unstamped"
        const type = String(row.contact_type ?? row.lead_type ?? row.persona ?? "").toLowerCase()
        const playbooks: IntentPlaybook[] = /both/.test(type) ? ["purchase", "sale"] : /buyer|renter/.test(type) ? ["purchase"] : /seller|owner/.test(type) ? ["sale"] : []
        const at = st && typeof st.retrievedAt === "string" ? st.retrievedAt : null
        for (const p of playbooks.length > 0 ? playbooks : [null]) {
          observations.push({ playbook: p, signal: `stated timeline ${row.timeline}`, basis, confirmed: basis === "person_stated" || basis === "staff_entered", source: `${table}.timeline`, observedAt: at, freshness: freshnessOf(basis === "unstamped" ? "unknown" : "realtime_write", CUSTOMER_360_SOURCES.record.cadence, at, null, now) })
        }
      }
      // (2) first-party actions (observed, never confirmed).
      if (engagement) {
        if (engagement.search.count > 0 || engagement.website.count > 0) observations.push({ playbook: "purchase", signal: "search_portal_activity", basis: "first_party_action", confirmed: false, source: "saved_properties / property_views / website_visitors", observedAt: engagement.search.lastAt ?? engagement.website.lastAt, freshness: engagement.search.lastAt ? engagement.search.freshness : engagement.website.freshness })
        if (engagement.tours.count > 0) observations.push({ playbook: "purchase", signal: "tour_activity", basis: "first_party_action", confirmed: false, source: "showings / showing_requests", observedAt: engagement.tours.lastAt, freshness: engagement.tours.freshness })
        if (engagement.portal.count > 0) observations.push({ playbook: null, signal: "portal_activity", basis: "first_party_action", confirmed: false, source: "client_portal_activity / portal_access_logs", observedAt: engagement.portal.lastAt, freshness: engagement.portal.freshness })
      }
      // (3) provider appends (observed, never confirmed). A protected-class life event (familial / marital) is the household playbook.
      for (const f of providerFacts) {
        if (f.sensitivity !== "behaviour" && f.sensitivity !== "life_event" && f.sensitivity !== "property_fact") continue
        const first = f.intents.find((i) => PLAYBOOK_BY_INTENT[i as IntentKind]) as IntentKind | undefined
        let playbook: IntentPlaybook | null = first ? PLAYBOOK_BY_INTENT[first] ?? null : null
        if (playbook === "life_event" && f.key === "public_life_event") {
          const types = Array.isArray(row.life_events) ? (row.life_events as unknown[]).map((e) => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).type ?? "") : "")) : []
          if (types.some((t) => t && protectedClassReasonFor(t))) playbook = "household"
        }
        observations.push({ playbook, signal: f.key, basis: f.provider === "first_party" ? "first_party_action" : "provider_append", confirmed: false, source: `${f.provider} · ${f.field}`, observedAt: f.freshness.observedAt, freshness: f.freshness })
      }
      // (4) signals the responder already recorded (basis by their source — a self-directed tap is the only stated one).
      const sigQ = svc.from("signal_reactivations").select("signal_type, signal_data, triggered_at").eq("brokerage_id", brokerageId)
      const { data: sigs, error: sigErr } = await (partyRead.type === "contact" ? sigQ.eq("contact_id", partyRead.id) : sigQ.eq("lead_id", partyRead.id)).gte("triggered_at", windowStart).order("triggered_at", { ascending: false }).limit(50)
      if (sigErr) { unread.add("intent"); warnings.push(`signal_reactivations unread: ${sigErr.message}`) }
      for (const s of (sigErr ? [] : (sigs ?? [])) as Array<Record<string, any>>) {
        const type = String(s.signal_type ?? "")
        const sd = s.signal_data && typeof s.signal_data === "object" ? (s.signal_data as Record<string, unknown>) : {}
        const src = typeof sd.source === "string" ? sd.source : ""
        const basis: C360Basis = STATED_SIGNAL_TYPES.has(type) ? "person_stated" : src.startsWith("enrichment:") ? "provider_append" : src.startsWith("first_party:") ? "first_party_action" : "platform_derived"
        const kind = typeof sd.kind === "string" ? sd.kind : ""
        observations.push({ playbook: PLAYBOOK_BY_KIND[kind] ?? null, signal: type, basis, confirmed: basis === "person_stated", source: `signal_reactivations (${src || "unsourced"})`, observedAt: s.triggered_at ?? null, freshness: freshnessOf("realtime_write", CUSTOMER_360_SOURCES.signals.cadence, s.triggered_at ?? null, null, now) })
      }
      const confirmed = [...new Set(observations.filter((o) => o.confirmed && o.playbook).map((o) => o.playbook as IntentPlaybook))]
      const observedNotConfirmed = [...new Set(observations.filter((o) => !o.confirmed && o.playbook && !confirmed.includes(o.playbook)).map((o) => o.playbook as IntentPlaybook))]
      const route = PLAYBOOK_ROUTE_BY_CLASS[subjectClass]
      const playbooks = [...confirmed, ...observedNotConfirmed].map((p) => ({ playbook: p, signalType: INTENT_PLAYBOOKS[p].signalType, route }))
      intent = { observations, confirmed, observedNotConfirmed, playbooks }
    }

    return {
      ok: true,
      view: {
        brokerageId, requested: { type: party.type, id: party.id }, party: partyRead, subjectClass, readAt: now.toISOString(),
        slices: ALL_SLICES.filter((s) => want.has(s)), fields, identity,
        ownership: { agentId: row.agent_id ?? null, teamId: row.team_id ?? null },
        consent, engagement: want.has("engagement") ? engagement : null, communications, property, behaviour,
        providerFacts: want.has("enrichment") ? providerFacts : [],
        intent, protectedWithheld, gaps, stale, unread: [...unread], warnings,
      },
    }
  } catch (e) {
    return { ok: false, reason: `customer 360 read threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}
