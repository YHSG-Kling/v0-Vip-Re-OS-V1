// Standard CRM field values - THE source of truth for all CRM data
// These values are used across the entire application for workflows, automations, and data normalization

export const STANDARD_CRM_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "appointment_booked",
  "signed_agreement",
  "pre_listing",
  "active_listing",
  "contingent",
  "pending",
  "sold",
  "lifetime_customer",
] as const

export type StandardCRMStatus = (typeof STANDARD_CRM_STATUSES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PERSONA VOCABULARY — REKEYED ONTO THE LIVE CHECK (2026-08-31, §3/§6),
// then WIDENED BY OWNER RULING the same day: `investor` is the fourteenth member.
//
// This list used to be a 16-member roster (first_time_buyer, luxury_buyer,
// luxury_seller, motivated_seller, empty_nester, remote_seller, upsizers,
// relocating, investor, …) that the LIVE DATABASE REFUSED: the
// contacts_contact_persona_check (scripts/check-vocabularies.ts:537, regenerated
// 2026-08-31 after m589) then admitted thirteen values, and NOT ONE of the nine
// spellings named above. Two tombstones (types.ts:42,
// services/aiMappingService.ts) pointed here as THE canonical persona labels
// while the map could not label a single storable row — and
// services/aiMappingService.ts mapPersona was actively normalizing imported
// personas ONTO the refused 16-member set, so any contact import carrying a
// persona was handed a value Postgres rejects (23514), killing the whole row
// (§3: a CHECK refusal is refused ENTIRELY).
//
// The rekey is a MERGE, not a rewrite — wording carried over where the value
// survived (divorce, probate, senior, expired, fsbo, other), adapted where the
// live CHECK fuses or renames the idea (first_time ⊃ first_time_buyer +
// first_time_seller; luxury ⊃ luxury_buyer + luxury_seller; relocated ≈
// relocating; upsize ≈ upsizers; downsize ≈ empty_nester's downsizing idea).
// `foreclosure` and `military` are live CHECK members the old roster lacked.
//
// `investor` — the rekey dropped it, recording "lives on contact_type — never a
// persona". THE OWNER OVERRULED THAT, verbatim: "one thing to note that investor
// is a persona and not a contact type." An investment purchase is a SITUATION —
// it selects the wording, the lessons, the campaigns — not a transaction side
// (an investor is a buyer). m589 (APPLIED) widened contacts_contact_persona_check
// to fourteen values including 'investor'; the code half is restored here and
// across every Record<Persona, …> consumer.
//
// `motivated_seller` STAYS OUT, with the owner's invitation to suggest better
// taken up ("motivated seller i belive we use for lead scrapping … but if there
// is a better way that you suggest, then we can go with your suggestions"): the
// persona says the SITUATION (probate / divorce / foreclosure / expired / fsbo /
// senior already name the why), lead_temperature says the urgency, and the
// scraping pipeline's motivation facts (motivated_seller_signals,
// motivation_type — FENCED, untouched) keep the fact. A 'motivated_seller'
// persona would flatten five existing personas into one label. Where a mapper
// meets that spelling it maps to NO persona, never onto a distress persona by
// guess. `remote_seller` stays dropped (no live equivalent).
export const STANDARD_CONTACT_PERSONAS = [
  "first_time",
  "luxury",
  "relocated",
  "upsize",
  "downsize",
  "military",
  "foreclosure",
  "divorce",
  "probate",
  "senior",
  "expired",
  "fsbo",
  "investor",
  "other",
] as const satisfies readonly import("@/lib/kernel/types").Persona[]

export type StandardContactPersona = (typeof STANDARD_CONTACT_PERSONAS)[number]

// `investor` REMOVED from this roster (2026-08-31) on the same owner ruling that
// added it to the personas above: "investor is a persona and not a contact
// type." An investor is a BUYER whose situation is an investment purchase —
// contact_type says the transaction side, contact_persona says the situation.
// Live census at removal time: ZERO contacts rows carried
// contact_type='investor' (buyer:2, lifetime_customer:1, seller:1), so nothing
// strands. The DB half — retiring 'investor' from contacts_contact_type_check —
// is m593 (WRITTEN, awaiting the integrator); until it applies,
// lib/contact-types.ts CONTACT_TYPES (the live-CHECK mirror) still lists it.
export const STANDARD_CONTACT_TYPES = [
  "buyer",
  "seller",
  "lender",
  "commercial",
  "other",
  "agent",
  "vendor",
  "TC",
] as const

export type StandardContactType = (typeof STANDARD_CONTACT_TYPES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TIMELINE VOCABULARY. Six spellings collapsed into this list.
//
// "How soon does this person intend to transact" was spelled SIX ways across
// FOUR columns, and outside `immediate` — the one token most of them happened to
// share — no comparison in the system could ever be true. They were string
// equality tests against free-text columns with no CHECK, so nothing errored and
// timeline contributed 0 to every score that claimed to weigh it:
//
//   1. `immediate | 1-3 months | 3-6 months | 6-12 months`   (SPACES)
//      lib/lead-promotion/initial-scorer.ts, lib/lead-governance/multi-factor-scorer.ts,
//      lib/agent-orchestration/action-plan-generator.ts — all on `leads.timeline`
//   2. `immediate | 1-3_months | 3-6_months | 6-12_months`   (UNDERSCORES)
//      lib/services/lead-management.service.ts + app/actions/lead-intelligence.ts,
//      on `lead_intelligence.timeline` — the ONE writer/reader pair that agreed
//   3. `0-3_months | 3-6_months | 6-12_months | 12+_months`
//      types/contact.ts, lib/domain/types.ts, lib/lifecycle/offer-lifecycle.ts,
//      and a dead fourth copy in services/aiMappingService.ts
//   4. `immediate | 30_days | 60_days | 90_days | 6_months | 12_months | 12_plus_months`
//      THIS CONSTANT, as it previously stood — see the OWNER QUESTION below
//   5. `asap | urgent`                       app/actions/copilot.ts, on `contacts.timeline`
//   6. `immediate | 1-3months | 3-6months`   (NO SEPARATOR) app/actions/lead-intelligence.ts,
//      and that one was a LIVE GATE refusing everything else onto
//      `unified_lead_profile.estimated_timeline`
//
// WHY THESE MEMBERS AND NOT ANOTHER SET. Two things were being conflated: the
// BUCKET BOUNDARIES and the SPELLING. Only the spelling was ever in dispute.
// Boundaries `immediate | 1-3 | 3-6 | 6-12 (| 12+)` are what five of the six
// spellings encode, what all six live readers score against, and what BOTH
// legacy CHECK constraints written for these columns encode
// (scripts/010-create-contacts-schema.sql:21 for contacts.timeline,
// scripts/310-create-comprehensive-lead-intelligence-system.sql:14 for
// lead_intelligence.timeline). Collapsing them is a spelling consolidation with
// no behavioural change. The separator is snake_case because every other
// vocabulary in this file and every live CHECK in this database is snake_case,
// and because it is the spelling of the only writer/reader pair that already
// agreed (#2 above), so that pair keeps working unchanged.
//
// `researching` is kept, not invented: it is the value
// app/actions/lead-intelligence.ts:1308 initialises every lead_intelligence row
// to, and scripts/310 admitted it. It is the "stated no horizon" bucket. NULL
// still means "never asked".
//
// OWNER QUESTION, DELIBERATELY NOT DECIDED HERE — the 30/60/90-day granularity
// that used to be this constant. That is NOT a spelling: it splits `1-3_months`
// into three buckets and re-frames every bucket from a WINDOW ("between 3 and 6
// months") to a DEADLINE ("by 90 days"), which changes what a broker is told and
// what each bucket is worth in three separate scoring ladders. It is a product
// decision, so it was not made by consolidation. The evidence for leaving it
// behind for now: `STANDARD_TIMELINES` and `TIMELINE_LABELS` had ZERO importers
// anywhere in the tree, no writer ever produced a 30/60/90 value, and the only
// place those values appear on a row is the demo seed
// scripts/351-create-demo-contacts-simple.sql. If the owner wants the finer
// granularity, it lands here and in the CHECK from m487 together, and the three
// scoring ladders that key on these members
// (lib/lead-promotion/initial-scorer.ts, lib/lead-governance/multi-factor-scorer.ts,
// lib/services/lead-management.service.ts) each need new point values — which is
// exactly the part that cannot be guessed.
//
// BEHIND THE DATABASE: supabase/migrations/m487-one-timeline-vocabulary-…sql puts
// this exact list on a CHECK over leads.timeline, contacts.timeline,
// contacts.timeline's promotion source, lead_intelligence.timeline and
// unified_lead_profile.estimated_timeline, so the other five spellings can no
// longer be stored.
export const STANDARD_TIMELINES = [
  "immediate",
  "1-3_months",
  "3-6_months",
  "6-12_months",
  "12+_months",
  "researching",
] as const

export type StandardTimeline = (typeof STANDARD_TIMELINES)[number]

// TOMBSTONE (§1.1 / §6, 2026-08-29): `STANDARD_SOURCES`, `StandardSource` and
// their `SOURCE_LABELS` map are DELETED from this module.
// SURVIVOR: lib/constants/index.ts:152 `LEAD_SOURCES` + `LEAD_SOURCE_LABELS`
// (+ `LEAD_SOURCE_ALIASES` / `normalizeLeadSource`, the half that actually
// binds at the write seam) — MERGED ONTO FIRST, then deleted here:
//   · `sphere`, `past_client`, `zillow_premier`, `realtor_com_premier` were the
//     four ideas the survivor lacked; they are now members of LEAD_SOURCES with
//     this file's own wording carried over verbatim into LEAD_SOURCE_LABELS, so
//     nothing user-visible changed.
//   · every other member of this list was already a member of the survivor.
//
// WHY IT WAS SAFE, checked rather than assumed (comment-stripped, whole tree):
//   · `grep -rn "STANDARD_SOURCES\|StandardSource"` matched this file and
//     services/aiMappingService.ts and NOTHING else. That other file is a
//     SIXTH copy — 7 values, `social` and `realtor.com` — with no `mapSource`
//     to consume it; it is deleted in the same change.
//   · The two copies were invisible to the orphan census because they ACQUIT
//     EACH OTHER: the census asks "does this identifier occur in some other
//     file?", never "does that file reach my module?". Two dead modules that
//     happen to spell a name the same way clear each other forever. Only
//     SOURCE_LABELS — a name nothing else spells — was ever reported.
//
// The live column carries no CHECK (contacts.source, leads.source — measured
// 2026-08-25), so the vocabulary binds ONLY where code calls it. That is why the
// survivor is the one with `normalizeLeadSource` and this one had to go, rather
// than the other way round.

// Human-readable labels for display
export const STATUS_LABELS: Record<StandardCRMStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment_booked: "Appointment Booked",
  signed_agreement: "Signed Agreement",
  pre_listing: "Pre-Listing",
  active_listing: "Active Listing",
  contingent: "Contingent",
  pending: "Pending",
  sold: "Sold",
  lifetime_customer: "Lifetime Customer",
}

// Keyed on the LIVE persona vocabulary (see the rekey note above STANDARD_CONTACT_PERSONAS).
export const PERSONA_LABELS: Record<StandardContactPersona, string> = {
  first_time: "First-Timer",
  luxury: "Luxury",
  relocated: "Relocating",
  upsize: "Upsizing",
  downsize: "Downsizing",
  military: "Military",
  foreclosure: "Foreclosure",
  divorce: "Divorce",
  probate: "Probate",
  senior: "Senior",
  expired: "Expired Listing",
  fsbo: "FSBO",
  investor: "Investor",
  other: "Other",
}

// `investor` label moved to PERSONA_LABELS above (owner ruling — see
// STANDARD_CONTACT_TYPES).
export const CONTACT_TYPE_LABELS: Record<StandardContactType, string> = {
  buyer: "Buyer",
  seller: "Seller",
  lender: "Lender",
  commercial: "Commercial",
  other: "Other",
  agent: "Agent",
  vendor: "Vendor",
  TC: "Transaction Coordinator",
}

export const TIMELINE_LABELS: Record<StandardTimeline, string> = {
  immediate: "Immediate",
  "1-3_months": "1-3 Months",
  "3-6_months": "3-6 Months",
  "6-12_months": "6-12 Months",
  "12+_months": "12+ Months",
  researching: "Just Researching",
}

// `SOURCE_LABELS` — DELETED here with the vocabulary it labelled. Its wording is
// now LEAD_SOURCE_LABELS at lib/constants/index.ts:174; see the tombstone above
// STATUS_LABELS in this file for the full merge record.

// Keyed on the LIVE persona vocabulary; wording carried over from the old roster wherever the
// value survived the rekey. Also the ONE source the AI import mapper's prompt is built from
// (services/aiMappingService.ts mapPersona), so the mapper's target set and these descriptions
// cannot drift apart again.
export const PERSONA_DESCRIPTIONS: Record<StandardContactPersona, string> = {
  first_time: "Never bought or sold before, needs education and guidance",
  luxury: "High-end property, expects premium service",
  relocated: "Moving for job/life change, dual market needs",
  upsize: "Buying larger property, growing family",
  downsize: "Downsizing — smaller home, empty nest or simplifying",
  military: "Military move — PCS timelines, VA financing",
  foreclosure: "Facing foreclosure, time-critical and sensitive",
  divorce: "Divorce-related sale, sensitive situation",
  probate: "Inherited property, legal complexities",
  senior: "Senior citizen with age-specific needs",
  expired: "Previous listing expired, needs new strategy",
  fsbo: "For Sale By Owner, considering agent representation",
  investor:
    "Investment purchase — building or expanding a portfolio (rental income, flip, 1031 exchange); ROI- and numbers-driven rather than a home to live in",
  other: "Other type of contact",
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PERSONA / TIMELINE RENDERERS (§6, 2026-08-31). Every surface that
// showed a persona or timeline value wrote its own string transform instead of
// reading the label maps above — `.replace(/_/g, " ")` in one card,
// `.replace(/-/g, " ")` (the WRONG separator — live values are snake_case, so it
// changed nothing) in another, and three surfaces rendering the raw DB value
// ("1-3_months") to the user. These two helpers are the door: known values get
// the canonical label; an unknown/historical value falls back to a readable
// de-snaked spelling rather than lying or vanishing.

/** Canonical display label for a contact persona value; null in → null out. */
export function personaLabel(v: string | null | undefined): string | null {
  if (!v) return null
  return (PERSONA_LABELS as Record<string, string>)[v] ?? v.replace(/_/g, " ")
}

/** Canonical display label for a timeline value; null in → null out.
 *  Timeline stays in BUCKETS (1-3 / 3-6 / 6-12) — never 30/60/90 (owner ruling;
 *  see the OWNER QUESTION note above STANDARD_TIMELINES). */
export function timelineLabel(v: string | null | undefined): string | null {
  if (!v) return null
  return (TIMELINE_LABELS as Record<string, string>)[v] ?? v.replace(/_/g, " ")
}

// `lib/contact-utils.ts` — WHOLE FILE DELETED (orphan burn-down, category C).
//
// It was a second, older copy of this file. It had ZERO importers anywhere in
// the tree — `grep -rn "contact-utils" --include=*.ts --include=*.tsx` matched
// nothing outside its own body; the only mentions left were tsconfig.tsbuildinfo,
// scripts/orphan-export-baseline.json and docs/wave44-audit.md, all prose or
// build residue.
//
// MERGED IN BEFORE DELETION: `getPersonaDescription()`'s 16-entry description
// map. It was the one thing that file had and this one lacked, and it is the
// block directly above (`PERSONA_DESCRIPTIONS`) — re-keyed to
// `StandardContactPersona`, which has exactly the same 16 members. Nothing was
// lost.
//
// The rest each collapse into a NAMED, MORE COMPLETE survivor:
//   CONTACT_TYPE_LABELS  → constants/crm-standards.ts:181 (this file)
//   CONTACT_PERSONA_LABELS → PERSONA_LABELS, constants/crm-standards.ts:162
//   STATUS_LABELS        → constants/crm-standards.ts:148
//   TIMELINE_LABELS      → constants/crm-standards.ts:193
//   getStatusColor()     → app/leads/page.tsx:671 and
//                          app/(external-portal)/components/os/external-active-files-panel.tsx:32,
//                          both LIVE and both already rendering the badge the
//                          lib copy was written for.
//   getUrgencyColor() / calculateDaysUntilTimeline() →
//                          app/dashboard/agent/components/conversion/newly-converted-contacts-panel.tsx:121
//                          and app/dashboard/communications/components/os/response-pressure-panel.tsx:44,
//                          again both LIVE.
//
// `getTimelineColor()` and `getTimelineUrgency()` had no survivor because they
// had no subject. They switched on the then-`ContactTimeline` = "0-3_months" |
// "3-6_months" | "6-12_months" | "12+_months", and NO WRITER IN THIS REPOSITORY
// PRODUCED THAT VOCABULARY on a row anyone read. Both were total switches with
// no default, so on any value the live scorers actually saw they fell off the
// end and returned `undefined` — a badge class of `undefined`, an urgency of
// `undefined`. They could not have worked.
//
// THE VOCABULARY SPLIT THIS NOTE LEFT OPEN IS NOW CLOSED — see the long note on
// STANDARD_TIMELINES above. `ContactTimeline` (types/contact.ts,
// lib/domain/types.ts) is now an alias of `StandardTimeline` declared here, so
// there is one list and it cannot drift again. The claim this note used to make
// about `services/aiMappingService.ts:57` was WRONG and was checked before being
// acted on: that module IS live for mapStatus/mapPersona, but it has no
// `mapTimeline` and nothing anywhere imports its `STANDARD_TIMELINES` or
// `StandardTimeline` — only the `aiMappingService` object itself is imported
// (services/supabaseService.ts:5). Its timeline copy normalized nothing. It has
// been deleted, with a tombstone naming this file as the survivor.
