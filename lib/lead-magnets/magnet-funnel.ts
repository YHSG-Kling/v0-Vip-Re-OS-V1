// lib/lead-magnets/magnet-funnel.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C21 — THE LEAD-MAGNET FUNNEL PACKAGE (wave 148, lane 148G — owner ruling 11, 2026-11-01).
//
// OWNER: "the lead magnets first create the landing pages, forms (which can have the specific data about that person requesting
// the magnet) and then what the deliverables will need to be. Don't just limit the magnet to be a guide or book — it could be an
// education video and deliverables can be a funnel with a thank-you, video along with a calendar link, etc. Think of yourself as
// being a brilliant and creative marketer. Some magnet assets can be staged." Books stay the separate publishing capability.
//
//   createMagnetFunnel(brief) → { landing_page, form (C15 + identity + situation + owner), deliverables[] (any kind, staged
//   allowed), thank_you, optional: personal_video, calendar_link, portal_task, education_sequence, follow_up_policy, attribution,
//   learning } — published only when every PROMISED deliverable is validated or carries a truthful, enforceable arrangement.
//
// AUDITED FIRST — EVERY HOP IS A SURVIVOR (LAW 1 / LAW 2; nothing here is a second engine):
//   landing page + form   lib/lead-magnets/ai-draft.ts draftLeadMagnetFromConcept → lib/kernel/lead-magnets.ts createLeadMagnet
//                         (the ONE writer of lead_capture_forms; draft state; fair-housing rewrite loop; the humanized final staged
//                         for the publish version check), served INSIDE the tenant's website by app/site/[slug]/lm/[formSlug]
//                         (lib/tenant-site/landing-page.ts resolveTenantLandingForm — the form proven to be THIS site's tenant)
//   the primary asset     contract C11 — lib/lead-magnets/deliverable-asset.ts produceLeadMagnetDeliverable, created WITH the
//                         magnet (one unit), publishable only when READY; m898's trigger (extended by m921 for funnels)
//   promise + delivery    contract C4 — lib/lead-magnets/promised-deliverables.ts (one promise per request; the funnel's other
//                         assets ride the SAME delivery as a bundle; retries, escalation, the arbiter's moment)
//   consent               contract C15 — lane 148B's one consent component + server contract (purposes, channels, wording hash /
//                         version, creator). This module DECLARES the form's consent spec; it never authors consent wording.
//   assignment            captureFormSubmission already files a new contact to the form's agent and claims an unowned one —
//                         the form's owner (agents.id + the creating users.id) is recorded so the person is assigned back
//   video                 lib/video/video-director.ts commissionVideo (pending_review) → lib/video/video-staging.ts (rights,
//                         branding, audience, channel, C5 approver) — a video is READY only when stagedPublicationVerdict says
//                         an assigned approver approved it; until then it is STAGED (consumed, never edited)
//   checklist / report    lib/documents/client-document-producer.ts produceClientDocument (tenant-branded PDF) · the market-report
//                         producer (lib/market-reports/producer.ts — verified data + the market registry only, ruling 10)
//   calendar / consult    the agent's real calendar (calendar_provider_accounts → lib/ai-isa/listing-appointment.ts' finder) and
//                         the task board (tasks, due) — a promise the agent's queue and the arbiter enforce
//   education sequence    campaign_sequences + lib/campaign-sequences/enrollment-engine.ts enrollContact (journey "hold")
//   portal task           lib/kernel/portal-value.ts pushPortalValueCard (the contact's own feed)
//   approval              contract C5 — lib/kernel/approval-authority.ts approverFor (assetKind "asset"); publishLeadMagnet
//   humanised / branded   lib/marketing/humanize-final.ts + the tenant brand on every PDF; fair housing on public copy only
//   attribution           lib/lead-magnets/attribution.ts (ONE query-string contract) · learning: getMagnetPerformance
//   evidence              withActionLedger "marketing.lead_magnet_funnel.create" (LAW 5) — model calls are routed (ai_tool_usage)
//
// HONESTY RULES (the brilliant marketer who never promises what does not exist):
//   · a deliverable is PROMISED on the page only when it is READY (produced, validated) or ARRANGED (a truthful, enforceable
//     arrangement: a scheduled session, an enrolled sequence that exists, an agent seat with a due task); the page's "what you get"
//     lines are composed from those items and nothing else;
//   · a STAGED asset (a video awaiting its approver) is never promised before it is ready — it is delivered as a bonus once
//     approved; a staged PRIMARY keeps the whole offer unpublished (C11);
//   · a PLANNED item (no session scheduled, no sequence to enrol in, no agent seat) is recorded with its reason and never promised;
//   · an arranged item's promise line is the ARRANGEMENT's own sentence — the model never writes a promise the mechanism does not
//     keep; a promise line carrying a figure ($, %) is replaced (no invented statistic).
//
// Not server-only (the proof drives it in memory with seams); providers, the AI gateway, the renderer and the ledger are lazy
// imports at their call. Every write is tenant-pinned and counted; every { error } is read. Never throws.

import { z } from "zod"
import { PROMISE_ASSET_KINDS } from "./promised-deliverables"
import type { ProducedDeliverable, DeliverableDeps } from "./deliverable-asset"
import type { LeadMagnetField } from "@/lib/kernel/lead-magnets"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { LEAD_MAGNET_ATTRIBUTION_PARAMS, leadMagnetLandingUrl } from "./attribution"

type Db = { from: (table: string) => any }

// ── VOCABULARIES (one spelling each — CLAUDE.md §6; m921's CHECKs are held equal by scripts/magnet-funnel-guard.ts) ──────────

/** What a funnel may deliver: the C4/C11 asset kinds (spread, never restated) + the kinds only an arrangement or a person keeps. */
export const FUNNEL_DELIVERABLE_KINDS = [...PROMISE_ASSET_KINDS, "calculator", "webinar", "mini_course", "consultation"] as const
export type FunnelDeliverableKind = (typeof FUNNEL_DELIVERABLE_KINDS)[number]
/** The optional thank-you steps (C21). */
export const FUNNEL_STEP_KINDS = ["personal_video", "calendar_link", "portal_task", "education_sequence"] as const
export type FunnelStepKind = (typeof FUNNEL_STEP_KINDS)[number]
export const FUNNEL_ITEM_KINDS = [...FUNNEL_DELIVERABLE_KINDS, ...FUNNEL_STEP_KINDS] as const
export type FunnelItemKind = (typeof FUNNEL_ITEM_KINDS)[number]
export const FUNNEL_ITEM_ROLES = ["primary", "deliverable", "step"] as const
export type FunnelItemRole = (typeof FUNNEL_ITEM_ROLES)[number]
export const FUNNEL_ITEM_FULFILMENTS = ["asset", "arrangement", "human"] as const
export type FunnelItemFulfilment = (typeof FUNNEL_ITEM_FULFILMENTS)[number]
export const FUNNEL_ITEM_STATUSES = ["planned", "producing", "staged", "ready", "arranged", "failed", "withdrawn"] as const
export type FunnelItemStatus = (typeof FUNNEL_ITEM_STATUSES)[number]
/** The kinds the C11 deliverable produces as the PRIMARY (the one the C4 promise is made against). Books stay the separate
 *  publishing capability (ruling 11) — a funnel never plans one. */
export const FUNNEL_PRIMARY_KINDS = ["guide", "report", "valuation", "checklist", "video"] as const
export type FunnelPrimaryKind = (typeof FUNNEL_PRIMARY_KINDS)[number]
/** The secondary deliverables the planner may propose (no book, no second guide — the guide booklet is a primary's producer). */
const SECONDARY_KINDS = ["checklist", "video", "report", "calculator", "webinar", "mini_course", "consultation", "valuation"] as const

/** PURE. Who keeps the promise for this kind. */
function fulfilmentForKind(kind: FunnelItemKind): FunnelItemFulfilment {
  switch (kind) {
    case "guide": case "book": case "report": case "checklist": case "video": return "asset"
    case "valuation": case "consultation": case "calendar_link": return "human"
    default: return "arrangement"
  }
}

/** contacts_timeline_check (the live CHECK — §5 buckets, never 30/60/90). Held equal to scripts/check-vocabularies.ts by the proof. */
export const FUNNEL_TIMELINE_OPTIONS: ReadonlyArray<{ label: string; value: string }> = Object.freeze([
  { label: "Ready now", value: "immediate" },
  { label: "In the next 1–3 months", value: "1-3_months" },
  { label: "In 3–6 months", value: "3-6_months" },
  { label: "In 6–12 months", value: "6-12_months" },
  { label: "A year or more out", value: "12+_months" },
  { label: "Just researching", value: "researching" },
])

/** A capture field with the canonical column its answer maps onto (lane 148B's door applies it — Outside-lane handoff). */
export interface FunnelFormField extends LeadMagnetField {
  maps_to?: { column: "contacts.timeline" | "contacts.contact_type"; values: Record<string, string> }
  /** identity | situation | qualifier — what kind of fact the field collects (ruling 12). */
  purpose: "identity" | "situation" | "qualifier"
}

/** The situation questions the planner may choose from (it cannot invent a field name).
 *  TOMBSTONE (wave 149, lane 149D — owner ruling 16): `biggest_question` ("What is the one question you most want answered?",
 *  a REQUIRED open textarea on every funnel form) is GONE — a generic open question is exactly what ruling 16 forbids. Its job
 *  (what this person needs) is done by the situation's own questions: THE QUALIFYING QUESTIONS section below
 *  situationQuestionsFor (per persona / side, selects only), merged in composeFunnelPlan below. */
export const SITUATION_KEYS = ["timeline", "move_side", "current_home", "area_of_interest", "property_address"] as const
type SituationKey = (typeof SITUATION_KEYS)[number]
const SITUATION_FIELDS: Readonly<Record<SituationKey, FunnelFormField>> = Object.freeze({
  timeline: { name: "timeline", label: "When are you hoping to make a move?", type: "select", required: false, purpose: "situation", options: FUNNEL_TIMELINE_OPTIONS.map((o) => o.label), maps_to: { column: "contacts.timeline", values: Object.fromEntries(FUNNEL_TIMELINE_OPTIONS.map((o) => [o.label, o.value])) } },
  move_side: { name: "move_side", label: "Are you thinking about buying, selling, or both?", type: "select", required: false, purpose: "situation", options: ["Buying", "Selling", "Both", "Just exploring"], maps_to: { column: "contacts.contact_type", values: { Buying: "buyer", Selling: "seller", Both: "both" } } },
  current_home: { name: "current_home", label: "Do you currently own or rent?", type: "select", required: false, purpose: "situation", options: ["Own", "Rent", "Something else"] },
  area_of_interest: { name: "area_of_interest", label: "Which area are you most interested in?", type: "text", required: false, purpose: "situation" },
  property_address: { name: "property_address", label: "Your property address (if you own)", type: "text", required: false, purpose: "situation" },
})
/** Every funnel form carries the timeline bucket (ruling 12); the buy / sell question only when the situation does not already
 *  say the side (a probate heir is not asked whether they are buying). */
const REQUIRED_SITUATION: readonly SituationKey[] = ["timeline"]

// ── THE QUALIFYING QUESTIONS A LEAD-MAGNET FORM ASKS — PER SITUATION (wave 149, lane 149D — owner ruling 16, 2026-11-03:
// "Registration 'other question' is not an open question — it asks the question(s) that pertain to the situation the form
// collects. Same for every form's qualifying questions").
//
// WHAT THIS REPLACES (tombstone, CLAUDE.md §1.3 — the functionality lives here now): lib/lead-magnets/magnet-funnel.ts carried
// one REQUIRED open question on every funnel form — `biggest_question` ("What is the one question you most want answered?",
// a textarea). That is exactly the generic open question ruling 16 forbids. Its job — learning what the person needs so the
// agent can truly help — is done here by questions that BELONG to the person's situation (a probate heir is asked about the
// estate's stage; a first-time buyer about financing readiness), each a short select so the answer is usable, mappable and
// light on friction (market-landing: every extra field costs conversion; 3–5 is the lead-capture norm).
//
// PERSONAS (owner ruling 1 + 2, wave 149): EVERY persona is allowed and this cannot change. A persona is the person's
// SITUATION, so the OS can speak to their pain points. The keys below are the kernel portal's persona keys
// (lib/portal/persona-config.ts PERSONA_CONFIGS — the layout authority; scripts/lead-magnet-package-guard.ts holds every one of
// them to a question set) plus the campaign spellings (persona-layers campaignPersona: first_time, relocated, …) as ALIASES —
// one canonical key per situation (§6), never a second vocabulary. An unknown persona is never refused: it falls back to the
// buyer / seller set for its side.
//
// WORDING (the only place fair housing applies — the preamble's correction): the questions describe the SITUATION and the
// HOME, never a protected characteristic or its proxy (no age, marital / family status, children, religion, origin,
// disability, sex, source of income). A sensitive situation is never named on the form (a divorcing owner is asked whether a
// settlement timeline applies; a probate heir about their role with the property) — kind, never intrusive, never exploiting
// hardship. lib/lead-magnets/magnet-funnel.ts PROTECTED_QUESTION screens every one of these (the proof runs it over the bank).
//
// PURE. No I/O. Lives in THIS module (not a sibling file) so no app entry's first-party graph grows (test:proxy-graph-budget —
// app/crm/page.tsx reaches this module through promised-deliverables and sits at its 1300 cap).

export type SituationSide = "buyer" | "seller" | "both"

/** A situation question: a select (the answer is a usable fact, never an essay). `key` is the form field name. */
export interface SituationQuestion { key: string; label: string; options: string[] }

/** The canonical situation keys (= lib/portal/persona-config.ts PERSONA_CONFIGS keys, + foreclosure, + other). */
export const SITUATION_PERSONAS = [
  "first_time_buyer", "military_buyer", "luxury_buyer", "investor", "first_time_seller", "motivated_seller", "divorce",
  "probate", "senior", "relocating", "luxury_seller", "fsbo", "expired", "upsizers", "empty_nester", "remote_seller",
  "foreclosure", "other",
] as const
export type SituationPersona = (typeof SITUATION_PERSONAS)[number]

/** Other spellings of the same situation (the campaign / research vocabularies) → the ONE canonical key (§6). */
export const SITUATION_PERSONA_ALIASES: Readonly<Record<string, SituationPersona>> = Object.freeze({
  first_time: "first_time_buyer", first_time_home_buyer: "first_time_buyer", ftb: "first_time_buyer",
  military: "military_buyer", va_buyer: "military_buyer",
  luxury: "luxury_buyer",
  relocated: "relocating", relocation: "relocating",
  upsize: "upsizers", upsizer: "upsizers", move_up: "upsizers",
  downsize: "empty_nester", downsizer: "empty_nester", downsizing: "empty_nester",
  out_of_state_seller: "remote_seller",
  pre_foreclosure: "foreclosure", distressed: "foreclosure",
  estate: "probate", inherited: "probate",
  for_sale_by_owner: "fsbo",
  expired_listing: "expired",
})

/** PURE. Any persona spelling → the canonical situation key; an unknown one is `other` (never refused). */
export function canonicalSituation(persona: string | null | undefined): SituationPersona {
  const k = String(persona ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if ((SITUATION_PERSONAS as readonly string[]).includes(k)) return k as SituationPersona
  return SITUATION_PERSONA_ALIASES[k] ?? "other"
}

/** The side a situation speaks to (a persona that can be either asks the side). */
export const SITUATION_SIDE: Readonly<Record<SituationPersona, SituationSide | null>> = Object.freeze({
  first_time_buyer: "buyer", military_buyer: "buyer", luxury_buyer: "buyer", investor: "buyer", relocating: "buyer", upsizers: "both",
  first_time_seller: "seller", motivated_seller: "seller", divorce: "seller", probate: "seller", luxury_seller: "seller", fsbo: "seller",
  expired: "seller", remote_seller: "seller", foreclosure: "seller", senior: "both", empty_nester: "both", other: null,
})

/** The human label of each situation (the Create door's choices). */
export const SITUATION_LABELS: Readonly<Record<SituationPersona, string>> = Object.freeze({
  first_time_buyer: "First-time buyers", military_buyer: "Military and VA buyers", luxury_buyer: "Luxury buyers", investor: "Investors",
  first_time_seller: "First-time sellers", motivated_seller: "Sellers who need to move soon", divorce: "Owners selling during a separation",
  probate: "Families handling an inherited or estate property", senior: "Owners planning their next chapter", relocating: "People relocating to the area",
  luxury_seller: "Luxury sellers", fsbo: "Owners selling on their own (FSBO)", expired: "Owners whose listing expired", upsizers: "Owners who need more space",
  empty_nester: "Owners who want less space", remote_seller: "Owners selling from out of town", foreclosure: "Owners facing a payment deadline",
  other: "Someone else (describe them)",
})

const CONDITION: SituationQuestion = { key: "home_condition", label: "What condition is the home in?", options: ["Move-in ready", "Needs minor work", "Needs major work", "Not sure"] }
const BUY_FIRST: SituationQuestion = { key: "buy_before_sell", label: "Do you need to sell your current home before you buy the next one?", options: ["Yes", "No", "Not sure yet"] }
const FINANCING: SituationQuestion = { key: "financing_stage", label: "Where are you with financing?", options: ["Haven't started", "Talking to a lender", "Pre-approved", "Paying cash"] }
const SELL_SUCCESS: SituationQuestion = { key: "sale_priority", label: "What would make this sale a success for you?", options: ["The best price", "A smooth, quick sale", "Timing it with my next move", "Fewer showings and less disruption"] }

/** The bank: 1–3 situation questions per situation (the timeline / side / own-rent / address fields are added by the funnel). */
export const SITUATION_QUESTIONS: Readonly<Record<SituationPersona, readonly SituationQuestion[]>> = Object.freeze({
  first_time_buyer: [FINANCING, { key: "first_hurdle", label: "What feels like the biggest hurdle right now?", options: ["Saving for the down payment", "Understanding the steps", "Choosing the right area", "Competing with other offers"] }],
  military_buyer: [{ key: "va_loan", label: "Are you planning to use a VA home loan?", options: ["Yes", "Maybe — I'd like to learn more", "No"] }, { key: "report_date", label: "Is your move tied to a report or start date?", options: ["Yes, I have a date", "Not yet", "No"] }],
  luxury_buyer: [{ key: "home_priority", label: "What matters most in your next home?", options: ["Privacy and space", "Location and views", "Architecture and finishes", "Room to host"] }, { key: "showing_preference", label: "How would you like to see homes?", options: ["Private showings only", "Open to either", "Virtual first"] }],
  investor: [{ key: "investment_focus", label: "What kind of investment are you focused on?", options: ["Long-term rental", "Short-term rental", "Fix and flip", "Small multifamily"] }, { key: "investment_financing", label: "How are you planning to finance it?", options: ["Cash", "Conventional loan", "Investor (DSCR) loan", "Not sure yet"] }],
  first_time_seller: [SELL_SUCCESS, BUY_FIRST],
  motivated_seller: [{ key: "most_helpful", label: "What would help most right now?", options: ["A firm price range", "Selling as-is", "Help with repairs", "Comparing a cash offer"] }, CONDITION],
  divorce: [{ key: "settlement_timeline", label: "Does the sale need to follow a settlement or court timeline?", options: ["Yes", "No", "Not sure yet"] }, { key: "owners_on_title", label: "Will more than one owner need to sign and receive updates?", options: ["Yes, more than one owner", "Just me", "Not sure"] }],
  probate: [{ key: "property_role", label: "What is your role with the property?", options: ["Executor or administrator", "Heir or beneficiary", "Attorney or advisor", "Other"] }, { key: "estate_stage", label: "Where is the estate in the process?", options: ["Just getting started", "Court approval pending", "Authority to sell granted", "Not sure"] }, CONDITION],
  senior: [{ key: "next_home_priority", label: "What matters most in your next home?", options: ["Less upkeep", "Single-level living", "Closer to the people and places I care about", "Lower monthly costs"] }, { key: "moving_help", label: "Would help sorting, moving or storing belongings be useful?", options: ["Yes, a lot", "A little", "No"] }],
  relocating: [{ key: "search_mode", label: "How would you like to find your home?", options: ["Remotely, before I arrive", "I'll visit first", "Renting first, buying later"] }, { key: "timing_driver", label: "What is setting your timing?", options: ["A job start date", "A lease ending", "Flexible"] }, FINANCING],
  luxury_seller: [{ key: "marketing_preference", label: "How would you like your home marketed?", options: ["Full marketing", "Discreet / off-market", "Not sure yet"] }, SELL_SUCCESS],
  fsbo: [{ key: "fsbo_duration", label: "How long have you been selling on your own?", options: ["Just started", "A few weeks", "A few months or more"] }, { key: "most_helpful", label: "What would help most?", options: ["Pricing it right", "Getting more buyers to see it", "Handling offers and paperwork", "Comparing my options"] }],
  expired: [{ key: "held_back", label: "What do you think held the last listing back?", options: ["Price", "Marketing", "Condition", "Timing"] }, { key: "still_selling", label: "Are you still hoping to sell?", options: ["Yes, soon", "Yes, later", "Not sure"] }],
  upsizers: [{ key: "need_more", label: "What do you need more of?", options: ["Bedrooms", "Office space", "Outdoor space", "Storage or garage"] }, BUY_FIRST],
  empty_nester: [{ key: "next_home_priority", label: "What matters most in your next home?", options: ["Less upkeep", "Single-level living", "A lock-and-leave home", "Lower monthly costs"] }, BUY_FIRST],
  remote_seller: [{ key: "occupancy", label: "Is the home lived in right now?", options: ["Vacant", "Rented to a tenant", "I live there part of the year"] }, { key: "on_site_help", label: "What help do you need on site?", options: ["Repairs and prep", "Cleaning and staging", "Showings and access", "All of it"] }],
  foreclosure: [{ key: "most_helpful", label: "What would help most right now?", options: ["Understanding my options", "Selling before a deadline", "A confidential conversation"] }, { key: "deadline", label: "Is there a date you are working against?", options: ["Yes", "No", "Not sure"] }],
  other: [],
})

/** The side-only fallbacks (an `other` persona, or a persona the business adds before its own set exists). */
export const SITUATION_SIDE_QUESTIONS: Readonly<Record<SituationSide, readonly SituationQuestion[]>> = Object.freeze({
  buyer: [FINANCING, { key: "home_priority", label: "What matters most in your next home?", options: ["Location", "Space", "Monthly cost", "Condition / move-in ready"] }],
  seller: [SELL_SUCCESS, CONDITION],
  both: [BUY_FIRST, FINANCING],
})

/**
 * PURE. The situation questions for a persona (canonicalised) and side, as form fields. Never empty for a known side: an
 * `other` persona gets its side's set (so no form falls back to an open question).
 * Module-private: the C30 proof screens the bank itself (SITUATION_QUESTIONS / SITUATION_SIDE_QUESTIONS) and the forms it builds.
 */
function situationQuestionsFor(persona: string | null | undefined, side: SituationSide | null | undefined): Array<LeadMagnetField & { purpose: "situation" }> {
  const s = canonicalSituation(persona)
  const own = SITUATION_QUESTIONS[s]
  const effectiveSide = side ?? SITUATION_SIDE[s] ?? "both"
  const set = own.length ? own : SITUATION_SIDE_QUESTIONS[effectiveSide]
  return set.map((q) => ({ name: q.key, label: q.label, type: "select", required: false, options: [...q.options], purpose: "situation" as const }))
}

/**
 * A GENERIC open question (ruling 16): "any other questions?", "what can we help with?", "tell us more", "anything else",
 * "your one question". A form never asks one — the situation questions above do that job. Used by the funnel to refuse a
 * planner's extra question of this shape.
 */
export const GENERIC_OPEN_QUESTION = /\b(any (other )?questions?|other questions?|questions? (for us|you have|do you have)|what (can|could) (we|i) help|how can (we|i) help|tell us (more|about yourself)|anything else|comments?\b|one question|what('s| is) on your mind|message\b)/i

/** At most this many situation + qualifier questions beside identity (market-landing: every field costs conversion). */
const MAX_SITUATION_FIELDS = 6

/** A question the form may never ask: protected characteristics or their proxies (fair housing applies to the form too). */
/** @proofSeam exported (wave 149) so the C30 proof runs the screen over every situation question. */
export const PROTECTED_QUESTION = /\b(age|how old|born|birth|retire(e|d)|married|marital|divorc|spouse|partner'?s|children|kids|family size|pregnan|expecting|relig|church|mosque|temple|synagogue|race|ethnic|nationality|national origin|citizen|immigra|disab|wheelchair|handicap|gender|sex\b|orientation|section 8|voucher|veteran)\b/i

// ── C15 / OWNER (the form contract) ──────────────────────────────────────────

/** The consent spec the form declares — rendered and captured by contract C15 (lane 148B), never authored here. */
export interface FunnelConsentSpec {
  contract: "C15"
  purposes: { service_delivery: { required: true; covers: string }; marketing: { required: false } }
  channels: Array<"email" | "sms" | "voice" | "direct_mail">
  wording: "rendered_by_c15"
  creator_user_id: string
  owner_agent_id: string
}

export interface FunnelOwner { agent_id: string; agent_user_id: string | null; creator_user_id: string; assignment: string }

// ── THE BRIEF ────────────────────────────────────────────────────────────────

export interface MagnetFunnelBrief {
  /** The VERIFIED tenant (session) — never a request body (§4). */
  brokerageId: string
  /** agents.id of the owner (lead_capture_forms.agent_id) — the person is assigned back to them. */
  agentId: string
  /** users.id of the creator (ledger actor, approval, C15 creator_user_id). agents.id and users.id are DISJOINT (§3). */
  createdBy: string
  audience: string
  benefit: string
  outcome: string
  area?: string | null
  territory?: { zip?: string | null; city?: string | null; state?: string | null } | null
  /** Kinds the creator would like to see (hints — the planner still decides, and honesty still rules). */
  preferredDeliverables?: FunnelDeliverableKind[] | null
  /** A live session the creator has ALREADY scheduled (a webinar is only promised against one). */
  schedule?: { webinar_at?: string | null; webinar_join_url?: string | null } | null
  /** An existing education sequence (campaign_sequences.id) for the mini-course / education step. */
  sequenceId?: string | null
  /** The public origin (the configured app URL); absent → the landing path is returned relative and said. */
  baseUrl?: string | null
  actor?: { platformRole?: string | null; userType?: string | null } | null
  /** Wave 149 (C30): the person's SITUATION persona (any persona — every one is allowed; canonicalised by canonicalSituation below). */
  persona?: string | null
  /** Wave 149 (C30): the side the magnet speaks to (contact intent vocabulary: buyer | seller | both). */
  side?: "buyer" | "seller" | "both" | null
  /** Wave 149 (C30, owner ruling 9): THE MAGNET, decided FIRST — the topic (from the topic bank, a frequently asked question or
   *  a content gap) that attracts this persona, with its evidence. lib/lead-magnets/lead-magnet-package.ts chooses it. */
  magnet?: { topic: string; source: string; valueProposition: string; question?: string | null; evidence?: Record<string, unknown> } | null
}

// ── THE PLANNER (expert creative prompt + typed contract) ─────────────────────

const PlanDeliverable = z.object({
  key: z.string().describe("a short snake_case id unique in this plan"),
  kind: z.enum([...FUNNEL_PRIMARY_KINDS, ...SECONDARY_KINDS] as [string, ...string[]]),
  role: z.enum(["primary", "deliverable"]),
  title: z.string().describe("the specific, benefit-first name of this deliverable"),
  promise_line: z.string().describe("one honest line for the landing page: what the person gets — no figure you were not given"),
  outline: z.array(z.string()).max(8).describe("for a checklist / video: the points it covers, in order"),
  why: z.string().describe("one sentence: why this deliverable moves THIS audience toward the outcome"),
})

export const MagnetFunnelPlanSchema = z.object({
  insufficient: z.boolean().describe("true only when the brief cannot support an honest funnel"),
  insufficient_reason: z.string().nullable(),
  name: z.string().describe("page title ≤ 60 chars"),
  magnet_type: z.enum(["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]),
  big_promise: z.string().describe("the one outcome the whole funnel delivers, in the audience's words"),
  angle: z.string().describe("the hook: the specific tension or curiosity this audience already feels"),
  awareness_stage: z.enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"]),
  landing: z.object({
    headline: z.string(), subhead: z.string(), cta: z.string().describe("action verb + specific outcome, ≤ 5 words"),
    description: z.string(), faq: z.array(z.object({ question: z.string(), answer: z.string() })).max(5),
  }),
  situation_keys: z.array(z.enum(SITUATION_KEYS as unknown as [string, ...string[]])).max(6),
  extra_questions: z.array(z.object({ label: z.string(), type: z.enum(["text", "select", "number", "textarea"]), options: z.array(z.string()).max(8) })).max(2),
  deliverables: z.array(PlanDeliverable).min(1).max(5),
  thank_you: z.object({ headline: z.string(), message: z.string(), next_step_line: z.string() }),
  steps: z.object({ personal_video: z.boolean(), calendar_link: z.boolean(), portal_task: z.object({ title: z.string(), summary: z.string() }).nullable(), education_sequence: z.boolean() }),
  follow_up: z.object({ first_value_moment: z.string(), signals_to_watch: z.array(z.string()).max(6), handoff_when: z.string() }),
  learning: z.object({ hypothesis: z.string(), primary_metric: z.enum(["visit_to_submit", "submit_to_conversation", "submit_to_appointment", "sequence_completion"]) }),
})
export type MagnetFunnelPlanDraft = z.infer<typeof MagnetFunnelPlanSchema>

/** The routed feature (lib/ai/models.ts AI_TASK_ROUTING — the literal sits at the call site for test:ai-routing-coverage). */
const FUNNEL_PLAN_EST_TOKENS = 3200

export const MAGNET_FUNNEL_PLANNER_SYSTEM = `ROLE
You are the brilliant, creative direct-response marketer behind a market-leading real-estate business — the strategist who
designs lead-magnet FUNNELS that a busy agent's ideal client actually wants, and that make the agent look like the most
helpful expert in town. You think like a great copywriter and a great teacher at once. You work inside one command-center OS
with an expert in every area: compliance, video, documents, calendars and the AI ISA all carry out what you design.

MANDATE
Design ONE complete package IN THIS ORDER (owner ruling 9): FIRST the lead magnet itself — built on the MAGNET block's topic
(a topic from the tenant's topic bank, a question people are asking a lot, or a content gap) because it attracts this
persona: its concept, its value proposition and the primary asset or experience; THEN the landing page inside the tenant's
own website with a form that asks the questions belonging to this person's SITUATION; THEN the funnel around it. From the
creator's brief (audience, benefit, outcome): the landing page, the form (identity + the situation facts that let the agent
truly help this person), the deliverables — of ANY kind:
a designed checklist, a short education video, a market report, a mini-course, a calculator, a live session, a consultation —
the thank-you moment, the optional steps (a personal video, a calendar offer, a portal task, an education sequence), the
follow-up intent and the learning hypothesis. Not a book: books are a separate publishing capability.

BUSINESS CONTEXT
The brokerage subscribes to an AI team that is "by the agent's side". The AI is the first line of defense and how it answers
is a reflection on that agent's business: kind, neighbourly, specific, never pushy. A lead magnet earns a person's contact
details by giving them a quick, real win toward their outcome — then hands them to the agent warmly.

THE PERSON YOU SERVE
The audience named in the brief, at their awareness stage. Speak to their situation and their outcome, never to a group they
belong to. Assume they are smart, busy and a little sceptical.

THE FACTS YOU MAY RELY ON — and nothing else
The brief, the brand, the area, and the AVAILABILITY block: whether the agent has a calendar connected, whether a live session
is already scheduled (date + join link), which education sequences exist (with their lesson counts), whether verified market
data exists for the territory. Propose a webinar ONLY if a session is scheduled; a mini-course ONLY if a sequence with lessons
exists; a market report ONLY if market data exists. Never invent a statistic, price, percentage, date, testimonial, award,
ranking, guarantee, neighbourhood claim or a deliverable the OS cannot make. A promise line names what the person gets — no
number you were not given.

CREATIVE BRIEF
- One big promise, in the audience's own words; one sharp angle (the tension they already feel). Specific beats clever.
- Value ladder: the PRIMARY deliverable is the quick win (consumable in under 10 minutes — a checklist, a short video, a
  focused guide or report); secondary deliverables deepen trust (a mini-course, a calculator, a session, a consultation).
- Match the awareness stage: unaware → a story and a question; most-aware → a clear offer and a button.
- The thank-you page is the second conversion: confirm the win, say WHAT arrives (the primary now; anything else when the agent
  and the AI ISA judge it helpful), and offer ONE natural next step (often the consultation or the calendar offer) — never a
  hard sell. NO TIMETABLE (owner ruling 7): never "day 3 you'll get…", "every week", "in 7 days", a drip calendar or a
  numbered schedule — follow-up timing, channel and content are decided per person by the AI ISA's arbiter, never by the page.
- Form friction is a cost: identity plus at most the situation facts that change how the agent helps (timeline bucket, and
  the side only if the persona does not already say it). The OS adds the situation's own qualifying questions — never an
  open "any questions?" / "tell us more" box (owner ruling 16); an extra question is a short choice that belongs to THIS
  situation. Every extra question must earn its place.
- Name the principle you use (reciprocity, specificity, commitment) in "why", so the agent can defend the choice.
- No dark patterns: no fake scarcity, no countdowns, no invented social proof.
- Inventive and human, in the tenant's own voice and tagline (owner ruling R10): never a stock real-estate campaign line
  ("dream home", "won't last", "priced to sell", "thinking of selling?", "what's your home worth", "call me today",
  "buyers are waiting") — every competitor already mails those. Say the specific thing about THIS situation instead. The
  final phase refuses stock lines and shows each one to a person; legal and consent text is the OS's and goes out verbatim.

THE DECISION YOU OWN
The package: 1 primary deliverable (kind: guide, report, valuation, checklist or video) + up to 4 secondary deliverables, the
landing copy, the situation questions (chosen from the allowed keys), at most 2 extra qualifying questions, the thank-you, the
optional steps, the follow-up intent (what the first value moment is, which signals to watch, when a person should take over)
and the learning hypothesis with its primary metric.

OUTPUT CONTRACT
Typed JSON matching the schema you were given. Exactly one deliverable has role "primary". Keys are unique snake_case.

COMPLIANCE BOUNDARY
Fair housing applies to everything public (the page, the form, the promise lines, the thank-you): never reference or imply race,
colour, religion, national origin, sex, familial status, disability (or any state-protected class); no school-quality claims, no
"safe neighbourhood", no "perfect for families / retirees / young professionals", no steering, no "exclusive community".
Never ask about age, marital or family status, children, religion, origin, disability, gender or income source on the form.
Consent wording is NOT yours: the OS renders the one consent component (purposes + channels) on every form.

ESCALATION RULE
If the brief cannot support an honest funnel (no real benefit, a discriminatory audience, a promise no deliverable can keep),
set insufficient = true with the reason in one sentence — a person reviews it. Never pad a funnel with deliverables the
availability block does not support.`

interface FunnelContext {
  brandName: string
  brokerageSlug: string | null
  agentUserId: string | null
  agentFirstName: string | null
  calendarConnected: boolean
  sequences: Array<{ id: string; name: string; lessons: number }>
  webinar: { at: string; joinUrl: string } | null
  marketDataForTerritory: boolean
  notes: string[]
  /** WAVE 151 (151I): the sender's rendered voice brief (THE brand-voice reader) — null when unreadable (said in notes). */
  voiceBrief: string | null
}

function buildMagnetFunnelPlannerPrompt(brief: MagnetFunnelBrief, ctx: FunnelContext): string {
  return [
    // WAVE 151 (lane 151I): the SENDER's versioned voice brief leads — the page, promise lines and thank-you are written in
    // the agent's words and tagline from the first draft (the final phase then checks; it does not voice afterwards).
    ...(ctx.voiceBrief ? [ctx.voiceBrief, ""] : []),
    `BRAND: ${ctx.brandName}`,
    `AGENT: ${ctx.agentFirstName ?? "the agent"}`,
    `AREA: ${brief.area ?? brief.territory?.city ?? "the brokerage's market"}`,
    "",
    ...(brief.magnet ? [
      "MAGNET (decided first — build the package on THIS):",
      `- Topic: ${brief.magnet.topic}`,
      `- Where it came from: ${brief.magnet.source}`,
      ...(brief.magnet.question ? [`- The question people keep asking: ${brief.magnet.question}`] : []),
      `- Value proposition: ${brief.magnet.valueProposition}`,
      "",
    ] : []),
    ...(brief.persona ? [`PERSONA (the person's situation): ${brief.persona}${brief.side ? ` · side: ${brief.side}` : ""}`, ""] : []),
    "BRIEF:",
    `- Audience: ${brief.audience}`,
    `- Benefit they get: ${brief.benefit}`,
    `- Outcome they want: ${brief.outcome}`,
    ...(brief.preferredDeliverables?.length ? [`- The creator would like: ${brief.preferredDeliverables.join(", ")}`] : []),
    "",
    "AVAILABILITY (the only capabilities you may promise against):",
    `- Agent calendar connected: ${ctx.calendarConnected ? "yes" : "no"} · agent seat: ${ctx.agentUserId ? "yes" : "no"}`,
    `- Live session scheduled: ${ctx.webinar ? `yes — ${ctx.webinar.at}` : "no"}`,
    `- Education sequences: ${ctx.sequences.length ? ctx.sequences.map((s) => `${s.name} (${s.lessons} lessons)`).join("; ") : "none"}`,
    `- Verified market data for the territory: ${ctx.marketDataForTerritory ? "yes" : "no"}`,
    `- Allowed situation question keys: ${SITUATION_KEYS.join(", ")}`,
    "",
    "Design the funnel now, following the output contract.",
  ].join("\n")
}

// ── PURE: compose the plan (the model's answer validated and merged onto a deterministic, honest baseline) ─────────────────

interface PlannedItem {
  key: string
  role: FunnelItemRole
  kind: FunnelItemKind
  fulfilment: FunnelItemFulfilment
  title: string
  promiseLine: string
  outline: string[]
  why: string
}

interface ComposedFunnel {
  name: string
  magnetType: "home_valuation" | "buyer_guide" | "seller_guide" | "market_report" | "listing_alert" | "open_house" | "generic_form"
  bigPromise: string
  angle: string
  awarenessStage: string
  copy: { name: string; description: string; headline: string; subhead: string; cta: string; faq: Array<{ question: string; answer: string }> }
  fields: FunnelFormField[]
  items: PlannedItem[]
  thankYou: { headline: string; message: string; nextStepLine: string }
  portalTask: { title: string; summary: string } | null
  followUp: { firstValueMoment: string; signalsToWatch: string[]; handoffWhen: string }
  learning: { hypothesis: string; primaryMetric: string }
  fromAi: boolean
  /** What was dropped from the model's answer and why (said to the reviewer, never silent). */
  dropped: string[]
  insufficient: string | null
}

const line = (v: unknown, max = 220): string | null => {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim().slice(0, max)
  return s ? s : null
}
const fhHigh = (text: string) => detectFairHousingViolations(text).filter((h) => h.severity === "high").map((h) => h.phrase)
const INVENTED_FIGURE = /[$%]|\b\d{2,}\b/
/** A FIXED TIMETABLE in public copy (owner ruling 7 — "nothing fixed in communications"; C29): a day-numbered drip, a weekly
 *  cadence, a countdown. Obligations keep their own wording (an arrangement's "within one business day" is the promise a task
 *  enforces, written by assessArrangement — never by the model, never screened here). @proofSeam exported for the C30 proof. */
export const FIXED_SCHEDULE = /\b(day\s*\d+|days?\s+\d+\s*[-–]\s*\d+|every\s+(day|week|month|other\s+day|\d+\s+days?)|(in|within|after)\s+\d+\s*(days?|weeks?|hours?)|tomorrow|next\s+week|weekly|daily|\d+[- ]day\s+(course|series|challenge|plan|sequence)|drip)\b/i
const keyOf = (s: string, taken: Set<string>) => { let base = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item"; let k = base, i = 2; while (taken.has(k)) k = `${base}_${i++}`; taken.add(k); return k }

/** The deterministic primary per magnet type (the C11 producer that already exists for it). */
function baselinePrimaryKind(magnetType: ComposedFunnel["magnetType"], preferred: readonly string[]): FunnelPrimaryKind {
  const hinted = preferred.find((k) => (FUNNEL_PRIMARY_KINDS as readonly string[]).includes(k)) as FunnelPrimaryKind | undefined
  if (hinted) return hinted
  if (magnetType === "buyer_guide" || magnetType === "seller_guide") return "guide"
  if (magnetType === "market_report") return "report"
  if (magnetType === "home_valuation") return "valuation"
  return "checklist"
}

/** PURE — the deterministic magnet type for a brief (the ONE keyword router — lib/lead-magnets/ai-draft.ts classifyConceptMagnetType). */
type ConceptClassifier = (concept: string) => ComposedFunnel["magnetType"]

/**
 * PURE. The complete, honest plan: the model's answer validated against the availability facts and merged ONTO a deterministic
 * baseline, so a null / partial / refused answer still yields a complete funnel. @proofSeam asserted directly by the proof.
 */
function composeFunnelPlan(brief: MagnetFunnelBrief, ctx: FunnelContext, draft: MagnetFunnelPlanDraft | null, classify: ConceptClassifier): ComposedFunnel {
  const dropped: string[] = []
  const concept = `${brief.audience} — ${brief.benefit} — ${brief.outcome}`
  const d = draft && !draft.insufficient ? draft : null
  if (draft?.insufficient) dropped.push(`the planner escalated: ${draft.insufficient_reason ?? "insufficient brief"} — the deterministic baseline stands for review`)
  const magnetType: ComposedFunnel["magnetType"] = d?.magnet_type ?? classify(concept)
  const benefit = line(brief.benefit, 120) ?? "a clear next step"
  const outcome = line(brief.outcome, 140) ?? "your move"
  const audience = line(brief.audience, 120) ?? "you"

  // COPY — every public line fair-housing checked; a flagged line falls back to the baseline sentence (said).
  const pub = (v: unknown, fallback: string, max: number, label: string) => {
    const s = line(v, max)
    if (!s) return fallback
    const hit = fhHigh(s)
    if (hit.length) { dropped.push(`${label}: fair-housing finding (${hit.join(", ")}) — baseline line used`); return fallback }
    // Wave 149 (owner ruling 7 / C29): a public line never carries a fixed timetable — the arbiter decides timing per person.
    if (FIXED_SCHEDULE.test(s)) { dropped.push(`${label}: a fixed timetable ("${s.match(FIXED_SCHEDULE)?.[0]}") — timing is the arbiter's, baseline line used`); return fallback }
    return s
  }
  const copy = {
    name: pub(d?.name, `${benefit} — for ${audience}`.slice(0, 60), 60, "name"),
    headline: pub(d?.landing.headline, benefit, 90, "headline"),
    subhead: pub(d?.landing.subhead, `Built for ${audience}: everything you need to ${outcome.toLowerCase()}.`, 220, "subhead"),
    description: pub(d?.landing.description, `A practical, local resource from ${ctx.brandName} for ${audience}.`, 300, "description"),
    cta: pub(d?.landing.cta, "Send it to me", 40, "cta"),
    faq: (d?.landing.faq ?? []).map((f) => ({ question: line(f.question, 140), answer: line(f.answer, 400) }))
      .filter((f): f is { question: string; answer: string } => !!f.question && !!f.answer && fhHigh(`${f.question} ${f.answer}`).length === 0).slice(0, 5),
  }

  // FORM — identity (the type's canonical fields, never removed) + situation (required set ∪ the planner's keys) + ≤ 2 extras.
  const fields: FunnelFormField[] = []
  const taken = new Set<string>()
  const add = (f: FunnelFormField) => { if (!taken.has(f.name)) { taken.add(f.name); fields.push(f) } }
  const identity: FunnelFormField[] = [
    { name: "first_name", label: "First Name", type: "text", required: true, purpose: "identity" },
    { name: "last_name", label: "Last Name", type: "text", required: true, purpose: "identity" },
    { name: "email", label: "Email", type: "email", required: true, purpose: "identity" },
    { name: "phone", label: "Phone", type: "tel", required: false, purpose: "identity" },
  ]
  identity.forEach(add)
  // Wave 149 (ruling 16): the side is asked only when the situation does not already say it.
  const situation = canonicalSituation(brief.persona)
  const knownSide = brief.side ?? SITUATION_SIDE[situation]
  const situationKeys = new Set<SituationKey>([...REQUIRED_SITUATION, ...((d?.situation_keys ?? []) as SituationKey[]).filter((k) => (SITUATION_KEYS as readonly string[]).includes(k))])
  if (!knownSide || knownSide === "both") situationKeys.add("move_side")
  else situationKeys.delete("move_side")
  if (magnetType === "home_valuation") situationKeys.add("property_address")
  for (const k of SITUATION_KEYS) if (situationKeys.has(k)) add({ ...SITUATION_FIELDS[k], ...(k === "property_address" && magnetType === "home_valuation" ? { required: true } : {}) })
  // THE SITUATION'S OWN QUALIFYING QUESTIONS (ruling 16 — never a generic open question; every persona has a set).
  for (const q of situationQuestionsFor(brief.persona, knownSide ?? null)) {
    if (PROTECTED_QUESTION.test(q.label) || q.options?.some((o) => PROTECTED_QUESTION.test(o))) { dropped.push(`situation question "${q.label}" failed the protected-characteristic screen — not asked`); continue }
    add(q)
  }
  for (const q of (d?.extra_questions ?? []).slice(0, 2)) {
    const label = line(q.label, 80)
    if (!label) continue
    if (PROTECTED_QUESTION.test(label) || fhHigh(label).length) { dropped.push(`extra question "${label}" asks about a protected characteristic or its proxy — never on the form`); continue }
    if (q.type === "textarea" || GENERIC_OPEN_QUESTION.test(label)) { dropped.push(`extra question "${label}" is a generic open question — the situation's own questions ask what matters (ruling 16)`); continue }
    if (fields.filter((f) => f.purpose !== "identity").length >= MAX_SITUATION_FIELDS) { dropped.push(`extra question "${label}" — the form already asks ${MAX_SITUATION_FIELDS} situation questions (friction is a cost)`); continue }
    const options = q.type === "select" ? (q.options ?? []).map((o) => line(o, 60)).filter((o): o is string => !!o && !PROTECTED_QUESTION.test(o)).slice(0, 8) : undefined
    if (q.type === "select" && (!options || options.length < 2)) continue
    add({ name: keyOf(label, new Set(taken)), label, type: q.type, required: false, purpose: "qualifier", ...(options ? { options } : {}) })
  }

  // DELIVERABLES — exactly one primary (a C11-producible kind); secondaries from the allowed kinds; one per kind.
  const preferred = brief.preferredDeliverables ?? []
  const itemKeys = new Set<string>()
  const items: PlannedItem[] = []
  const planned = d?.deliverables ?? []
  let primaryDraft = planned.find((p) => p.role === "primary" && (FUNNEL_PRIMARY_KINDS as readonly string[]).includes(p.kind))
  let primaryKind: FunnelPrimaryKind = (primaryDraft?.kind as FunnelPrimaryKind | undefined) ?? baselinePrimaryKind(magnetType, preferred)
  // HONESTY: the primary must be one this tenant can actually produce now — else the designed checklist (always producible).
  const coerce = (why: string) => { dropped.push(`primary ${primaryKind} → checklist: ${why}`); primaryKind = "checklist"; primaryDraft = undefined }
  if (primaryKind === "guide" && magnetType !== "buyer_guide" && magnetType !== "seller_guide") coerce("the guide booklet is produced for a buyer or seller guide only")
  else if (primaryKind === "report" && !ctx.marketDataForTerritory) coerce("no verified market data for the territory — a report would be refused")
  else if ((primaryKind === "video" || primaryKind === "valuation") && !ctx.agentUserId) coerce("it needs an agent with a user seat")
  const primaryTitle = pub(primaryDraft?.title, primaryKind === "checklist" ? `The ${benefit} checklist` : primaryKind === "video" ? `${benefit}: a short video walkthrough` : primaryKind === "report" ? `${brief.territory?.zip ?? brief.area ?? "Local"} market report` : primaryKind === "valuation" ? "Your agent-prepared home value" : `The ${benefit} guide`, 90, "primary title")
  let primaryLine = pub(primaryDraft?.promise_line, primaryTitle, 160, "primary promise")
  if (INVENTED_FIGURE.test(primaryLine)) { dropped.push(`primary promise line carried a figure ("${primaryLine}") — the title stands`); primaryLine = primaryTitle }
  items.push({ key: keyOf(primaryDraft?.key ?? "primary", itemKeys), role: "primary", kind: primaryKind, fulfilment: fulfilmentForKind(primaryKind), title: primaryTitle, promiseLine: primaryLine, outline: (primaryDraft?.outline ?? []).map((o) => line(o, 160)).filter((o): o is string => !!o).slice(0, 8), why: line(primaryDraft?.why, 200) ?? "a quick, specific win first (reciprocity)" })
  if (planned.filter((p) => p.role === "primary").length > 1) dropped.push("more than one primary was proposed — the first producible one is the primary")
  const usedKinds = new Set<string>([primaryKind])
  const secondaries = planned.filter((p) => p.role !== "primary" || (p !== primaryDraft && !(FUNNEL_PRIMARY_KINDS as readonly string[]).includes(p.kind)))
  // baseline secondary: the consultation (the warm hand-off to the agent) when the agent has a seat
  if (!d && ctx.agentUserId) secondaries.push({ key: "consultation", kind: "consultation", role: "deliverable", title: `A no-pressure conversation with ${ctx.agentFirstName ?? "your agent"}`, promise_line: "", outline: [], why: "a natural next step for anyone who wants personal help (commitment)" })
  for (const p of secondaries.slice(0, 4)) {
    if (!(SECONDARY_KINDS as readonly string[]).includes(p.kind)) { dropped.push(`deliverable "${p.title}" (${p.kind}) is not a funnel deliverable kind`); continue }
    if (usedKinds.has(p.kind)) { dropped.push(`a second ${p.kind} ("${p.title}") — one per kind`); continue }
    usedKinds.add(p.kind)
    const kind = p.kind as FunnelDeliverableKind
    const title = pub(p.title, kind.replace(/_/g, " "), 90, `${kind} title`)
    let promise = pub(p.promise_line, title, 160, `${kind} promise`)
    if (INVENTED_FIGURE.test(promise)) { dropped.push(`promise line for "${title}" carried a figure — the title stands`); promise = title }
    items.push({ key: keyOf(p.key || kind, itemKeys), role: "deliverable", kind, fulfilment: fulfilmentForKind(kind), title, promiseLine: promise, outline: (p.outline ?? []).map((o) => line(o, 160)).filter((o): o is string => !!o).slice(0, 8), why: line(p.why, 200) ?? "" })
  }

  // OPTIONAL STEPS (no duplicate of a deliverable that already does the same job).
  const steps = d?.steps ?? { personal_video: !!ctx.agentUserId, calendar_link: false, portal_task: null, education_sequence: ctx.sequences.length > 0 }
  const step = (kind: FunnelStepKind, title: string) => items.push({ key: keyOf(kind, itemKeys), role: "step", kind, fulfilment: fulfilmentForKind(kind), title, promiseLine: "", outline: [], why: "" })
  if (steps.personal_video) step("personal_video", `A short personal video from ${ctx.agentFirstName ?? "your agent"}`)
  if (steps.calendar_link && !usedKinds.has("consultation")) step("calendar_link", `Times to talk with ${ctx.agentFirstName ?? "your agent"}`)
  const portalTask = steps.portal_task ? { title: pub(steps.portal_task.title, "Your next step", 120, "portal task"), summary: pub(steps.portal_task.summary, "Open your resources whenever you are ready.", 300, "portal task") } : { title: "Your next step", summary: `Your ${primaryTitle} and your next steps live here whenever you want them.` }
  step("portal_task", portalTask.title)
  if (steps.education_sequence && !usedKinds.has("mini_course")) step("education_sequence", "Short lessons, one at a time")

  const ty = d?.thank_you
  return {
    name: copy.name, magnetType, bigPromise: pub(d?.big_promise, benefit, 160, "big promise"), angle: line(d?.angle, 200) ?? outcome,
    awarenessStage: d?.awareness_stage ?? "problem_aware", copy, fields, items,
    thankYou: { headline: pub(ty?.headline, "It's on its way", 90, "thank-you headline"), message: pub(ty?.message, `Thank you — ${primaryTitle} is being sent to you now.`, 300, "thank-you message"), nextStepLine: pub(ty?.next_step_line, ctx.agentUserId ? `Want a hand? ${ctx.agentFirstName ?? "Your agent"} is happy to help.` : "Questions? Just reply to the email.", 200, "thank-you next step") },
    portalTask,
    followUp: { firstValueMoment: line(d?.follow_up.first_value_moment, 200) ?? `the moment ${primaryTitle} arrives`, signalsToWatch: (d?.follow_up.signals_to_watch ?? ["opened the deliverable", "answered the form's question", "replied"]).map((s) => line(s, 80)).filter((s): s is string => !!s).slice(0, 6), handoffWhen: line(d?.follow_up.handoff_when, 200) ?? "the person asks a question, books a time, or shows positive intent" },
    learning: { hypothesis: line(d?.learning.hypothesis, 240) ?? `${audience} convert on a quick, specific win before a conversation`, primaryMetric: d?.learning.primary_metric ?? "visit_to_submit" },
    fromAi: !!d, dropped, insufficient: draft?.insufficient ? (draft.insufficient_reason ?? "insufficient brief") : null,
  }
}

// ── PURE: arrangements (truthful, enforceable — or not promised) ─────────────

export interface Arrangement { mechanism: string; enforcement: string; due_within_hours?: number; event_at?: string; join_url?: string; sequence_id?: string; lessons?: number; owner_user_id?: string | null }
type ArrangementVerdict = { status: "arranged"; promiseLine: string; arrangement: Arrangement } | { status: "planned"; reason: string }

/** PURE. Can this kind be ARRANGED truthfully for this tenant right now? The promise line is the arrangement's own sentence. */
function assessArrangement(kind: FunnelItemKind, ctx: FunnelContext, now: Date): ArrangementVerdict {
  const who = ctx.agentFirstName ?? "Your agent"
  switch (kind) {
    case "consultation":
    case "calendar_link":
      if (!ctx.agentUserId) return { status: "planned", reason: "no agent with a user seat on this magnet — a conversation cannot be promised" }
      return ctx.calendarConnected
        ? { status: "arranged", promiseLine: `${who} will send you a few open times from their calendar within one business day`, arrangement: { mechanism: "calendar_offer", enforcement: "an agent task due in 24h (tasks) + the AI ISA's appointment finder on the agent's connected calendar", due_within_hours: 24, owner_user_id: ctx.agentUserId } }
        : { status: "arranged", promiseLine: `${who} will reach out within one business day to find a time that suits you`, arrangement: { mechanism: "agent_callback", enforcement: "an agent task due in 24h (tasks); overdue work reaches the arbiter", due_within_hours: 24, owner_user_id: ctx.agentUserId } }
    case "valuation":
      if (!ctx.agentUserId) return { status: "planned", reason: "an agent-prepared value needs an assigned agent with a user seat" }
      return { status: "arranged", promiseLine: `${who} prepares your home's value personally and sends it within one business day`, arrangement: { mechanism: "agent_prepared_value", enforcement: "the C4 promise awaiting_human (24h due) + an agent task; attestPromiseDelivered closes it with the document", due_within_hours: 24, owner_user_id: ctx.agentUserId } }
    case "calculator":
      return { status: "arranged", promiseLine: "A payment calculator waiting in your private client portal", arrangement: { mechanism: "portal_financial_tools", enforcement: "the portal's financial tools (app/portal/[contactId]/resources) + the portal invite the one door sends + a portal card at capture" } }
    case "webinar": {
      const at = ctx.webinar ? Date.parse(ctx.webinar.at) : NaN
      if (!ctx.webinar || !Number.isFinite(at)) return { status: "planned", reason: "no live session is scheduled — schedule it first (the event producer, lane 148H C22); a webinar is never promised without a date" }
      if (at < now.getTime() + 3_600_000) return { status: "planned", reason: `the scheduled session (${ctx.webinar.at}) is not in the future` }
      if (!/^https:\/\/\S+$/.test(ctx.webinar.joinUrl)) return { status: "planned", reason: "the session has no https join link" }
      const when = new Date(at).toUTCString().replace(/:\d\d GMT$/, " UTC")
      return { status: "arranged", promiseLine: `Your seat at the live session on ${when} — the join link is sent with your confirmation`, arrangement: { mechanism: "scheduled_session", enforcement: "the submission is the registration; the join link rides the C4 delivery; reminders + attendance are the event producer's (C22)", event_at: ctx.webinar.at, join_url: ctx.webinar.joinUrl } }
    }
    case "mini_course":
    case "education_sequence": {
      const seq = ctx.sequences.find((s) => s.lessons >= 3)
      if (!seq) return { status: "planned", reason: "no active education sequence with at least 3 lessons exists — the AI does not promise lessons nobody has written" }
      return { status: "arranged", promiseLine: `A ${seq.lessons}-lesson email course, one short lesson at a time`, arrangement: { mechanism: "sequence_enrollment", enforcement: "enrollContact into campaign_sequences (journey hold) at capture; the sequence engine sends, consent + suppression gated", sequence_id: seq.id, lessons: seq.lessons } }
    }
    case "portal_task":
      return { status: "arranged", promiseLine: "", arrangement: { mechanism: "portal_card", enforcement: "pushPortalValueCard (the contact's own feed) at capture" } }
    case "personal_video":
      if (!ctx.agentUserId) return { status: "planned", reason: "no agent to front a personal video" }
      return { status: "arranged", promiseLine: "", arrangement: { mechanism: "personal_reel_staged", enforcement: "a lead_intro reel commissioned for the person at capture, STAGED for the agent's approval before anything is sent (never auto-sent)", owner_user_id: ctx.agentUserId } }
    default:
      return { status: "planned", reason: `${kind} is produced as an asset, not arranged` }
  }
}

// ── FUNNEL ITEM ROWS ─────────────────────────────────────────────────────────

export interface FunnelItemRow {
  id: string; brokerage_id: string; form_id: string; item_key: string; role: FunnelItemRole; kind: FunnelItemKind; fulfilment: FunnelItemFulfilment
  status: FunnelItemStatus; promised: boolean; position: number; title: string | null; promise_line: string | null
  arrangement: Arrangement | Record<string, unknown>; asset_url: string | null; document_id: string | null; video_project_id: string | null; deliverable_id: string | null
  payload: Record<string, unknown>; validation: Record<string, unknown>; approver: Record<string, unknown>; approved_by: string | null; approved_at: string | null
  attempts: number; next_attempt_at: string | null; error: string | null; created_at: string | null; updated_at: string | null
}
const ITEM_COLUMNS = "id, brokerage_id, form_id, item_key, role, kind, fulfilment, status, promised, position, title, promise_line, arrangement, asset_url, document_id, video_project_id, deliverable_id, payload, validation, approver, approved_by, approved_at, attempts, next_attempt_at, error, created_at, updated_at"

/** The funnel's items (tenant-pinned, in order). A refused read is an error, never "no funnel". */
async function readFunnelItems(svc: Db, input: { brokerageId: string; formId: string }): Promise<{ items: FunnelItemRow[]; error: string | null }> {
  const { data, error } = await svc.from("lead_magnet_funnel_items").select(ITEM_COLUMNS).eq("brokerage_id", input.brokerageId).eq("form_id", input.formId).order("position", { ascending: true })
  if (error) return { items: [], error: `lead_magnet_funnel_items read refused: ${error.message ?? "unknown"}` }
  return { items: (data ?? []) as FunnelItemRow[], error: null }
}

const httpsUrl = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/\S+$/.test(u) ? u : null)

/**
 * PURE — THE C21 PUBLISH VERDICT: every PROMISED item is READY (validated; a system asset hosted over https) or ARRANGED (a
 * mechanism and its own truthful line). Anything else blocks, named. A staged / planned / failed item that is NOT promised never
 * blocks (it is recorded, not offered).
 */
function funnelPublishVerdict(items: Array<Pick<FunnelItemRow, "item_key" | "title" | "kind" | "role" | "status" | "promised" | "fulfilment" | "asset_url" | "validation" | "arrangement" | "promise_line" | "error">>): { ok: true; promised: number } | { ok: false; blockers: string[] } {
  const blockers: string[] = []
  let promised = 0
  if (!items.some((i) => i.role === "primary")) blockers.push("the funnel has no primary deliverable")
  for (const i of items) {
    if (!i.promised) continue
    promised++
    const name = `${i.title ?? i.item_key} (${i.kind})`
    if (i.status === "ready") {
      if ((i.validation as { ok?: unknown } | null)?.ok !== true) blockers.push(`${name}: marked ready without a validation`)
      else if (i.fulfilment === "asset" && !httpsUrl(i.asset_url)) blockers.push(`${name}: ready without a hosted asset`)
    } else if (i.status === "arranged") {
      if (!(i.arrangement as { mechanism?: unknown } | null)?.mechanism || !i.promise_line) blockers.push(`${name}: arranged without a mechanism and its own promise line`)
    } else blockers.push(`${name}: ${i.status}${i.error ? ` — ${i.error}` : ""}`)
  }
  return blockers.length ? { ok: false, blockers } : { ok: true, promised }
}

// ── PRODUCERS (one per kind — the C11 primary and the funnel's secondaries share them) ──────────────────────────────────────

export interface FunnelDeps {
  now?: Date
  client?: Db
  entitlement?: (ask: { brokerageId: string; estTokens: number; actor?: MagnetFunnelBrief["actor"] }) => Promise<{ allowed: boolean; reason: string; message?: string }>
  /** The routed planner (default generateObjectRouted, feature lead_magnet_draft). */
  plan?: (a: { brokerageId: string; userId: string; system: string; prompt: string }) => Promise<MagnetFunnelPlanDraft>
  writeChecklist?: (a: { brokerageId: string; userId: string | null; system: string; prompt: string }) => Promise<ChecklistDraft>
  writeVideoScript?: (a: { brokerageId: string; userId: string | null; system: string; prompt: string }) => Promise<VideoScriptDraft>
  finalize?: (a: { brokerageId: string; agentUserId: string | null; texts: string[] }) => Promise<{ ok: true; texts: string[] } | { ok: false; reason: string }>
  renderDocument?: (a: { brokerageId: string; agentUserId: string | null; spec: Record<string, unknown>; metadata: Record<string, unknown> }) => Promise<{ ok: boolean; pdfUrl: string | null; documentId: string | null; error: string | null }>
  commissionVideo?: (a: { brokerageId: string; agentUserId: string; title: string; script: string; discriminator: string; metadata: Record<string, unknown> }) => Promise<{ ok: boolean; status: string; videoProjectId?: string | null; reason?: string | null }>
  produceReport?: (svc: Db, a: { brokerageId: string; agentUserId: string | null; agentId: string | null; actorUserId: string | null; territory: MagnetFunnelBrief["territory"] }) => Promise<ProducedDeliverable>
  /** Seams handed to the C11 primary producer and to draftLeadMagnetFromConcept. */
  deliverable?: DeliverableDeps
  draftBrand?: () => Promise<import("@/lib/marketing/humanize-final").TenantBrandForFinal>
  /** Follow-through seams. */
  enroll?: (a: { brokerageId: string; sequenceId: string; contactId: string; enrolledBy: string | null }) => Promise<{ success: boolean; enrollmentId?: string; error?: string; alreadyEnrolled?: boolean }>
  pushPortal?: (a: { brokerageId: string; contactId: string; title: string; summary: string; updateType: string; metadata: Record<string, unknown> }, svc: Db) => Promise<{ pushed: boolean; id?: string; reason?: string }>
  commissionPersonalVideo?: (a: { brokerageId: string; agentUserId: string; contactId: string; title: string; discriminator: string }) => Promise<{ ok: boolean; status: string; videoProjectId?: string | null; reason?: string | null }>
}

export const ChecklistSchema = z.object({
  insufficient: z.boolean(), insufficient_reason: z.string().nullable(),
  title: z.string(), intro: z.string(),
  sections: z.array(z.object({ heading: z.string(), items: z.array(z.object({ text: z.string(), why: z.string() })).min(1).max(8) })).min(1).max(6),
  closing: z.string(),
})
export type ChecklistDraft = z.infer<typeof ChecklistSchema>

export const FUNNEL_CHECKLIST_SYSTEM = `ROLE
You are the brokerage's senior real-estate educator and a sharp information designer. You write the designed checklist a
person downloads from a lead magnet: the most useful one-page plan they have seen on the subject.

BUSINESS CONTEXT
The checklist is the quick win that earns trust for the agent named in the brand line. It must be specific, practical and
kind — something a person can act on tonight — and it must make the agent look like the expert by the side of the reader.

THE FACTS YOU MAY RELY ON
The brief (audience, benefit, outcome), the deliverable title and its outline, the brand and the area. General, widely
accepted real-estate process knowledge is allowed (inspections, pre-approval, disclosures, timelines in general terms).
Never state a price, rate, percentage, tax figure, statistic, deadline in days, legal rule or local regulation — where a rule
varies by state, say "confirm with your agent / attorney for your state".

THE DECISION YOU OWN
The checklist: a title, a two-sentence intro, 2–6 sections of 1–8 items each (every item an action starting with a verb, with a
one-line "why" in plain words), and a warm closing line that invites a question to the agent.

OUTPUT CONTRACT
Typed JSON matching the schema you were given.

COMPLIANCE BOUNDARY
Fair housing applies (this is public marketing copy): no reference to race, colour, religion, national origin, sex, familial
status, disability or any protected class; no school-quality claims, no "safe" or "family" neighbourhood language, no steering.
No legal, tax or lending advice — describe the step and point to the right professional.

ESCALATION RULE
If the brief cannot support an honest, useful checklist, set insufficient = true with the reason — a person reviews it.`

export const VideoScriptSchema = z.object({ insufficient: z.boolean(), insufficient_reason: z.string().nullable(), title: z.string(), script: z.string().describe("the spoken narration, 90–180 words"), on_screen: z.array(z.string()).max(6) })
export type VideoScriptDraft = z.infer<typeof VideoScriptSchema>

export const FUNNEL_VIDEO_SCRIPT_SYSTEM = `ROLE
You are the agent's video producer and scriptwriter — compliance-first. You write the short education video a person receives
from a lead magnet: 60–90 seconds, spoken by the agent (or their approved avatar), warm, specific and genuinely useful.

BUSINESS CONTEXT
The video is the agent's first impression. It teaches one thing well and ends with an easy, no-pressure invitation to talk.
It is staged for the agent's approval before anyone sees it.

THE FACTS YOU MAY RELY ON
The brief (audience, benefit, outcome), the video's title and outline, the agent's first name, the brand and the area.
Never state a price, rate, percentage, statistic, legal rule or local regulation; never promise an outcome.

THE DECISION YOU OWN
The narration (90–180 words, plain spoken English, no jargon), up to six on-screen text cards, and the title.

OUTPUT CONTRACT
Typed JSON matching the schema you were given.

COMPLIANCE BOUNDARY — WRITTEN IN, NOT SCANNED AFTER
Fair housing: never reference or imply race, colour, religion, national origin, sex, familial status, disability or any
protected class; no "safe neighbourhood", no school-quality claims, no "perfect for families / retirees", no steering. Name
the brokerage as required by advertising rules in the closing line.

ESCALATION RULE
If the brief cannot support an honest education video, set insufficient = true with the reason — a person reviews it.`

const defaultFinalize = (svc: Db): NonNullable<FunnelDeps["finalize"]> => async (a) => {
  const { finalizeForDistribution, resolveTenantBrandForFinal } = await import("@/lib/marketing/humanize-final")
  const brand = await resolveTenantBrandForFinal(svc as never, { brokerageId: a.brokerageId, agentUserId: a.agentUserId })
  const out: string[] = []
  for (const text of a.texts) {
    const f = await finalizeForDistribution({ assetKind: "lead_magnet", text, tenantBrand: brand.brand })
    const hard = [...f.fairHousing, ...f.brandVoice.prohibited.map((w) => `prohibited by the brand voice: "${w}"`)]
    if (hard.length) return { ok: false, reason: hard.join("; ") }
    out.push(f.tagline.applied === "appended" && f.tagline.text ? f.text.replace(f.tagline.text, "").trim() : f.text)
  }
  return { ok: true, texts: out }
}

export interface AssetBrief { brokerageId: string; agentUserId: string | null; agentId: string | null; actorUserId: string | null; title: string; outline: string[]; audience: string; benefit: string; outcome: string; area: string | null; brandName: string; agentFirstName: string | null; discriminator: string; territory?: MagnetFunnelBrief["territory"]; /** WAVE 151 (151I): the sender's rendered voice brief — the checklist / script writer's first block. */ voiceBrief?: string | null }

/** The designed checklist: written (expert prompt) → validated → fair housing → the final phase → a tenant-branded PDF. */
export async function produceChecklistDocument(svc: Db, a: AssetBrief, deps: FunnelDeps = {}): Promise<ProducedDeliverable> {
  try {
    const prompt = [...(a.voiceBrief ? [a.voiceBrief, ""] : []), `BRAND: ${a.brandName}`, `AREA: ${a.area ?? "the local market"}`, `AUDIENCE: ${a.audience}`, `BENEFIT: ${a.benefit}`, `OUTCOME: ${a.outcome}`, `TITLE: ${a.title}`, `OUTLINE: ${a.outline.length ? a.outline.join(" · ") : "(yours to design)"}`, "", "Write the checklist now."].join("\n")
    const write = deps.writeChecklist ?? (async (x) => (await (await import("@/lib/ai/models")).generateObjectRouted({ feature: "lead_magnet_draft", brokerageId: x.brokerageId, userId: x.userId ?? undefined, manager: "campaign_orchestrator", system: x.system, prompt: x.prompt, schema: ChecklistSchema, maxTokens: 1600, temperature: 0.5, contextExtra: { purpose: "lead_magnet_funnel_checklist" } })).object)
    const draft = await write({ brokerageId: a.brokerageId, userId: a.agentUserId, system: FUNNEL_CHECKLIST_SYSTEM, prompt })
    if (draft.insufficient) return { status: "failed", reason: `the checklist writer escalated: ${draft.insufficient_reason ?? "insufficient brief"} — a person reviews it` }
    const items = draft.sections.flatMap((s) => s.items)
    const all = [draft.title, draft.intro, ...draft.sections.flatMap((s) => [s.heading, ...s.items.flatMap((i) => [i.text, i.why])]), draft.closing].join("\n")
    const refusals: string[] = []
    if (items.length < 5) refusals.push(`only ${items.length} items — a checklist worth an email address has at least 5`)
    if (items.some((i) => /[$%]/.test(`${i.text} ${i.why}`))) refusals.push("an item states a figure ($ / %) the writer was not given")
    const fh = fhHigh(all)
    if (fh.length) refusals.push(`fair housing: ${fh.join(", ")}`)
    if (refusals.length) return { status: "failed", reason: `the checklist did not validate: ${refusals.join("; ")}`, validation: { ok: false, refusals } }
    const fin = await (deps.finalize ?? defaultFinalize(svc))({ brokerageId: a.brokerageId, agentUserId: a.agentUserId, texts: [draft.intro, draft.closing] })
      .catch((e: unknown) => ({ ok: false as const, reason: `the final phase could not run: ${e instanceof Error ? e.message : String(e)}` }))
    if (!fin.ok) return { status: "failed", reason: `held by the final phase — ${fin.reason}` }
    const [intro, closing] = fin.texts
    const spec = {
      title: draft.title || a.title, subtitle: a.benefit, preparedLine: `Prepared for ${a.audience}${a.agentFirstName ? ` by ${a.agentFirstName}` : ""} · ${a.brandName}`,
      brand: { brokerageName: a.brandName, showEhoMark: true },
      sections: [{ paragraphs: [intro] }, ...draft.sections.map((s) => ({ heading: s.heading, bullets: s.items.map((i) => `☐ ${i.text} — ${i.why}`) })), { heading: "Next step", paragraphs: [closing] }],
      disclaimer: "General information to help you plan — not legal, tax or lending advice. Requirements vary by state; confirm the details for your situation with your agent and the right professional. Equal Housing Opportunity.",
    }
    const render = deps.renderDocument ?? (async (x) => {
      const { produceClientDocument, resolvePdfBrand } = await import("@/lib/documents/client-document-producer")
      const brand = await resolvePdfBrand(svc, { brokerageId: x.brokerageId, agentUserId: x.agentUserId })
      return produceClientDocument(svc, { brokerageId: x.brokerageId, agentUserId: x.agentUserId, contactId: null, documentType: "checklist", spec: { ...(x.spec as object), brand: { ...brand, showEhoMark: true } } as never, metadata: x.metadata })
    })
    const r = await render({ brokerageId: a.brokerageId, agentUserId: a.agentUserId, spec, metadata: { source: "lead_magnet_funnel", discriminator: a.discriminator } })
    const url = httpsUrl(r.pdfUrl)
    if (!r.ok || !url) return { status: "failed", reason: r.error ?? "the checklist PDF was not hosted" }
    return {
      status: "ready", assetUrl: url, documentId: r.documentId, title: draft.title || a.title,
      coverNote: { subject: `Your ${draft.title || a.title}`, title: draft.title || a.title, body: `${intro}\n\nOpen it, tick through it at your own pace, and reply with any question — I'm happy to help.` },
      payload: { items: items.length, sections: draft.sections.length },
      validation: { ok: true, checks: ["≥5 actionable items", "no invented figure", "fair_housing_clear", "final_phase_cleared", "hosted_pdf"] },
    }
  } catch (e) {
    return { status: "failed", reason: `the checklist producer threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The video's readiness: STAGED until lib/video/video-staging.ts says an assigned approver approved it (consumed, not edited). */
async function videoReadiness(svc: Db, input: { brokerageId: string; videoProjectId: string }): Promise<{ ready: boolean; url: string | null; reason: string }> {
  const { data, error } = await svc.from("ai_video_projects").select("id, brokerage_id, agent_id, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, approved_by, status, compliance_status, video_url, video_provider, is_published, video_metadata").eq("id", input.videoProjectId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { ready: false, url: null, reason: `ai_video_projects read refused: ${error.message ?? "unknown"}` }
  if (!data) return { ready: false, url: null, reason: "the video project is not this brokerage's (or is gone)" }
  const { stagedPublicationVerdict } = await import("@/lib/video/video-staging")
  const v = stagedPublicationVerdict(data as never, "landing_page")
  if (!v.ok) return { ready: false, url: null, reason: `staged — ${v.reason}` }
  const url = httpsUrl((data as { video_url?: string | null }).video_url)
  return url ? { ready: true, url, reason: "approved by an assigned approver (video staging)" } : { ready: false, url: null, reason: "approved but not hosted over https" }
}

/** The education video: a compliance-first script → commissioned through THE director (pending_review) → staged for approval. */
export async function commissionFunnelVideo(svc: Db, a: AssetBrief, deps: FunnelDeps = {}): Promise<ProducedDeliverable> {
  try {
    if (!a.agentUserId) return { status: "failed", reason: "an education video needs the agent who presents it (a user seat)" }
    const prompt = [...(a.voiceBrief ? [a.voiceBrief, ""] : []), `BRAND: ${a.brandName}`, `AGENT: ${a.agentFirstName ?? "the agent"}`, `AREA: ${a.area ?? "the local market"}`, `AUDIENCE: ${a.audience}`, `BENEFIT: ${a.benefit}`, `OUTCOME: ${a.outcome}`, `TITLE: ${a.title}`, `OUTLINE: ${a.outline.length ? a.outline.join(" · ") : "(yours to design)"}`, "", "Write the script now."].join("\n")
    const write = deps.writeVideoScript ?? (async (x) => (await (await import("@/lib/ai/models")).generateObjectRouted({ feature: "video_script_generation", brokerageId: x.brokerageId, userId: x.userId ?? undefined, manager: "asset_manager", system: x.system, prompt: x.prompt, schema: VideoScriptSchema, maxTokens: 900, temperature: 0.6, contextExtra: { purpose: "lead_magnet_funnel_video" } })).object)
    const draft = await write({ brokerageId: a.brokerageId, userId: a.agentUserId, system: FUNNEL_VIDEO_SCRIPT_SYSTEM, prompt })
    if (draft.insufficient) return { status: "failed", reason: `the script writer escalated: ${draft.insufficient_reason ?? "insufficient brief"} — a person reviews it` }
    // CLAUDE.md §5: compliance-first in the prompt; a HARD fair-housing flag escalates to a human (warnings pass through).
    const fh = fhHigh(`${draft.title}\n${draft.script}\n${draft.on_screen.join("\n")}`)
    if (fh.length) return { status: "failed", reason: `fair housing held the script (${fh.join(", ")}) — a person rewrites it`, validation: { ok: false, refusals: fh } }
    const commission = deps.commissionVideo ?? (async (x) => {
      const { commissionVideo } = await import("@/lib/video/video-director")
      const r = await commissionVideo({ kind: "explainer", tier: "solo_agent", targetChannel: "youtube", facts: { topic: x.title } }, { brokerageId: x.brokerageId, agentUserId: x.agentUserId, title: x.title, spokenScript: x.script, idempotencyDiscriminator: x.discriminator, meterFeature: "lead_magnet_funnel_video", extraMetadata: x.metadata }, svc as never)
      return { ok: r.ok, status: r.status, videoProjectId: r.videoProjectId ?? null, reason: r.reason ?? null }
    })
    const c = await commission({ brokerageId: a.brokerageId, agentUserId: a.agentUserId, title: draft.title || a.title, script: draft.script, discriminator: a.discriminator, metadata: { lead_magnet_funnel: a.discriminator } })
    if (!c.ok || !c.videoProjectId) return { status: "failed", reason: `the video was not commissioned (${c.status}): ${c.reason ?? "no project"}` }
    const ready = await videoReadiness(svc, { brokerageId: a.brokerageId, videoProjectId: c.videoProjectId })
    const coverNote = { subject: `Your video: ${draft.title || a.title}`, title: draft.title || a.title, body: `I recorded a short video for you on exactly this. It takes about a minute — and if it sparks a question, just reply.` }
    if (!ready.ready) return { status: "staged", reason: ready.reason, title: draft.title || a.title, coverNote, payload: { video_project_id: c.videoProjectId, script_words: draft.script.split(/\s+/).length }, validation: { ok: false, staged: true } }
    return { status: "ready", assetUrl: ready.url, title: draft.title || a.title, coverNote, payload: { video_project_id: c.videoProjectId }, validation: { ok: true, checks: ["compliance_first_script", "staged_and_approved_by_assigned_approver", "hosted_video"] } }
  } catch (e) {
    return { status: "failed", reason: `the video producer threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** One asset of a kind (the funnel's secondaries). The C11 primary dispatches here too for checklist / video. */
async function produceFunnelAsset(svc: Db, kind: FunnelItemKind, a: AssetBrief, deps: FunnelDeps): Promise<ProducedDeliverable> {
  if (kind === "checklist") return produceChecklistDocument(svc, a, deps)
  if (kind === "video") return commissionFunnelVideo(svc, a, deps)
  if (kind === "report") {
    if (deps.produceReport) return deps.produceReport(svc, { brokerageId: a.brokerageId, agentUserId: a.agentUserId, agentId: a.agentId, actorUserId: a.actorUserId, territory: a.territory ?? null })
    const { produceMarketReport } = await import("@/lib/market-reports/producer")
    const r = await produceMarketReport(svc, { brokerageId: a.brokerageId, agentUserId: a.agentUserId, agentId: a.agentId, actor: a.actorUserId ? { type: "user", userId: a.actorUserId } : { type: "manager", managerKey: "campaign_orchestrator" }, territoryHint: (a.territory ?? null) as never, purpose: "lead_magnet_funnel_deliverable" })
    if (!r.ok) return { status: "failed", reason: `the market report was not produced (${r.stage}): ${r.reason}` }
    return { status: "ready", assetUrl: r.assetUrl, documentId: r.documentId, title: `${r.report.territory.label} Market Report`, coverNote: { subject: `Your ${r.report.territory.label} market report`, title: `${r.report.territory.label} Market Report`, body: r.report.narrative.headline }, validation: { ok: true, counts: r.validation.counts } }
  }
  return { status: "failed", reason: `${kind} is not produced as an asset` }
}

// ── CONTEXT ──────────────────────────────────────────────────────────────────

async function readFunnelContext(svc: Db, brief: MagnetFunnelBrief): Promise<FunnelContext> {
  const notes: string[] = []
  const { data: b, error: bErr } = await svc.from("brokerages").select("id, name, slug").eq("id", brief.brokerageId).maybeSingle()
  if (bErr) notes.push(`brokerages read refused: ${bErr.message ?? "unknown"} — the landing path cannot be named`)
  const { data: ag, error: agErr } = await svc.from("agents").select("id, user_id").eq("id", brief.agentId).eq("brokerage_id", brief.brokerageId).maybeSingle()
  if (agErr) notes.push(`agents read refused: ${agErr.message ?? "unknown"} — nothing that needs the agent's seat is promised`)
  const agentUserId = agErr ? null : ((ag as { user_id?: string | null } | null)?.user_id ?? null)
  let agentFirstName: string | null = null
  if (agentUserId) {
    // agents carries no name — it lives on users (agents.id and users.id are DISJOINT; crossed via agents.user_id, §3)
    const { data: u, error: uErr } = await svc.from("users").select("id, first_name").eq("id", agentUserId).maybeSingle()
    if (uErr) notes.push(`users read refused: ${uErr.message ?? "unknown"} — the agent is named generically`)
    agentFirstName = (u as { first_name?: string | null } | null)?.first_name ?? null
  }
  // WAVE 151 (lane 151I): the SENDER's versioned voice brief (THE brand-voice reader) — compiled once per funnel, handed to the
  // planner, the checklist writer and the script writer BEFORE their first draft. Unavailable = said in notes, never guessed.
  let voiceBrief: string | null = null
  try {
    const { loadSenderVoiceBrief, renderSenderVoiceBrief } = await import("@/lib/kernel/brand-voice")
    voiceBrief = renderSenderVoiceBrief(await loadSenderVoiceBrief(svc as never, { brokerageId: brief.brokerageId, agentId: brief.agentId, agentUserId }))
  } catch (e) {
    notes.push(`sender-voice brief unavailable: ${(e as Error)?.message ?? String(e)} — the planner writes without the sender's voice`)
  }
  let calendarConnected = false
  if (agentUserId) {
    const { data: cal, error: calErr } = await svc.from("calendar_provider_accounts").select("id").eq("user_id", agentUserId).eq("brokerage_id", brief.brokerageId).eq("is_active", true).limit(1)
    if (calErr) notes.push(`calendar_provider_accounts read refused: ${calErr.message ?? "unknown"} — the calendar is treated as NOT connected`)
    calendarConnected = !calErr && (cal ?? []).length > 0
  }
  const sequences: FunnelContext["sequences"] = []
  {
    let q = svc.from("campaign_sequences").select("id, name, is_active").eq("brokerage_id", brief.brokerageId).eq("is_active", true)
    if (brief.sequenceId) q = q.eq("id", brief.sequenceId)
    const { data: seqs, error: sErr } = await q.limit(20)
    if (sErr) notes.push(`campaign_sequences read refused: ${sErr.message ?? "unknown"} — no education sequence is promised`)
    for (const s of (seqs ?? []) as Array<{ id: string; name: string | null }>) {
      // campaign_sequence_steps carries no brokerage_id — the sequence itself was read tenant-pinned above
      const { data: steps, error: stErr } = await svc.from("campaign_sequence_steps").select("id").eq("sequence_id", s.id)
      if (stErr) { notes.push(`campaign_sequence_steps read refused for ${s.id}: ${stErr.message ?? "unknown"}`); continue }
      sequences.push({ id: s.id, name: s.name ?? "Education sequence", lessons: (steps ?? []).length })
    }
  }
  let marketDataForTerritory = false
  if (brief.territory?.zip || brief.territory?.city) {
    let mq = svc.from("market_data").select("id").eq("brokerage_id", brief.brokerageId)
    mq = brief.territory?.zip ? mq.eq("zip_code", brief.territory.zip) : mq.eq("city", brief.territory!.city!)
    const { data: md, error: mdErr } = await mq.limit(1)
    if (mdErr) notes.push(`market_data read refused: ${mdErr.message ?? "unknown"} — no market report is promised`)
    marketDataForTerritory = !mdErr && (md ?? []).length > 0
  }
  const at = brief.schedule?.webinar_at ?? null, join = brief.schedule?.webinar_join_url ?? null
  const brokerage = b as { name?: string | null; slug?: string | null } | null
  return {
    brandName: brokerage?.name ?? "the brokerage", brokerageSlug: brokerage?.slug ?? null,
    agentUserId, agentFirstName,
    calendarConnected, sequences, webinar: at && join ? { at, joinUrl: join } : null, marketDataForTerritory, notes,
    voiceBrief,
  }
}

// ── THE PACKAGE (C21) ────────────────────────────────────────────────────────

export interface FunnelPackageItem { key: string; role: FunnelItemRole; kind: FunnelItemKind; fulfilment: FunnelItemFulfilment; status: FunnelItemStatus; promised: boolean; title: string; promiseLine: string | null; reason: string | null; arrangement: Arrangement | null; assetUrl: string | null }

export interface MagnetFunnelPackage {
  funnel_id: string
  landing_page: { form_id: string; slug: string; path: string | null; url: string | null; state: "draft"; headline: string; subhead: string; cta: string; bullets: string[] }
  form: { fields: FunnelFormField[]; consent: FunnelConsentSpec; owner: FunnelOwner }
  deliverables: FunnelPackageItem[]
  thank_you: { headline: string; message: string; next_step_line: string; what_arrives: string[] }
  personal_video: FunnelPackageItem | null
  calendar_link: FunnelPackageItem | null
  portal_task: FunnelPackageItem | null
  education_sequence: FunnelPackageItem | null
  follow_up_policy: Record<string, unknown>
  attribution: Record<string, unknown>
  learning: Record<string, unknown>
  publishable: { ok: true; promised: number } | { ok: false; blockers: string[] }
  from_ai: boolean
  notes: string[]
  /** Wave 149 (C30, ruling 9): the stages in the order they completed — magnet → landing_page → funnel. */
  order: FunnelStageStamp[]
}

export type MagnetFunnelResult = { ok: true; package: MagnetFunnelPackage } | { ok: false; stage: "input" | "entitlement" | "plan" | "landing_page" | "items" | "ledger"; error: string; notes?: string[] }

/** THE PACKAGE ORDER (owner ruling 9, contract C30) — one spelling; lib/lead-magnets/lead-magnet-package.ts and the proof read it. */
export const FUNNEL_PACKAGE_ORDER = ["magnet", "landing_page", "funnel"] as const
export type FunnelStage = (typeof FUNNEL_PACKAGE_ORDER)[number]
export interface FunnelStageStamp { stage: FunnelStage; seq: number; at: string; detail: Record<string, unknown> }

interface SettledItem extends PlannedItem { status: FunnelItemStatus; promised: boolean; arrangement: Arrangement | null; produced: ProducedDeliverable | null; reason: string | null }

/** The primary as the C11 deliverable sees it (settings.funnel.primary — read by deliverableSpecFor). */
export interface FunnelPrimarySpec { key: string; kind: FunnelPrimaryKind; fulfilment: "asset" | "human"; title: string; outline: string[]; brief: { audience: string; benefit: string; outcome: string; area: string | null; territory: MagnetFunnelBrief["territory"] }; funnel_id: string }

/** PURE — the funnel primary a form's settings declare (null when the form is not a funnel). */
export function funnelPrimaryOf(settings: Record<string, unknown> | null | undefined): FunnelPrimarySpec | null {
  const p = ((settings ?? {}) as { funnel?: { primary?: unknown } }).funnel?.primary as FunnelPrimarySpec | undefined
  return p && typeof p === "object" && (FUNNEL_PRIMARY_KINDS as readonly string[]).includes(p.kind) ? p : null
}

const isoUtc = (d: Date) => d.toISOString()

/**
 * C21 — brief → the complete funnel package. Entitlement first (nothing written on a refusal); the expert planner (or the
 * deterministic baseline); the secondaries produced / arranged BEFORE the page is written, so the page promises only what is
 * ready or arranged; the landing page + form + PRIMARY asset created as one unit through the AI-draft survivor (C11 inside);
 * the funnel's items recorded under the action ledger (a magnet never exists without them — compensating delete, counted).
 * The page is a DRAFT: publishLeadMagnet is the human approval (C5) and runs the C21 publish gate. Never throws.
 */
export async function createMagnetFunnel(brief: MagnetFunnelBrief, deps: FunnelDeps = {}): Promise<MagnetFunnelResult> {
  const notes: string[] = []
  try {
    if (!brief.brokerageId || !brief.agentId || !brief.createdBy) return { ok: false, stage: "input", error: "Missing required fields: brokerageId, agentId, createdBy" }
    for (const [k, v] of [["audience", brief.audience], ["benefit", brief.benefit], ["outcome", brief.outcome]] as const) {
      if (!line(v, 400) || String(v).trim().length < 3) return { ok: false, stage: "input", error: `Describe the ${k} first — the funnel is built from audience, benefit and outcome.` }
    }
    const brokerageId = brief.brokerageId
    const svc: Db = deps.client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as Db)
    const now = deps.now ?? new Date()

    // 1 · ENTITLEMENT (the ONE access + budget rule) — refused → nothing written.
    const gate = deps.entitlement ?? (async (ask) => {
      const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
      const d = await mayUseAndAfford({ brokerageId: ask.brokerageId, capability: "ai.generate", estTokens: ask.estTokens, actor: ask.actor ?? null })
      return { allowed: d.allowed, reason: d.reason, message: d.message }
    })
    const verdict = await gate({ brokerageId, estTokens: FUNNEL_PLAN_EST_TOKENS, actor: brief.actor ?? null }).catch((e: unknown) => ({ allowed: false, reason: `entitlement_threw: ${e instanceof Error ? e.message : String(e)}` }) as { allowed: boolean; reason: string; message?: string })
    if (!verdict.allowed) return { ok: false, stage: "entitlement", error: verdict.message ?? `AI funnel building is not available right now (${verdict.reason}).` }

    // 2 · CONTEXT — the facts the planner may promise against.
    const ctx = await readFunnelContext(svc, brief)
    notes.push(...ctx.notes)

    // 3 · THE PLAN — the expert creative planner (routed), validated onto the honest baseline.
    const plan = deps.plan ?? (async (a) => (await (await import("@/lib/ai/models")).generateObjectRouted({
      feature: "lead_magnet_draft", brokerageId: a.brokerageId, userId: a.userId, manager: "campaign_orchestrator",
      system: a.system, prompt: a.prompt, schema: MagnetFunnelPlanSchema, maxTokens: 2400, temperature: 0.8,
      contextExtra: { purpose: "lead_magnet_funnel_plan" },
    })).object)
    let draft: MagnetFunnelPlanDraft | null = null
    try { draft = await plan({ brokerageId, userId: brief.createdBy, system: MAGNET_FUNNEL_PLANNER_SYSTEM, prompt: buildMagnetFunnelPlannerPrompt(brief, ctx) }) }
    catch (e) { notes.push(`the funnel planner was unavailable (${e instanceof Error ? e.message : String(e)}) — the deterministic baseline stands`) }
    const { classifyConceptMagnetType } = await import("./ai-draft")
    const composed = composeFunnelPlan(brief, ctx, draft, classifyConceptMagnetType)
    notes.push(...composed.dropped)
    const funnelId = globalThis.crypto.randomUUID() // Web Crypto (Node ≥ 19, edge) — no node:crypto import in a module the kernel graph reaches
    const assetBrief = (it: PlannedItem): AssetBrief => ({ brokerageId, agentUserId: ctx.agentUserId, agentId: brief.agentId, actorUserId: brief.createdBy, title: it.title, outline: it.outline, audience: brief.audience, benefit: brief.benefit, outcome: brief.outcome, area: brief.area ?? null, brandName: ctx.brandName, agentFirstName: ctx.agentFirstName, discriminator: `funnel:${funnelId}:${it.key}`, territory: brief.territory ?? null, voiceBrief: ctx.voiceBrief })

    // THE ORDER (owner ruling 9, C30): 1 the MAGNET → 2 the LANDING PAGE + situation form → 3 the FUNNEL. Each stage is stamped
    // as it completes (package.order) and the stamps are recorded on the ledger row, so the order is evidence, not a comment.
    const order: FunnelStageStamp[] = []
    const stamp = (stage: FunnelStage, detail: Record<string, unknown>) => order.push({ stage, seq: order.length + 1, at: new Date().toISOString(), detail })
    const primaryPlan = composed.items.find((i) => i.role === "primary")!
    const primarySpec: FunnelPrimarySpec = { key: primaryPlan.key, kind: primaryPlan.kind as FunnelPrimaryKind, fulfilment: primaryPlan.fulfilment === "human" ? "human" : "asset", title: primaryPlan.title, outline: primaryPlan.outline, brief: { audience: brief.audience, benefit: brief.benefit, outcome: brief.outcome, area: brief.area ?? null, territory: brief.territory ?? null }, funnel_id: funnelId }

    // STAGE 1 · THE MAGNET — its concept and value proposition are the plan's (built on brief.magnet's topic); its PRIMARY
    // asset is produced NOW, before any page exists, through C11's own producer dispatch (the same asset C11 would make).
    const { produceMagnetAssetFirst } = await import("./deliverable-asset")
    const first = await produceMagnetAssetFirst(svc, { brokerageId, magnetType: composed.magnetType, title: primaryPlan.title, agentId: brief.agentId, settings: { funnel: { id: funnelId, primary: primarySpec } }, actorUserId: brief.createdBy }, deps.deliverable ?? {})
    if (first && first.produced.status !== "ready") notes.push(`the magnet's ${first.kind} was produced first and is ${first.produced.status}${first.produced.reason ? ` — ${first.produced.reason}` : ""}; the page stays unpublishable until it is ready (C11)`)
    stamp("magnet", { topic: brief.magnet?.topic ?? composed.bigPromise, source: brief.magnet?.source ?? "brief", value_proposition: brief.magnet?.valueProposition ?? composed.bigPromise, persona: brief.persona ?? null, primary_kind: primaryPlan.kind, primary_status: first?.produced.status ?? (primaryPlan.fulfilment === "human" ? "human_fulfilment" : "none") })

    // The page's "what you get" lines: the magnet + the ARRANGEMENTS the plan commits to (assessArrangement is pure over facts
    // already read — nothing is produced for them). Secondary ASSETS are made in stage 3, after the page; a ready one is a
    // BONUS (never promised by a page written before it existed).
    const arrangedFor = new Map<string, ArrangementVerdict>()
    for (const it of composed.items) if (it.role !== "primary" && it.fulfilment !== "asset") arrangedFor.set(it.key, assessArrangement(it.kind, ctx, now))
    const promisesArrangement = (it: PlannedItem, a: ArrangementVerdict | undefined) => a?.status === "arranged" && !!a.promiseLine && (it.role === "deliverable" || it.kind === "calendar_link" || it.kind === "education_sequence")
    const truthfulBullets = [primaryPlan.promiseLine, ...composed.items.filter((it) => promisesArrangement(it, arrangedFor.get(it.key))).map((it) => (arrangedFor.get(it.key) as { promiseLine: string }).promiseLine)].slice(0, 5)

    // STAGE 2 · THE LANDING PAGE + the situation form — through the AI-draft survivor (createLeadMagnet; the C11 record of the
    // magnet produced in stage 1 is written WITH the form, one unit).
    const consent: FunnelConsentSpec = { contract: "C15", purposes: { service_delivery: { required: true, covers: `deliver ${primaryPlan.title} and what this page offers` }, marketing: { required: false } }, channels: ["email", "sms", "voice", "direct_mail"], wording: "rendered_by_c15", creator_user_id: brief.createdBy, owner_agent_id: brief.agentId }
    const owner: FunnelOwner = { agent_id: brief.agentId, agent_user_id: ctx.agentUserId, creator_user_id: brief.createdBy, assignment: "captureFormSubmission files a new contact to this form's agent and claims an unowned one; the agent's seat fronts the follow-up" }
    const followUpPolicy = {
      decided_by: "the AI ISA follow-up arbiter (lib/ai-isa/followup-arbiter.ts) — reasoning over signals, never a fixed timetable", fixed_schedule: false,
      first_value_moment: composed.followUp.firstValueMoment, signals_to_watch: composed.followUp.signalsToWatch, handoff_when: composed.followUp.handoffWhen,
      guardrails: ["consent + suppression (C15/C16) before every send", "STOP / unsubscribe honoured on every channel", "never names a life event", "a person takes over on positive intent"],
      undelivered: "lead_magnet_promise_undelivered → the arbiter (C4)",
    }
    const attribution = { utm_campaign: `magnet-${(composed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)) || "funnel"}`, params: Object.values(LEAD_MAGNET_ATTRIBUTION_PARAMS), capture: "captureFormSubmission verifies campaign_id against the tenant and records the converted touchpoint", reader: "getMagnetPerformance (attributedConversions)" }
    const learning = { hypothesis: composed.learning.hypothesis, primary_metric: composed.learning.primaryMetric, readers: ["getMagnetPerformance", "lead_magnet_promises (delivered)", "sequence_enrollments (converted)"], variant: "A" }
    const funnelSettings = {
      version: 1, id: funnelId, created_at: isoUtc(now), brief: { audience: brief.audience, benefit: brief.benefit, outcome: brief.outcome, area: brief.area ?? null },
      big_promise: composed.bigPromise, angle: composed.angle, awareness_stage: composed.awarenessStage, primary: primarySpec, consent, owner,
      thank_you: composed.thankYou, follow_up_policy: followUpPolicy, attribution, learning, from_ai: composed.fromAi,
    }
    const { draftLeadMagnetFromConcept } = await import("./ai-draft")
    const copy = { name: composed.copy.name, description: composed.copy.description, headline: composed.copy.headline, subhead: composed.copy.subhead, cta: composed.copy.cta, bullets: truthfulBullets, thankYou: `${composed.thankYou.message} ${composed.thankYou.nextStepLine}`.slice(0, 160), faq: composed.copy.faq }
    const drafted = await draftLeadMagnetFromConcept({
      brokerageId, agentId: brief.agentId, createdBy: brief.createdBy, concept: `${brief.benefit} for ${brief.audience} — ${brief.outcome}`,
      magnetType: composed.magnetType, area: brief.area ?? null, brand: ctx.brandName, audience: brief.audience, actor: brief.actor ?? null,
      // the escalation baseline is the funnel's OWN deterministic copy (truthful for THIS primary), never a generic guide page
      funnel: { settings: { funnel: funnelSettings }, baseFields: composed.fields, fixedBullets: truthfulBullets, baseline: (() => { const b = composeFunnelPlan(brief, ctx, null, classifyConceptMagnetType).copy; return { headline: b.headline, subhead: b.subhead, cta: b.cta } })() },
    }, {
      // the planner already asked the entitlement (with the larger estimate) — one ask per command
      entitlement: async () => ({ allowed: true, reason: "asked by createMagnetFunnel" }),
      // attempt 0 is the composed copy; a rewrite after a fair-housing finding falls to the safe baseline + the truthful bullets
      // and is escalated to the human reviewer by the survivor (never shipped unreviewed)
      generator: async (req) => (req.attempt ? null : copy),
      client: svc as never, deliverable: { ...(deps.deliverable ?? {}), preProduced: first }, brand: deps.draftBrand, now,
    })
    if (!drafted.success || !drafted.magnetId || !drafted.slug) return { ok: false, stage: "landing_page", error: drafted.error ?? "the landing page was not created", notes }
    const formId = drafted.magnetId
    stamp("landing_page", { form_id: formId, slug: drafted.slug, fields: composed.fields.map((f) => f.name), situation_questions: composed.fields.filter((f) => f.purpose === "situation").length, bullets: truthfulBullets.length })

    // STAGE 3 · THE FUNNEL — the secondary deliverables and steps, made AFTER the page: assets produced now (a ready one is a
    // bonus, a staged one a bonus once approved, a failed one recorded), arrangements recorded as the page already states them.
    const settled: SettledItem[] = []
    for (const it of composed.items) {
      if (it.role === "primary") continue
      if (it.fulfilment === "asset") {
        const produced = await produceFunnelAsset(svc, it.kind, assetBrief(it), deps)
        const status: FunnelItemStatus = produced.status === "ready" ? "ready" : produced.status === "staged" ? "staged" : "failed"
        settled.push({ ...it, status, promised: false, arrangement: null, produced, reason: produced.status === "ready" ? null : (produced.reason ?? null), title: produced.title ?? it.title })
        if (status === "ready") notes.push(`${it.title}: ready — made after the page, so it goes out as a BONUS with the magnet (the page promises only what existed when it was written)`)
        if (status === "staged") notes.push(`${it.title}: staged for approval (${produced.reason ?? "awaiting its approver"}) — delivered as a bonus once approved, never promised before`)
        if (status === "failed") notes.push(`${it.title}: not produced — ${produced.reason ?? "unknown"} — not promised`)
      } else {
        const a = arrangedFor.get(it.key) ?? assessArrangement(it.kind, ctx, now)
        if (a.status === "arranged") {
          settled.push({ ...it, status: "arranged", promised: promisesArrangement(it, a), arrangement: a.arrangement, produced: null, reason: null, promiseLine: a.promiseLine || it.promiseLine })
        } else {
          settled.push({ ...it, status: "planned", promised: false, arrangement: null, produced: null, reason: a.reason })
          notes.push(`${it.title}: not promised — ${a.reason}`)
        }
      }
    }
    stamp("funnel", { items: settled.length, promised: settled.filter((s) => s.promised).length, bonus: settled.filter((s) => !s.promised && (s.status === "ready" || s.status === "staged")).length })

    // 6 · THE FUNNEL'S ITEMS — recorded under the action ledger; a magnet never exists without them.
    let primaryRow: { status: FunnelItemStatus; asset_url: string | null; document_id: string | null; deliverable_id: string | null; error: string | null } = { status: "failed", asset_url: null, document_id: null, deliverable_id: null, error: drafted.deliverable?.reason ?? "the primary deliverable was not recorded" }
    if (drafted.deliverable?.id) {
      const { deliverableById } = await import("./deliverable-asset")
      const d = await deliverableById(svc, { brokerageId, deliverableId: drafted.deliverable.id })
      const row = d.deliverable
      primaryRow = { status: row?.status === "ready" ? "ready" : row?.status === "staged" ? "staged" : row?.status === "producing" ? "producing" : "failed", asset_url: row?.asset_url ?? null, document_id: row?.document_id ?? null, deliverable_id: row?.id ?? null, error: row?.error ?? d.error ?? null }
    }
    const ts = isoUtc(now)
    const rows = [
      { brokerage_id: brokerageId, form_id: formId, item_key: primaryPlan.key, role: "primary", kind: primaryPlan.kind, fulfilment: primaryPlan.fulfilment, status: primaryRow.status, promised: true, position: 0, title: primaryPlan.title, promise_line: primaryPlan.promiseLine, arrangement: primaryPlan.fulfilment === "human" ? (assessArrangement("valuation", ctx, now) as { arrangement?: Arrangement }).arrangement ?? {} : {}, asset_url: primaryRow.asset_url, document_id: primaryRow.document_id, video_project_id: null, deliverable_id: primaryRow.deliverable_id, payload: { why: primaryPlan.why, outline: primaryPlan.outline }, validation: primaryRow.status === "ready" ? { ok: true, from: "lead_magnet_deliverables (C11)" } : { ok: false }, approver: {}, attempts: 0, error: primaryRow.status === "ready" ? null : primaryRow.error, created_at: ts, updated_at: ts },
      ...settled.map((s, i) => ({
        brokerage_id: brokerageId, form_id: formId, item_key: s.key, role: s.role, kind: s.kind, fulfilment: s.fulfilment, status: s.status, promised: s.promised, position: i + 1,
        title: s.title, promise_line: s.promiseLine || null, arrangement: s.arrangement ?? {}, asset_url: s.produced?.assetUrl ?? null, document_id: s.produced?.documentId ?? null,
        video_project_id: typeof s.produced?.payload?.video_project_id === "string" ? s.produced.payload.video_project_id : null, deliverable_id: null,
        payload: { why: s.why, outline: s.outline, cover_note: s.produced?.coverNote ?? null, ...(s.produced?.payload ?? {}) }, validation: s.produced?.validation ?? (s.status === "arranged" ? { ok: true, checks: ["arrangement_verified"] } : { ok: false }),
        approver: {}, attempts: 0, error: s.reason, created_at: ts, updated_at: ts,
      })),
    ]
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const recorded = await withActionLedger<{ ok: true; ids: string[] } | { ok: false; error: string }>(
      {
        brokerageId, action: "marketing.lead_magnet_funnel.create", actor: { type: "user", userId: brief.createdBy },
        subject: { type: "lead_capture_form", id: formId }, reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `lead-magnet funnel for "${brief.audience}" — ${rows.length} items (${rows.filter((r) => r.promised).length} promised)`,
        riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets",
        detail: { funnel_id: funnelId, from_ai: composed.fromAi, feature: "lead_magnet_draft", order: order.map((o) => ({ stage: o.stage, seq: o.seq, at: o.at })), items: rows.map((r) => ({ key: r.item_key, kind: r.kind, role: r.role, status: r.status, promised: r.promised })), dropped: composed.dropped.length },
      },
      async () => {
        const { data, error } = await svc.from("lead_magnet_funnel_items").insert(rows).select("id")
        if (error) return { ok: false as const, error: `lead_magnet_funnel_items insert refused: ${error.message ?? "unknown"}` }
        if (!Array.isArray(data) || data.length !== rows.length) return { ok: false as const, error: `lead_magnet_funnel_items wrote ${Array.isArray(data) ? data.length : 0} of ${rows.length} rows` }
        return { ok: true as const, ids: data.map((r: { id: string }) => r.id) }
      },
      {
        settle: (r) => r.ok ? { status: "executed", outcome: "funnel_created", providerRef: formId } : { status: "failed", outcome: "items_refused", error: r.error },
        replay: (claim) => ({ ok: false as const, error: `ledger refused the funnel: ${claim.kind}` }),
      },
      { client: svc as never },
    )
    if (!recorded.ok) {
      // ONE UNIT: a funnel page never exists without its items — the draft is removed again (counted).
      const { data: gone, error: delErr } = await svc.from("lead_capture_forms").delete().eq("id", formId).eq("brokerage_id", brokerageId).select("id")
      const removed = !delErr && (gone ?? []).length === 1
      return { ok: false, stage: /ledger refused/.test(recorded.error) ? "ledger" : "items", error: `${recorded.error} — ${removed ? "the landing page was not kept (a funnel never exists without its items)" : `the landing page is left as an unpublishable draft (cleanup refused: ${delErr?.message ?? "matched no row"})`}`, notes }
    }

    // 7 · THE PACKAGE.
    const { items } = await readFunnelItems(svc, { brokerageId, formId })
    const asPkg = (r: FunnelItemRow): FunnelPackageItem => ({ key: r.item_key, role: r.role, kind: r.kind, fulfilment: r.fulfilment, status: r.status, promised: r.promised, title: r.title ?? r.item_key, promiseLine: r.promise_line, reason: r.error, arrangement: (r.arrangement as Arrangement)?.mechanism ? (r.arrangement as Arrangement) : null, assetUrl: r.asset_url })
    const step = (k: FunnelStepKind) => { const r = items.find((i) => i.kind === k); return r ? asPkg(r) : null }
    const path = ctx.brokerageSlug ? `/site/${ctx.brokerageSlug}/lm/${drafted.slug}` : null
    if (!path) notes.push("the brokerage has no website slug — the landing path inside the tenant site cannot be named (the baseline website mints one)")
    const origin = brief.baseUrl ? brief.baseUrl.replace(/\/$/, "") : null
    if (!origin) notes.push("no public origin was given — the landing URL is returned as a path (the configured app URL, NEXT_PUBLIC_APP_URL, names the origin)")
    const url = origin && ctx.brokerageSlug ? leadMagnetLandingUrl(`${origin}/site/${ctx.brokerageSlug}`, drafted.slug, { utmCampaign: attribution.utm_campaign }) : null
    return {
      ok: true,
      package: {
        funnel_id: funnelId,
        landing_page: { form_id: formId, slug: drafted.slug, path, url, state: "draft", headline: composed.copy.headline, subhead: composed.copy.subhead, cta: composed.copy.cta, bullets: truthfulBullets },
        form: { fields: composed.fields, consent, owner },
        deliverables: items.filter((i) => i.role !== "step").map(asPkg),
        thank_you: { headline: composed.thankYou.headline, message: composed.thankYou.message, next_step_line: composed.thankYou.nextStepLine, what_arrives: truthfulBullets },
        personal_video: step("personal_video"), calendar_link: step("calendar_link"), portal_task: step("portal_task"), education_sequence: step("education_sequence"),
        follow_up_policy: followUpPolicy, attribution: { ...attribution, landing_url: url }, learning,
        publishable: funnelPublishVerdict(items), from_ai: composed.fromAi, order,
        notes: [...notes, ...(drafted.fallbackReason ? [drafted.fallbackReason] : [])],
      },
    }
  } catch (e) {
    return { ok: false, stage: "items", error: `createMagnetFunnel threw: ${e instanceof Error ? e.message : String(e)}`, notes }
  }
}

// ── REFRESH (statuses re-read from their survivors) ──────────────────────────

/** Re-read every item's truth from its survivor (the C11 deliverable, the video staging verdict, the arrangement's facts) and
 *  record any change (counted). Returns the refreshed items. */
async function refreshFunnelItems(svc: Db, input: { brokerageId: string; formId: string; now?: Date }): Promise<{ items: FunnelItemRow[]; error: string | null; changed: string[] }> {
  const read = await readFunnelItems(svc, input)
  if (read.error) return { items: [], error: read.error, changed: [] }
  const now = input.now ?? new Date()
  const changed: string[] = []
  const out: FunnelItemRow[] = []
  for (const it of read.items) {
    let patch: Partial<FunnelItemRow> | null = null
    if (it.role === "primary") {
      const { readyDeliverableFor } = await import("./deliverable-asset")
      const d = await readyDeliverableFor(svc, { brokerageId: input.brokerageId, formId: input.formId })
      if (d.error) return { items: [], error: d.error, changed }
      if (d.deliverable && it.status !== "ready") patch = { status: "ready", asset_url: d.deliverable.asset_url, document_id: d.deliverable.document_id, deliverable_id: d.deliverable.id, validation: { ok: true, from: "lead_magnet_deliverables (C11)" }, error: null }
      else if (!d.deliverable && it.status === "ready") patch = { status: "failed", validation: { ok: false }, error: "the C11 deliverable is no longer ready" }
    } else if (it.kind === "video" && it.video_project_id && it.status !== "ready" && it.status !== "withdrawn") {
      const v = await videoReadiness(svc, { brokerageId: input.brokerageId, videoProjectId: it.video_project_id })
      if (v.ready) patch = { status: "ready", asset_url: v.url, validation: { ok: true, checks: ["staged_and_approved_by_assigned_approver", "hosted_video"] }, error: null }
      else if (it.error !== v.reason) patch = { error: v.reason }
    } else if (it.status === "arranged") {
      const a = it.arrangement as Arrangement
      if (a.mechanism === "scheduled_session" && (!a.event_at || Date.parse(a.event_at) < now.getTime())) patch = { status: "failed", error: "the scheduled session has passed — the page can no longer promise it" }
    }
    if (patch) {
      const ts = now.toISOString()
      const { data, error } = await svc.from("lead_magnet_funnel_items").update({ ...patch, updated_at: ts }).eq("id", it.id).eq("brokerage_id", input.brokerageId).select("id")
      if (error) return { items: [], error: `funnel item ${it.item_key} refresh refused: ${error.message ?? "unknown"}`, changed }
      if (!Array.isArray(data) || data.length !== 1) return { items: [], error: `funnel item ${it.item_key} changed under the refresh (matched no row)`, changed }
      changed.push(`${it.item_key}: ${it.status} → ${patch.status ?? it.status}`)
      out.push({ ...it, ...patch, updated_at: ts } as FunnelItemRow)
    } else out.push(it)
  }
  return { items: out, error: null, changed }
}

// ── THE PUBLISH GATE (called by lib/kernel/lead-magnets.ts publishLeadMagnet before activation) ─────────────────────────────

export type FunnelGateResult =
  | { ok: true; required: false }
  | { ok: true; required: true; items: FunnelItemRow[]; decision: { basis: string; tier: string | null; reason: string; permittedUserIds: string[] } }
  | { ok: false; error: string }

/**
 * C21's gate: a funnel magnet publishes only when every PROMISED item is ready or truthfully arranged (statuses re-read from
 * their survivors first) AND the publisher is a C5-permitted approver of the asset. Fails closed on any refused read.
 */
export async function funnelPublishGate(svc: Db, input: { brokerageId: string; formId: string; settings: Record<string, unknown> | null; agentId: string | null; approverUserId: string; now?: Date }): Promise<FunnelGateResult> {
  const funnel = ((input.settings ?? {}) as { funnel?: unknown }).funnel
  if (!funnel || typeof funnel !== "object") return { ok: true, required: false }
  const refreshed = await refreshFunnelItems(svc, { brokerageId: input.brokerageId, formId: input.formId, now: input.now })
  if (refreshed.error) return { ok: false, error: `the funnel's items could not be read — ${refreshed.error}` }
  if (refreshed.items.length === 0) return { ok: false, error: "this funnel has no recorded items — nothing it promises can be verified" }
  const v = funnelPublishVerdict(refreshed.items)
  if (!v.ok) return { ok: false, error: `the funnel promises what is not ready or arranged: ${v.blockers.join("; ")}` }
  const { approverFor } = await import("@/lib/kernel/approval-authority")
  const decision = await approverFor({ brokerageId: input.brokerageId, assetKind: "asset", scope: { agentId: input.agentId }, client: svc as never })
  if (!decision.ok) return { ok: false, error: `nobody can approve this funnel's deliverables yet: ${decision.reason}` }
  if (!decision.permittedUserIds.includes(input.approverUserId)) return { ok: false, error: `you are not an approver of this funnel's deliverables — ${decision.reason}` }
  return { ok: true, required: true, items: refreshed.items, decision: { basis: decision.basis, tier: decision.tier, reason: decision.reason, permittedUserIds: decision.permittedUserIds } }
}

/** Record WHO approved the funnel's promised items (counted: every promised item must take the stamp). */
export async function recordFunnelApproval(svc: Db, input: { brokerageId: string; formId: string; approverUserId: string; decision: { basis: string; tier: string | null; reason: string; permittedUserIds: string[] }; at: string; promisedCount: number }): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await svc.from("lead_magnet_funnel_items")
    .update({ approved_by: input.approverUserId, approved_at: input.at, approver: { basis: input.decision.basis, tier: input.decision.tier, reason: input.decision.reason, permitted: input.decision.permittedUserIds.length }, updated_at: input.at })
    .eq("brokerage_id", input.brokerageId).eq("form_id", input.formId).eq("promised", true).in("status", ["ready", "arranged"]).select("id")
  if (error) return { ok: false, error: error.message ?? "update refused" }
  if (!Array.isArray(data) || data.length !== input.promisedCount) return { ok: false, error: `the approval reached ${Array.isArray(data) ? data.length : 0} of ${input.promisedCount} promised items — an item changed since the gate read it` }
  return { ok: true }
}

// ── DELIVERY BUNDLE (read by C4's deliverPromised) ───────────────────────────

export interface FunnelBundle { promisedMissing: string[]; assets: Array<{ key: string; kind: string; title: string; url: string; bonus: boolean }>; arrangements: Array<{ key: string; kind: string; line: string; mechanism: string; joinUrl: string | null }> }

/** What the C4 delivery carries beyond the primary: every READY secondary asset (promised or a bonus) and every arrangement's
 *  own line. A promised secondary asset that is not ready is MISSING — the promise is not delivered without it. */
export async function funnelBundleFor(svc: Db, input: { brokerageId: string; formId: string }): Promise<{ bundle: FunnelBundle; error: string | null }> {
  const read = await readFunnelItems(svc, input)
  const bundle: FunnelBundle = { promisedMissing: [], assets: [], arrangements: [] }
  if (read.error) return { bundle, error: read.error }
  for (const it of read.items) {
    if (it.role === "primary" || it.status === "withdrawn") continue
    if (it.fulfilment === "asset") {
      const url = httpsUrl(it.asset_url)
      if (it.status === "ready" && url) bundle.assets.push({ key: it.item_key, kind: it.kind, title: it.title ?? it.item_key, url, bonus: !it.promised })
      else if (it.promised) bundle.promisedMissing.push(`${it.title ?? it.item_key} (${it.kind}: ${it.status}${it.error ? ` — ${it.error}` : ""})`)
    } else if (it.status === "arranged" && it.promise_line) {
      const a = it.arrangement as Arrangement
      bundle.arrangements.push({ key: it.item_key, kind: it.kind, line: it.promise_line, mechanism: a.mechanism, joinUrl: a.join_url ?? null })
    }
  }
  return { bundle, error: null }
}

// ── FOLLOW-THROUGH AT CAPTURE (called by C4's recordPromisedDeliverable for a new promise; retried by the recovery) ─────────

export interface FollowThroughResult { ran: boolean; steps: Array<{ key: string; kind: string; status: "done" | "failed" | "skipped"; ref: string | null; reason: string | null }>; recorded: boolean; error: string | null }

const MAX_STEP_ATTEMPTS = 3

/**
 * The funnel's per-person arrangements, executed once per promise through their survivors: the agent's task (consultation /
 * calendar / valuation), the sequence enrolment (mini-course / education), ONE portal card (calculator + portal task), the
 * personal reel commissioned and STAGED for the agent's approval. Outcomes ride the promise row (asset_ref.funnel_steps,
 * counted). Idempotent: a step already done is never re-run; a failed one is retried (bounded).
 */
export async function followThroughMagnetFunnel(svc: Db, input: { brokerageId: string; formId: string; promiseId: string; contactId: string; now?: Date }, deps: FunnelDeps = {}): Promise<FollowThroughResult> {
  const out: FollowThroughResult = { ran: false, steps: [], recorded: false, error: null }
  try {
    const now = input.now ?? new Date()
    const { data: promise, error: pErr } = await svc.from("lead_magnet_promises").select("id, asset_ref").eq("id", input.promiseId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (pErr || !promise) return { ...out, error: pErr ? `lead_magnet_promises read refused: ${pErr.message}` : "promise not found in this brokerage" }
    const prior = ((promise.asset_ref ?? {}) as { funnel_steps?: { steps?: FollowThroughResult["steps"]; attempts?: number } }).funnel_steps
    const attempts = (prior?.attempts ?? 0) + 1
    const done = new Set((prior?.steps ?? []).filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.key))
    if (prior && done.size === (prior.steps ?? []).length) return { ...out, steps: prior.steps ?? [] }
    if (prior && attempts > MAX_STEP_ATTEMPTS) return { ...out, steps: prior.steps ?? [], error: `follow-through attempts exhausted (${MAX_STEP_ATTEMPTS})` }
    const read = await readFunnelItems(svc, { brokerageId: input.brokerageId, formId: input.formId })
    if (read.error) return { ...out, error: read.error }
    const { data: form, error: fErr } = await svc.from("lead_capture_forms").select("id, agent_id, name").eq("id", input.formId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (fErr || !form) return { ...out, error: fErr ? `lead_capture_forms read refused: ${fErr.message}` : "the form is not this brokerage's" }
    const { data: contact, error: cErr } = await svc.from("contacts").select("id, first_name").eq("id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (cErr || !contact) return { ...out, error: cErr ? `contacts read refused: ${cErr.message}` : "the contact is not this brokerage's" }
    out.ran = true
    const firstName = (contact as { first_name?: string | null }).first_name ?? "this person"
    const magnetName = (form as { name?: string | null }).name ?? "your lead magnet"
    const portalLines: Array<{ key: string; kind: string; line: string }> = []
    const steps: FollowThroughResult["steps"] = (prior?.steps ?? []).filter((s) => done.has(s.key))
    for (const it of read.items.filter((i) => i.status === "arranged" && !done.has(i.item_key))) {
      const a = it.arrangement as Arrangement
      try {
        if (a.mechanism === "calendar_offer" || a.mechanism === "agent_callback" || a.mechanism === "agent_prepared_value") {
          const agentId = (form as { agent_id?: string | null }).agent_id
          if (!agentId) { steps.push({ key: it.item_key, kind: it.kind, status: "failed", ref: null, reason: "the form has no agent to own the task" }); continue }
          const title = a.mechanism === "agent_prepared_value" ? `Prepare ${firstName}'s home value — they asked on "${magnetName}"` : `Offer ${firstName} a time to talk — they asked on "${magnetName}"`
          const description = a.mechanism === "calendar_offer" ? `${it.promise_line}. Send them a few real open times from your connected calendar (or let the AI ISA offer them).` : `${it.promise_line}.`
          const { data: task, error: tErr } = await svc.from("tasks").insert({ brokerage_id: input.brokerageId, assigned_to_agent_id: agentId, contact_id: input.contactId, title, description, due_date: new Date(now.getTime() + (a.due_within_hours ?? 24) * 3_600_000).toISOString(), priority: "high" }).select("id").maybeSingle()
          if (tErr || !task) steps.push({ key: it.item_key, kind: it.kind, status: "failed", ref: null, reason: `task refused: ${tErr?.message ?? "no row returned"}` })
          else steps.push({ key: it.item_key, kind: it.kind, status: "done", ref: `tasks:${task.id}`, reason: null })
        } else if (a.mechanism === "sequence_enrollment" && a.sequence_id) {
          const enroll = deps.enroll ?? (async (x) => (await import("@/lib/campaign-sequences/enrollment-engine")).enrollContact({ sequenceId: x.sequenceId, contactId: x.contactId, brokerageId: x.brokerageId, enrolledBy: x.enrolledBy ?? undefined, journey: "hold" }))
          const r = await enroll({ brokerageId: input.brokerageId, sequenceId: a.sequence_id, contactId: input.contactId, enrolledBy: (form as { agent_id?: string | null }).agent_id ?? null })
          steps.push(r.success || r.alreadyEnrolled ? { key: it.item_key, kind: it.kind, status: "done", ref: r.enrollmentId ? `sequence_enrollments:${r.enrollmentId}` : "already_enrolled", reason: null } : { key: it.item_key, kind: it.kind, status: "failed", ref: null, reason: r.error ?? "enrolment refused" })
        } else if (a.mechanism === "portal_financial_tools" || a.mechanism === "portal_card") {
          portalLines.push({ key: it.item_key, kind: it.kind, line: it.kind === "portal_task" ? (it.title ?? "Your next step") : (it.promise_line ?? it.title ?? it.kind) })
        } else if (a.mechanism === "personal_reel_staged" && a.owner_user_id) {
          const commission = deps.commissionPersonalVideo ?? (async (x) => {
            const { commissionVideo } = await import("@/lib/video/video-director")
            const r = await commissionVideo({ kind: "lead_intro", tier: "solo_agent", targetChannel: "email", facts: { magnet: x.title } }, { brokerageId: x.brokerageId, agentUserId: x.agentUserId, contactId: x.contactId, title: x.title, idempotencyDiscriminator: x.discriminator, meterFeature: "lead_magnet_funnel_personal_video" }, svc as never)
            return { ok: r.ok, status: r.status, videoProjectId: r.videoProjectId ?? null, reason: r.reason ?? null }
          })
          const r = await commission({ brokerageId: input.brokerageId, agentUserId: a.owner_user_id, contactId: input.contactId, title: `A personal note for ${firstName}`, discriminator: `funnel:${input.formId}:${input.contactId}` })
          steps.push(r.ok ? { key: it.item_key, kind: it.kind, status: "done", ref: r.videoProjectId ? `ai_video_projects:${r.videoProjectId}` : r.status, reason: "staged for the agent's approval — never auto-sent" } : { key: it.item_key, kind: it.kind, status: "failed", ref: null, reason: r.reason ?? r.status })
        } else if (a.mechanism === "scheduled_session") {
          steps.push({ key: it.item_key, kind: it.kind, status: "done", ref: `session:${a.event_at}`, reason: "the submission is the registration; the join link rides the delivery" })
        } else steps.push({ key: it.item_key, kind: it.kind, status: "skipped", ref: null, reason: `no per-person step for ${a.mechanism}` })
      } catch (e) {
        steps.push({ key: it.item_key, kind: it.kind, status: "failed", ref: null, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    if (portalLines.length) {
      const push = deps.pushPortal ?? (async (p, c) => (await import("@/lib/kernel/portal-value")).pushPortalValueCard({ ...p, dedupeWindowMs: 0 }, c as never))
      const r = await push({ brokerageId: input.brokerageId, contactId: input.contactId, title: `Your next steps from "${magnetName}"`.slice(0, 200), summary: portalLines.map((l) => l.line).join(" · ").slice(0, 900), updateType: "lead_magnet_next_step", metadata: { lead_magnet_form_id: input.formId, lead_magnet_promise_id: input.promiseId, items: portalLines.map((l) => l.key) } }, svc)
        .catch((e: unknown): { pushed: boolean; id?: string; reason?: string } => ({ pushed: false, reason: e instanceof Error ? e.message : String(e) }))
      for (const l of portalLines) steps.push(r.pushed ? { key: l.key, kind: l.kind, status: "done", ref: r.id ? `transparency_updates:${r.id}` : null, reason: null } : { key: l.key, kind: l.kind, status: "failed", ref: null, reason: `portal card not written: ${r.reason ?? "unknown"}` })
    }
    out.steps = steps
    const assetRef = { ...((promise.asset_ref ?? {}) as Record<string, unknown>), funnel_steps: { at: now.toISOString(), attempts, steps } }
    const { data: upd, error: uErr } = await svc.from("lead_magnet_promises").update({ asset_ref: assetRef, updated_at: now.toISOString() }).eq("id", input.promiseId).eq("brokerage_id", input.brokerageId).select("id")
    if (uErr || !Array.isArray(upd) || upd.length !== 1) out.error = `the follow-through ran but was not recorded on the promise: ${uErr?.message ?? "matched no row"}`
    else out.recorded = true
    return out
  } catch (e) {
    return { ...out, error: `followThroughMagnetFunnel threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── UNDELIVERED-ASSET RECOVERY (the C14 completion half — 147E Outside-lane 7; called by C4's sweep) ─────────────────────────

export interface FunnelRecoveryResult { examined: number; recovered: number; stillOpen: number; notified: number; stepRetries: number; errors: string[] }

const MAX_RECOVERY_ATTEMPTS = 5
const RECOVERY_BACKOFF_MINUTES = [15, 60, 240, 720, 1440] as const

/**
 * Stalled funnel assets — a staged video, a failed checklist / report, a primary whose C11 deliverable is staged or failed —
 * are re-produced (idempotent producers; the video is re-checked against staging, never re-published) with a back-off; a recovered
 * asset is recorded ready and the owning agent is told. NEVER publishes: lead_capture_forms.is_active is not touched here. Then
 * failed follow-through steps of open promises are retried (bounded). Each item is handled under its OWN brokerage_id.
 */
export async function recoverMagnetFunnelAssets(svc: Db, opts: { now?: Date; limit?: number; deps?: FunnelDeps } = {}): Promise<FunnelRecoveryResult> {
  const out: FunnelRecoveryResult = { examined: 0, recovered: 0, stillOpen: 0, notified: 0, stepRetries: 0, errors: [] }
  const now = opts.now ?? new Date()
  const deps = opts.deps ?? {}
  try {
    const { applyTenantScope, platformScope } = await import("@/lib/kernel/tenant-scope")
    const q = applyTenantScope(
      svc.from("lead_magnet_funnel_items").select(ITEM_COLUMNS).in("status", ["staged", "failed", "producing"]).in("role", ["primary", "deliverable"]).lt("attempts", MAX_RECOVERY_ATTEMPTS),
      platformScope("the funnel asset recovery (/api/cron/marketing-campaign-scheduler via sweepUndeliveredPromises, CRON_SECRET verified at the route) re-produces stalled lead-magnet funnel assets across every tenant; each item is handled under its own brokerage_id and nothing is published"),
    )
    const { data, error } = await q.order("updated_at", { ascending: true }).limit(Math.max(1, Math.min(opts.limit ?? 25, 100)))
    if (error) return { ...out, errors: [`lead_magnet_funnel_items read refused: ${error.message ?? "unknown"} — nothing recovered`] }
    for (const it of (data ?? []) as FunnelItemRow[]) {
      if (it.next_attempt_at && Date.parse(it.next_attempt_at) > now.getTime()) continue
      out.examined++
      const { data: form, error: fErr } = await svc.from("lead_capture_forms").select("id, agent_id, name, magnet_type, settings, is_active").eq("id", it.form_id).eq("brokerage_id", it.brokerage_id).maybeSingle()
      if (fErr || !form) { out.errors.push(`${it.id}: the form is unreadable (${fErr?.message ?? "gone"})`); continue }
      const f = form as { id: string; agent_id: string | null; name: string | null; magnet_type: string | null; settings: Record<string, unknown> | null }
      let agentUserId: string | null = null
      if (f.agent_id) {
        const { data: ag, error: agErr } = await svc.from("agents").select("user_id").eq("id", f.agent_id).eq("brokerage_id", it.brokerage_id).maybeSingle()
        if (agErr) out.errors.push(`${it.id}: agent read refused (${agErr.message})`)
        agentUserId = (ag as { user_id?: string | null } | null)?.user_id ?? null
      }
      let ready: { assetUrl: string | null; documentId?: string | null; deliverableId?: string | null } | null = null
      let reason = "still not ready"
      if (it.role === "primary") {
        const { ensureDeliverableForPublish } = await import("./deliverable-asset")
        const r = await ensureDeliverableForPublish(svc, { brokerageId: it.brokerage_id, formId: f.id, magnetType: f.magnet_type ?? "generic_form", title: f.name ?? it.title ?? "Lead magnet", agentId: f.agent_id, settings: f.settings, actorUserId: agentUserId }, deps.deliverable)
        if (r.ok && r.required) ready = { assetUrl: r.deliverable.asset_url, documentId: r.deliverable.document_id, deliverableId: r.deliverable.id }
        else if (!r.ok) reason = r.error
      } else if (it.kind === "video" && it.video_project_id) {
        const v = await videoReadiness(svc, { brokerageId: it.brokerage_id, videoProjectId: it.video_project_id })
        if (v.ready) ready = { assetUrl: v.url }
        else reason = v.reason
      } else {
        const fs = funnelPrimaryOf(f.settings)
        const produced = await produceFunnelAsset(svc, it.kind, { brokerageId: it.brokerage_id, agentUserId, agentId: f.agent_id, actorUserId: agentUserId, title: it.title ?? it.kind, outline: ((it.payload ?? {}) as { outline?: string[] }).outline ?? [], audience: fs?.brief.audience ?? "", benefit: fs?.brief.benefit ?? "", outcome: fs?.brief.outcome ?? "", area: fs?.brief.area ?? null, brandName: "the brokerage", agentFirstName: null, discriminator: `funnel:${fs?.funnel_id ?? it.form_id}:${it.item_key}`, territory: fs?.brief.territory ?? null }, deps)
        if (produced.status === "ready") ready = { assetUrl: produced.assetUrl ?? null, documentId: produced.documentId ?? null }
        else reason = produced.reason ?? `still ${produced.status}`
      }
      const ts = now.toISOString()
      if (ready && (it.fulfilment !== "asset" || httpsUrl(ready.assetUrl))) {
        const { data: upd, error: uErr } = await svc.from("lead_magnet_funnel_items").update({ status: "ready", asset_url: ready.assetUrl, document_id: ready.documentId ?? it.document_id, deliverable_id: ready.deliverableId ?? it.deliverable_id, validation: { ok: true, recovered_at: ts }, error: null, next_attempt_at: null, attempts: it.attempts + 1, updated_at: ts }).eq("id", it.id).eq("brokerage_id", it.brokerage_id).eq("status", it.status).select("id")
        if (uErr || !Array.isArray(upd) || upd.length !== 1) { out.errors.push(`${it.id}: recovered but not recorded (${uErr?.message ?? "matched no row"})`); continue }
        out.recovered++
        if (agentUserId) {
          const { data: bell, error: bErr } = await svc.from("notifications").insert({ user_id: agentUserId, brokerage_id: it.brokerage_id, type: "lead_magnet_asset_recovered", title: `${it.title ?? it.kind} is ready`, body: `"${it.title ?? it.kind}" on "${f.name ?? "your lead magnet"}" is ready now${it.promised ? " — the promises waiting on it are retried by the delivery sweep" : " — it goes out as a bonus with new requests"}. Nothing was published for you.`, entity_type: "lead_capture_form", entity_id: f.id, is_read: false, priority: "medium", channel: "in_app", created_at: ts }).select("id")
          if (bErr || (bell ?? []).length !== 1) out.errors.push(`${it.id}: the agent was not told (${bErr?.message ?? "no notification row"})`)
          else out.notified++
        }
      } else {
        const attempts = it.attempts + 1
        const mins = RECOVERY_BACKOFF_MINUTES[Math.min(attempts - 1, RECOVERY_BACKOFF_MINUTES.length - 1)]
        const { error: uErr } = await svc.from("lead_magnet_funnel_items").update({ attempts, next_attempt_at: new Date(now.getTime() + mins * 60_000).toISOString(), error: reason.slice(0, 1000), updated_at: ts }).eq("id", it.id).eq("brokerage_id", it.brokerage_id).select("id")
        if (uErr) out.errors.push(`${it.id}: the attempt was not recorded (${uErr.message})`)
        out.stillOpen++
      }
    }
    // RETRY failed follow-through steps of recent, still-open promises (bounded inside followThroughMagnetFunnel).
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const pq = applyTenantScope(
      svc.from("lead_magnet_promises").select("id, brokerage_id, form_id, contact_id, asset_ref, created_at").gte("created_at", since),
      platformScope("the funnel follow-through retry (same cron) re-runs failed per-person funnel steps of recent promises, each under its own brokerage_id"),
    )
    const { data: promises, error: pErr } = await pq.limit(100)
    if (pErr) out.errors.push(`lead_magnet_promises read refused: ${pErr.message ?? "unknown"} — no step retried`)
    for (const p of (promises ?? []) as Array<{ id: string; brokerage_id: string; form_id: string | null; contact_id: string | null; asset_ref: { funnel_steps?: { steps?: Array<{ status: string }>; attempts?: number } } | null }>) {
      const fsr = p.asset_ref?.funnel_steps
      if (!fsr || !p.form_id || !p.contact_id || !(fsr.steps ?? []).some((s) => s.status === "failed") || (fsr.attempts ?? 0) >= MAX_STEP_ATTEMPTS) continue
      const r = await followThroughMagnetFunnel(svc, { brokerageId: p.brokerage_id, formId: p.form_id, promiseId: p.id, contactId: p.contact_id, now }, deps)
      out.stepRetries++
      if (r.error) out.errors.push(`${p.id}: ${r.error}`)
    }
  } catch (e) {
    out.errors.push(`recoverMagnetFunnelAssets threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}
