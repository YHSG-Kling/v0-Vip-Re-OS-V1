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

export const STANDARD_CONTACT_PERSONAS = [
  "first_time_buyer",
  "luxury_buyer",
  "luxury_seller",
  "investor",
  "first_time_seller",
  "motivated_seller",
  "relocating",
  "empty_nester",
  "probate",
  "remote_seller",
  "divorce",
  "upsizers",
  "senior",
  "expired",
  "fsbo",
  "other",
] as const

export type StandardContactPersona = (typeof STANDARD_CONTACT_PERSONAS)[number]

export const STANDARD_CONTACT_TYPES = [
  "buyer",
  "seller",
  "investor",
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

export const PERSONA_LABELS: Record<StandardContactPersona, string> = {
  first_time_buyer: "First Time Buyer",
  luxury_buyer: "Luxury Buyer",
  luxury_seller: "Luxury Seller",
  investor: "Investor",
  first_time_seller: "First Time Seller",
  motivated_seller: "Motivated Seller",
  relocating: "Relocating",
  empty_nester: "Empty Nester",
  probate: "Probate",
  remote_seller: "Remote Seller",
  divorce: "Divorce",
  upsizers: "Upsizer",
  senior: "Senior",
  expired: "Expired Listing",
  fsbo: "FSBO",
  other: "Other",
}

export const CONTACT_TYPE_LABELS: Record<StandardContactType, string> = {
  buyer: "Buyer",
  seller: "Seller",
  investor: "Investor",
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

export const PERSONA_DESCRIPTIONS: Record<StandardContactPersona, string> = {
  first_time_buyer: "Never owned before, needs education and guidance",
  luxury_buyer: "High-end purchase, expects premium service",
  luxury_seller: "High-end property sale, sophisticated needs",
  investor: "Investment focused, ROI driven",
  first_time_seller: "First time selling, needs process guidance",
  motivated_seller: "Needs to sell quickly, time-sensitive",
  relocating: "Moving for job/life change, dual market needs",
  empty_nester: "Downsizing after children leave",
  probate: "Inherited property, legal complexities",
  remote_seller: "Selling from distance, remote management",
  divorce: "Divorce-related sale, sensitive situation",
  upsizers: "Buying larger property, growing family",
  senior: "Senior citizen with age-specific needs",
  expired: "Previous listing expired, needs new strategy",
  fsbo: "For Sale By Owner, considering agent representation",
  other: "Other type of contact",
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
