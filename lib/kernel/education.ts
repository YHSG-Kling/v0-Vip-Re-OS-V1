// lib/kernel/education.ts
// LAYER 1 — Education delivery and plan resolution.
// Reads from journey_blueprints, transaction_milestones, and contacts.
// Writes progress to activities (activity_type = 'education').
// No side effects beyond DB writes; does NOT log compliance events.

import { createClient } from "@/lib/supabase/server"
import type { EducationFormat, JourneyPhase, Persona } from "./types"
import { resolveMilestoneIdentity } from "@/lib/transactions/milestone-identity"

// ─── AGE SEGMENT ──────────────────────────────────────────────────────────────

export type AgeSegment = "18-30" | "30-50" | "50-65" | "65+"

/**
 * THE AGE BANDS, DEFINED ONCE. Everything that needs a band derives it from
 * here; nothing re-derives the boundaries inline.
 *
 * A BAND IS A SEGMENT, A BIRTHDATE IS A DOSSIER. The owner ruling (wave 15)
 * unlocked demographic data so education can be routed by age group — "we
 * determine the kind of education in channels by the age group" — and this repo
 * already holds the matching discipline for timeline (buckets 1-3 / 3-6 / 6-12,
 * never 30/60/90, CLAUDE.md §5). The same discipline applies here: selection
 * reads the BAND, never the raw age or the birthday.
 *
 * `AgeSegment` and `DELIVERY_MATRIX` already lived in this file, so the
 * derivation lives beside them rather than in a fifth module. It was previously
 * open-coded inline at lib/portal/resolve-education-context.ts, which is the
 * duplicate this replaces.
 */
export const AGE_SEGMENTS: readonly AgeSegment[] = ["18-30", "30-50", "50-65", "65+"]

/** PURE. Whole-years age → band. null in, null out — an unknown age must stay
 *  unknown rather than defaulting into a band it was never measured in. */
export function ageSegmentFromAge(age: number | null | undefined): AgeSegment | null {
  if (age == null || !Number.isFinite(age) || age <= 0) return null
  if (age < 30) return "18-30"
  if (age < 50) return "30-50"
  if (age < 65) return "50-65"
  return "65+"
}

/**
 * PURE. An enrichment `age_range` string → a single representative age.
 *
 * `contacts.age_range` is written by the enrichment lane
 * (lib/lead-pipeline/enrichment-column-map.ts, app/actions/contact-enrichment.ts)
 * in the PROVIDER's banding — "25-34", "35-44", "55+", "65 plus" — which does
 * not line up with ours. Rather than adding a second age vocabulary (CLAUDE.md
 * §6), the provider band is collapsed to its MIDPOINT here and every band
 * boundary in the tree is decided by `ageSegmentFromAge` alone. An open-ended
 * top band ("65+") uses its lower bound, which lands in the same segment.
 */
export function ageMidpointFromAgeRange(range: string | null | undefined): number | null {
  if (!range) return null
  const nums = String(range).match(/\d+/g)?.map(Number).filter((n) => Number.isFinite(n) && n > 0) ?? []
  if (nums.length === 0) return null
  if (nums.length === 1) return nums[0]
  return Math.round((nums[0] + nums[1]) / 2)
}

/** PURE. An enrichment `age_range` string → OUR band, via the midpoint above. */
export function ageSegmentFromAgeRange(range: string | null | undefined): AgeSegment | null {
  return ageSegmentFromAge(ageMidpointFromAgeRange(range))
}

// ─── GENERATIONAL COHORT ──────────────────────────────────────────────────────
// Companion routing axis. Same person can be 50-65 ageSeg + 'boomer' OR
// 'gen_x' depending on which side of 1965 they were born. Tone differs:
// boomers respond to "your home" framing; gen_x to "your equity"; millennials
// to "your stage in life"; gen_z to "starting out". Marketing + education
// modules tag against the cohort the broker wants to reach.

export type GenerationalCohort =
  | "gen_z"        // born 1997-2012 (~age 14-29 in 2026)
  | "millennial"   // born 1981-1996 (~age 30-45)
  | "gen_x"        // born 1965-1980 (~age 46-61)
  | "boomer"       // born 1946-1964 (~age 62-80)
  | "silent"       // pre-1946 (~age 80+)
  | "unknown"

/** Whole-years age from an ISO birthday string (null when absent/invalid). Pure. */
export function ageFromBirthday(birthday: string | null | undefined): number | null {
  if (!birthday) return null
  const birthDate = new Date(birthday)
  if (Number.isNaN(birthDate.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birthDate.getFullYear()
  const beforeBirthday =
    today.getMonth() < birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())
  if (beforeBirthday) age -= 1
  return age >= 0 ? age : null
}

/** Derive cohort from a numeric age. Pure utility, no DB access. */
export function generationalCohortFromAge(age: number | null | undefined): GenerationalCohort {
  if (age == null || age <= 0 || !Number.isFinite(age)) return "unknown"
  if (age < 30)  return "gen_z"
  if (age < 46)  return "millennial"
  if (age < 62)  return "gen_x"
  if (age < 80)  return "boomer"
  return "silent"
}

// ─── COHORT TONE FRAMING ──────────────────────────────────────────────────────
// PURE. A short, persona-appropriate lead-in that the portal prepends to a
// milestone's plain-language explanation so the SAME factual content is FRAMED in
// the language each generation responds to (the tone axis the cohort comment above
// describes). Identity/visibility are unchanged — this is wording only.

const COHORT_FRAMING: Record<GenerationalCohort, string> = {
  gen_z:      "Quick version — ",
  millennial: "Here's what this means for your move — ",
  gen_x:      "Here's how this protects your investment — ",
  boomer:     "Here's what's happening with your home — ",
  silent:     "Here's what's happening, step by step — ",
  unknown:    "",
}

/** Returns the cohort-appropriate lead-in for a milestone explanation (or "" when
 *  the cohort is unknown, so callers render the explanation unchanged). */
export function cohortFraming(cohort: GenerationalCohort): string {
  return COHORT_FRAMING[cohort] ?? ""
}

// ─── DELIVERY CONFIG ──────────────────────────────────────────────────────────

export interface DeliveryConfig {
  /** Preferred primary format for this age segment */
  primaryFormat: EducationFormat
  /** Secondary/fallback format */
  secondaryFormat: EducationFormat
  /** Preferred reading level: simplified | standard | detailed */
  readingLevel: "simplified" | "standard" | "detailed"
  /** Whether to auto-play video content */
  autoPlay: boolean
  /** Whether to show progress indicators prominently */
  showProgress: boolean
  /** Estimated max comfortable lesson duration in minutes */
  maxLessonMinutes: number
  /** Whether quiz gates should be required before advancing */
  requireQuizCompletion: boolean
}

// ─── EDUCATION LESSON ─────────────────────────────────────────────────────────

export interface EducationLesson {
  key: string
  title: string
  description: string
  format: EducationFormat
  /** Milestone key this lesson is anchored to, null for pre-journey */
  milestoneKey: string | null
  /** Relative order within the plan */
  order: number
  /** Estimated duration in minutes */
  estimatedMinutes: number
  /** Whether this lesson is gated (requires prior completion) */
  isGated: boolean
  /** Tags for filtering — e.g. ["financing", "legal", "inspection"] */
  tags: string[]
}

// ─── EDUCATION PLAN ───────────────────────────────────────────────────────────

export interface EducationPlan {
  contactId?: string
  journeyType: "buyer" | "seller"
  journeyPhase: JourneyPhase
  persona: Persona | string
  ageSegment: AgeSegment
  delivery: DeliveryConfig
  lessons: EducationLesson[]
}

// ─── PARAMS ───────────────────────────────────────────────────────────────────

export interface GetEducationDeliveryParams {
  ageSegment: AgeSegment
  format?: EducationFormat
}

export interface GetEducationPlanParams {
  journeyType: "buyer" | "seller"
  journeyPhase: JourneyPhase
  persona: Persona | string
  ageSegment: AgeSegment
  /** listing or transaction milestone key to anchor active-journey lessons */
  milestoneKey?: string
  /** contactId to read existing progress and persona overrides */
  contactId?: string
}

// ─── DELIVERY MATRIX ──────────────────────────────────────────────────────────
// Maps age segments to delivery preferences.
// Based on NAR and UX research patterns for real estate education consumption.

const DELIVERY_MATRIX: Record<AgeSegment, DeliveryConfig> = {
  "18-30": {
    primaryFormat: "video",
    secondaryFormat: "checklist",
    readingLevel: "simplified",
    autoPlay: true,
    showProgress: true,
    maxLessonMinutes: 5,
    requireQuizCompletion: false,
  },
  "30-50": {
    primaryFormat: "guide",
    secondaryFormat: "video",
    readingLevel: "standard",
    autoPlay: false,
    showProgress: true,
    maxLessonMinutes: 10,
    requireQuizCompletion: true,
  },
  "50-65": {
    primaryFormat: "guide",
    secondaryFormat: "checklist",
    readingLevel: "detailed",
    autoPlay: false,
    showProgress: true,
    maxLessonMinutes: 15,
    requireQuizCompletion: true,
  },
  "65+": {
    primaryFormat: "checklist",
    secondaryFormat: "guide",
    readingLevel: "simplified",
    autoPlay: false,
    showProgress: false,
    maxLessonMinutes: 10,
    requireQuizCompletion: false,
  },
}

// ─── LESSON CATALOG ───────────────────────────────────────────────────────────
// Static lesson definitions. Active-journey lessons reference milestone keys
// from transaction_milestones.milestone_name.

const BUYER_PRE_LESSONS: Omit<EducationLesson, "format">[] = [
  {
    key: "buyer_pre_intro",
    title: "Welcome to Your Home Buying Journey",
    description: "Overview of the process, your agent's role, and what to expect.",
    milestoneKey: null,
    order: 1,
    estimatedMinutes: 5,
    isGated: false,
    tags: ["overview"],
  },
  {
    key: "buyer_pre_credit",
    title: "Understanding Your Credit & Finances",
    description: "How lenders evaluate you, what your score means, and how to improve it.",
    milestoneKey: null,
    order: 2,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["financing", "credit"],
  },
  {
    key: "buyer_pre_preapproval",
    title: "Getting Pre-Approved",
    description: "Why pre-approval matters, what documents you need, and choosing a lender.",
    milestoneKey: null,
    order: 3,
    estimatedMinutes: 7,
    isGated: false,
    tags: ["financing"],
  },
  {
    key: "buyer_pre_search",
    title: "How Home Search Works",
    description: "MLS, portals, tours, and what to look for beyond the listing photos.",
    milestoneKey: null,
    order: 4,
    estimatedMinutes: 6,
    isGated: false,
    tags: ["search"],
  },
  {
    key: "buyer_pre_offer",
    title: "Making an Offer — What It Means",
    description: "Offer components, earnest money, contingencies, and timelines.",
    milestoneKey: null,
    order: 5,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["offer", "legal"],
  },
  {
    key: "buyer_pre_quiz",
    title: "Pre-Journey Knowledge Check",
    description: "Make sure you're ready to start your search.",
    milestoneKey: null,
    order: 6,
    estimatedMinutes: 5,
    isGated: true,
    tags: ["quiz"],
  },
]

const BUYER_ACTIVE_LESSONS: Omit<EducationLesson, "format">[] = [
  {
    key: "buyer_active_earnest",
    title: "Earnest Money — Your Commitment Deposit",
    description: "What earnest money is, when it's due, and what happens to it.",
    milestoneKey: "earnest_money_due",
    order: 1,
    estimatedMinutes: 5,
    isGated: false,
    tags: ["offer", "financing"],
  },
  {
    key: "buyer_active_inspection",
    title: "Your Home Inspection Explained",
    description: "What inspectors check, what findings mean, and your negotiation rights.",
    milestoneKey: "inspection_deadline",
    order: 2,
    estimatedMinutes: 10,
    isGated: false,
    tags: ["inspection"],
  },
  {
    key: "buyer_active_appraisal",
    title: "The Appraisal Process",
    description: "Why lenders require appraisals, how value is determined, and appraisal gaps.",
    milestoneKey: "appraisal_deadline",
    order: 3,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["financing", "appraisal"],
  },
  {
    key: "buyer_active_financing",
    title: "Clearing Your Financing Contingency",
    description: "What your lender is doing during underwriting and what you should avoid.",
    milestoneKey: "financing_deadline",
    order: 4,
    estimatedMinutes: 7,
    isGated: false,
    tags: ["financing"],
  },
  {
    key: "buyer_active_clear_to_close",
    title: "Clear to Close — What Happens Next",
    description: "Your final walkthrough, closing disclosure review, and wiring funds safely.",
    milestoneKey: "clear_to_close_received",
    order: 5,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["closing"],
  },
  {
    key: "buyer_active_closing_day",
    title: "Closing Day — Step by Step",
    description: "Documents you'll sign, who will be there, keys, and what to bring.",
    milestoneKey: "closing_date",
    order: 6,
    estimatedMinutes: 6,
    isGated: false,
    tags: ["closing"],
  },
]

const SELLER_PRE_LESSONS: Omit<EducationLesson, "format">[] = [
  {
    key: "seller_pre_intro",
    title: "Welcome to Your Home Selling Journey",
    description: "Process overview, your agent's role, and realistic timelines.",
    milestoneKey: null,
    order: 1,
    estimatedMinutes: 5,
    isGated: false,
    tags: ["overview"],
  },
  {
    key: "seller_pre_valuation",
    title: "How Your Home Gets Priced",
    description: "CMA methodology, market conditions, and the cost of overpricing.",
    milestoneKey: null,
    order: 2,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["pricing"],
  },
  {
    key: "seller_pre_prep",
    title: "Preparing Your Home for Market",
    description: "Staging basics, photography, repairs that pay off, and curb appeal.",
    milestoneKey: null,
    order: 3,
    estimatedMinutes: 7,
    isGated: false,
    tags: ["preparation"],
  },
  {
    key: "seller_pre_disclosures",
    title: "Disclosure Obligations",
    description: "What sellers must disclose, why it protects you, and what to document.",
    milestoneKey: null,
    order: 4,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["legal", "disclosures"],
  },
  {
    key: "seller_pre_offers",
    title: "Evaluating Offers — More Than Price",
    description: "Contingencies, financing types, timelines, and net proceeds calculation.",
    milestoneKey: null,
    order: 5,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["offer"],
  },
  {
    key: "seller_pre_quiz",
    title: "Pre-Listing Knowledge Check",
    description: "Confirm you understand your rights and obligations before listing.",
    milestoneKey: null,
    order: 6,
    estimatedMinutes: 5,
    isGated: true,
    tags: ["quiz"],
  },
]

const SELLER_ACTIVE_LESSONS: Omit<EducationLesson, "format">[] = [
  {
    key: "seller_active_going_live",
    title: "Your Listing Goes Live",
    description: "What happens on day one, MLS syndication, and showing setup.",
    milestoneKey: "listing_active",
    order: 1,
    estimatedMinutes: 5,
    isGated: false,
    tags: ["listing"],
  },
  {
    key: "seller_active_showings",
    title: "Managing Showings",
    description: "Lockbox protocol, feedback collection, and adjusting strategy.",
    milestoneKey: "listing_active",
    order: 2,
    estimatedMinutes: 6,
    isGated: false,
    tags: ["showings"],
  },
  {
    key: "seller_active_offer_received",
    title: "You Have an Offer — Now What?",
    description: "Counter-offer strategies, multiple offer situations, and acceptance.",
    milestoneKey: "offer_received",
    order: 3,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["offer", "negotiation"],
  },
  {
    key: "seller_active_inspection",
    title: "Buyer's Inspection — Seller Perspective",
    description: "What the buyer inspector looks for and how to respond to repair requests.",
    milestoneKey: "inspection_deadline",
    order: 4,
    estimatedMinutes: 8,
    isGated: false,
    tags: ["inspection"],
  },
  {
    key: "seller_active_appraisal",
    title: "The Appraisal — Seller's Guide",
    description: "How to prepare for appraiser visit and what a low appraisal means.",
    milestoneKey: "appraisal_deadline",
    order: 5,
    estimatedMinutes: 7,
    isGated: false,
    tags: ["appraisal"],
  },
  {
    key: "seller_active_closing",
    title: "Closing Day — Seller Guide",
    description: "What you sign, net proceeds, possession timing, and moving logistics.",
    milestoneKey: "closing_date",
    order: 6,
    estimatedMinutes: 6,
    isGated: false,
    tags: ["closing"],
  },
]

// Persona-specific supplemental lessons injected into any plan
const PERSONA_SUPPLEMENTS: Partial<Record<string, Omit<EducationLesson, "format">[]>> = {
  first_time: [
    {
      key: "persona_first_time_assistance",
      title: "First-Time Buyer Programs & Down Payment Assistance",
      description: "State programs, FHA vs conventional, gift funds, and grants.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 8,
      isGated: false,
      tags: ["financing", "assistance"],
    },
  ],
  military: [
    {
      key: "persona_military_va",
      title: "VA Loan Benefits Explained",
      description: "Eligibility, entitlement, funding fee, and why VA loans are powerful.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 8,
      isGated: false,
      tags: ["financing", "va"],
    },
  ],
  senior: [
    {
      key: "persona_senior_downsizing",
      title: "Downsizing & Senior Transition Resources",
      description: "55+ communities, estate planning implications, and senior move management.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 8,
      isGated: false,
      tags: ["transition", "downsizing"],
    },
  ],
  divorce: [
    {
      key: "persona_divorce_equity",
      title: "Selling During Divorce — What You Need to Know",
      description: "How title works in divorce, court orders, and protecting your equity.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 8,
      isGated: false,
      tags: ["legal", "equity"],
    },
  ],
  foreclosure: [
    {
      key: "persona_foreclosure_options",
      title: "Foreclosure Alternatives & Short Sales",
      description: "Deed in lieu, short sale process, timeline, and credit impact.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 10,
      isGated: false,
      tags: ["legal", "financing"],
    },
  ],
  probate: [
    {
      key: "persona_probate_process",
      title: "Selling Inherited Property Through Probate",
      description: "Probate court involvement, administrator authority, and timeline.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 10,
      isGated: false,
      tags: ["legal", "estate"],
    },
  ],
  fsbo: [
    {
      key: "persona_fsbo_why_agent",
      title: "Why Working With an Agent Protects You",
      description: "Liability, NAR data on FSBO net proceeds, and MLS access.",
      milestoneKey: null,
      order: 99,
      estimatedMinutes: 6,
      isGated: false,
      tags: ["overview", "legal"],
    },
  ],
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Assign format to a lesson based on delivery config.
 * Quiz lessons always stay as 'quiz'; checklist-tagged lessons prefer 'checklist'.
 */
function assignFormat(
  lesson: Omit<EducationLesson, "format">,
  delivery: DeliveryConfig,
): EducationLesson {
  let format: EducationFormat

  if (lesson.tags.includes("quiz")) {
    format = "quiz"
  } else if (lesson.tags.includes("checklist")) {
    format = "checklist"
  } else {
    format = delivery.primaryFormat
  }

  return { ...lesson, format }
}

/**
 * Filter active-journey lessons to only those at or before the current milestone.
 * Uses the milestone order in the catalog as a proxy for timeline position.
 */
function filterToMilestone(
  lessons: Omit<EducationLesson, "format">[],
  milestoneKey: string,
): Omit<EducationLesson, "format">[] {
  const milestoneOrder = lessons.find((l) => l.milestoneKey === milestoneKey)?.order ?? Infinity
  return lessons.filter(
    (l) => l.milestoneKey === null || (l.order <= milestoneOrder + 1),
  )
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Returns the delivery configuration for a given age segment.
 * If `format` is supplied, overrides the primaryFormat with that format.
 * Does NOT hit the database — purely static.
 */
export function getEducationDelivery(params: GetEducationDeliveryParams): DeliveryConfig {
  const base = DELIVERY_MATRIX[params.ageSegment]
  if (!params.format) return base
  return { ...base, primaryFormat: params.format }
}

/**
 * Builds a full education plan for a contact's journey.
 *
 * Pre-journey: returns the full lesson catalog for the journeyType + persona.
 * Active-journey: reads the milestone from transaction_milestones (or uses milestoneKey
 * directly) and returns only lessons relevant up to that point in the timeline.
 *
 * If contactId is provided, reads the contact's persona override from the DB.
 */
export async function getEducationPlan(params: GetEducationPlanParams): Promise<EducationPlan> {
  const supabase = await createClient()

  let resolvedPersona: string = params.persona
  let resolvedMilestoneKey: string | undefined = params.milestoneKey

  // ── 1. Resolve persona from contact record if contactId supplied ─────────────
  if (params.contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("contact_persona, status")
      .eq("id", params.contactId)
      .maybeSingle()

    if (contact?.contact_persona) {
      resolvedPersona = contact.contact_persona
    }
  }

  // ── 2. Resolve milestone from active transaction if active journey ────────────
  if (params.journeyPhase === "active" && params.contactId && !resolvedMilestoneKey) {
    // Find the most recent in-progress transaction for this contact
    const { data: tx } = await supabase
      .from("transactions")
      .select("id, stage")
      .eq("contact_id", params.contactId)
      .not("stage", "eq", "closed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (tx) {
      // Find the earliest incomplete milestone as the current position
      const { data: milestone } = await supabase
        .from("transaction_milestones")
        .select("milestone_name, milestone_type")
        .eq("transaction_id", tx.id)
        .eq("status", "pending")
        .order("target_date", { ascending: true })
        .limit(1)
        .maybeSingle()

      if (milestone?.milestone_name) {
        // Anchor active-journey lessons on the canonical identity so
        // filterToMilestone matches the catalog's milestoneKey vocabulary.
        resolvedMilestoneKey = resolveMilestoneIdentity(milestone) ?? milestone.milestone_name
      }
    }
  }

  // ── 3. Select lesson catalog ──────────────────────────────────────────────────
  const delivery = getEducationDelivery({ ageSegment: params.ageSegment })

  let rawLessons: Omit<EducationLesson, "format">[]

  if (params.journeyType === "buyer") {
    if (params.journeyPhase === "pre") {
      rawLessons = [...BUYER_PRE_LESSONS]
    } else {
      rawLessons = resolvedMilestoneKey
        ? filterToMilestone(BUYER_ACTIVE_LESSONS, resolvedMilestoneKey)
        : [...BUYER_ACTIVE_LESSONS]
    }
  } else {
    if (params.journeyPhase === "pre") {
      rawLessons = [...SELLER_PRE_LESSONS]
    } else {
      rawLessons = resolvedMilestoneKey
        ? filterToMilestone(SELLER_ACTIVE_LESSONS, resolvedMilestoneKey)
        : [...SELLER_ACTIVE_LESSONS]
    }
  }

  // ── 4. Inject persona supplements ────────────────────────────────────────────
  const supplements = PERSONA_SUPPLEMENTS[resolvedPersona] ?? []
  rawLessons = [...rawLessons, ...supplements]

  // ── 5. Assign format based on delivery config ────────────────────────────────
  const lessons: EducationLesson[] = rawLessons
    .sort((a, b) => a.order - b.order)
    .map((l) => assignFormat(l, delivery))

  return {
    contactId: params.contactId,
    journeyType: params.journeyType,
    journeyPhase: params.journeyPhase,
    persona: resolvedPersona,
    ageSegment: params.ageSegment,
    delivery,
    lessons,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// KERNEL COMMANDS: 8 Canonical Education Operations
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateEducationalResourceInput {
  title: string
  description: string
  /** "podcast" added wave 4 slice 2 — the learning-modules console already
   *  offers a Podcast channel, and the education editor can now author an
   *  audio/podcast script (content-generation-engine.ts:generateAudio). */
  contentType: "video" | "article" | "interactive" | "assessment" | "podcast"
  content: string
  estimatedMinutes: number
  createdBy: string
  brokerageId: string
}

export interface CreateEducationalResourceOutput {
  resourceId: string
  success: boolean
  createdAt: string
}

export async function createEducationalResource(
  supabase: any,
  input: CreateEducationalResourceInput
): Promise<CreateEducationalResourceOutput> {
  const channels = (() => {
    switch (input.contentType) {
      case "video":         return ["video"]
      case "podcast":       return ["podcast"]
      case "article":       return ["article"]
      case "interactive":   return ["quiz"]
      case "assessment":    return ["quiz"]
      default:              return ["article"]
    }
  })()

  // No-duplicate guard: return an existing near-identical resource rather than
  // publishing a second copy (owner: "no duplicates or noise").
  {
    const { findNearDuplicateModule } = await import("@/lib/education/dedup-guard")
    const dup = await findNearDuplicateModule(supabase, input.brokerageId, input.title, null)
    if (dup) {
      return { resourceId: dup.id, success: true, createdAt: new Date().toISOString() }
    }
  }

  const { data, error } = await supabase
    .from("learning_modules")
    .insert({
      brokerage_id:        input.brokerageId,
      authored_by:         input.createdBy,
      title:               input.title,
      summary:             input.description,
      body:                input.content,
      estimated_minutes:   input.estimatedMinutes,
      channels,
      status:              "published",
      published_at:        new Date().toISOString(),
    })
    .select("id, created_at")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to create educational resource: ${error?.message}`)
  }

  return {
    resourceId: data.id,
    success:    true,
    createdAt: data.created_at,
  }
}

export interface AssignResourceInput {
  contactId: string
  resourceId: string
  dueDate?: string
  brokerageId: string
}

export interface AssignResourceOutput {
  assignmentId: string
  success: boolean
  assignedAt: string
}

export async function assignResource(
  supabase: any,
  input: AssignResourceInput
): Promise<AssignResourceOutput> {
  // Post-1043: customer assignments live in learning_assignments keyed
  // by (contact_id, module_id). resourceId is now a learning_modules.id (uuid).
  const { data, error } = await supabase
    .from("learning_assignments")
    .insert({
      brokerage_id:   input.brokerageId,
      module_id:      input.resourceId,
      contact_id:     input.contactId,
      signal_source:  "manual:assign_resource",
      priority_score: 60,
      status:         "open",
    })
    .select("id, created_at")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to assign resource: ${error?.message}`)
  }

  return {
    assignmentId: data.id,
    success:      true,
    assignedAt:   data.created_at,
  }
}

export interface RecordCompletionInput {
  contactId: string
  resourceId: string
  completedAt: string
  timeSpentMinutes: number
  retentionScore?: number
  brokerageId: string
}

export interface RecordCompletionOutput {
  progressId: string
  success: boolean
}

export async function recordCompletion(
  supabase: any,
  input: RecordCompletionInput
): Promise<RecordCompletionOutput> {
  // Upsert the customer's assignment row to completed. Pre-1043 used
  // contact_education_progress.lesson_key; now we identify by module_id.
  const { data, error } = await supabase
    .from("learning_assignments")
    .upsert({
      brokerage_id:   input.brokerageId,
      contact_id:     input.contactId,
      module_id:      input.resourceId,
      signal_source:  "self:completed",
      priority_score: 50,
      status:         "completed",
      completed_at:   input.completedAt,
    }, { onConflict: "contact_id,module_id" })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to record completion: ${error?.message}`)
  }

  await supabase.from("lifecycle_events").insert({
    brokerage_id: input.brokerageId,
    entity_type: "contact",
    entity_id: input.contactId,
    event_type: "education_completed",
    metadata: {
      module_id: input.resourceId,
    },
    created_at: new Date().toISOString(),
  })

  return {
    progressId: data.id,
    success:    true,
  }
}

// TOMBSTONE (orphan tranche 4): getPersonalizedLearningPath deleted. It was a
// stub that reported a raw completed-count as "completionPercentage", never a
// next resource, and 0 time remaining — fabricated shape, no honest signal. The
// survivors that do this job for real:
//   · getEducationPlan (this file, exported via lib/kernel/index.ts) — the
//     contact-side plan the portal renders (stage-aware lessons + progress);
//   · app/actions/ai-training-coaching.ts:generateLearningPath — the agent-side
//     personalized path, wired to the academy's learning-path panel.

export interface GenerateAIEducationInput {
  topic: string
  contentType: "video_script" | "article" | "quiz"
  tone: "professional" | "conversational"
  brokerageId: string
  createdBy: string
  /** Optional team scope. When set, team.bio_text + per-team brand voice
   *  override the brokerage defaults. */
  teamId?: string
  /** Optional milestone the lesson teaches; surfaces it in the
   *  milestone-gated panel + drives the customer's portal stream. */
  milestoneKey?: string
  /** Optional audience targeting (passed through to learning_modules). */
  audiencePersonas?: string[]
  audienceRoles?:    string[]
  stageTags?:        string[]
}

export interface GenerateAIEducationOutput {
  resourceId: string
  success: boolean
  /** Always 'pending_review' after migration 1049 — admin must approve. */
  status:    "pending_review"
  /** Brand-voice signals folded into the body draft. */
  brandVoiceApplied: {
    brokerageAbout: boolean
    brokerageBio:   boolean
    teamBio:        boolean
    brandVoice:     boolean
  }
}

export async function generateAIEducation(
  supabase: any,
  input: GenerateAIEducationInput
): Promise<GenerateAIEducationOutput> {
  // Resolve brand-voice context: brokerage about + bio, team bio, brand voice profile
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name, about_text, bio_text")
    .eq("id", input.brokerageId)
    .maybeSingle()

  let teamBio: string | null = null
  if (input.teamId) {
    const { data: team } = await supabase
      .from("teams")
      .select("name, bio_text")
      .eq("id", input.teamId)
      .maybeSingle()
    teamBio = (team?.bio_text as string | null) ?? null
  }

  // Brand voice profile lookup — prefer team > brokerage scope (post-1049
  // schema fix; brokerage_id + team_id columns now exist).
  let brandVoiceTone:      string | null = null
  let brandVoiceKeywords:  string[]      = []
  try {
    const { data: bv } = await supabase
      .from("brand_voice_profile")
      .select("tone, key_brand_messages, prohibited_words")
      .or(`team_id.eq.${input.teamId ?? "00000000-0000-0000-0000-000000000000"},brokerage_id.eq.${input.brokerageId}`)
      .order("team_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    brandVoiceTone     = (bv?.tone as string | null) ?? null
    brandVoiceKeywords = ((bv?.key_brand_messages as string[] | null) ?? []) as string[]
  } catch {
    // brand_voice_profile lookup is best-effort; failures don't block generation
  }

  const brokerageAbout = (brokerage?.about_text as string | null) ?? null
  const brokerageBio   = (brokerage?.bio_text   as string | null) ?? null
  const brokerageName  = (brokerage?.name       as string | null) ?? null

  // Fold brand-voice context into the draft body so an admin reviewer can
  // see what was used. Real AI generation upgrades this later — for now
  // we store the prompt context + a placeholder body that's brand-flavored.
  const contextBlock = [
    brokerageName  ? `Brokerage: ${brokerageName}`              : null,
    brokerageAbout ? `About: ${brokerageAbout}`                 : null,
    brokerageBio   ? `Bio: ${brokerageBio}`                     : null,
    teamBio        ? `Team bio: ${teamBio}`                     : null,
    brandVoiceTone ? `Brand voice: ${brandVoiceTone} tone`      : null,
    brandVoiceKeywords.length > 0 ? `Key messages: ${brandVoiceKeywords.join(", ")}` : null,
  ].filter(Boolean).join("\n")

  const placeholderBody = [
    `# ${input.topic}`,
    "",
    contextBlock ? `> Brand voice context applied during generation:\n> ${contextBlock.replace(/\n/g, "\n> ")}` : "",
    "",
    "AI-generated content — admin review required before publishing.",
  ].filter(Boolean).join("\n")

  // No-duplicate guard (owner: "no duplicates or noise"): if a near-identical
  // module already exists for this audience, return IT instead of authoring a
  // second — idempotent, no duplicate row.
  {
    const { findNearDuplicateModule } = await import("@/lib/education/dedup-guard")
    const dup = await findNearDuplicateModule(supabase, input.brokerageId, `AI: ${input.topic}`, input.audienceRoles ?? [])
    if (dup) {
      return {
        resourceId: dup.id,
        success: true,
        status: "pending_review",
        brandVoiceApplied: { brokerageAbout: false, brokerageBio: false, teamBio: false, brandVoice: false },
      }
    }
  }

  const channels = input.contentType.includes("video") ? ["video"] : ["article"]
  const { data, error } = await supabase
    .from("learning_modules")
    .insert({
      brokerage_id:      input.brokerageId,
      team_id:           input.teamId ?? null,
      authored_by:       input.createdBy,
      title:             `AI: ${input.topic}`,
      summary:           `Generated by AI education engine (${input.tone} tone)`,
      body:              placeholderBody,
      estimated_minutes: 5,
      channels,
      audience_roles:    input.audienceRoles ?? [],
      audience_personas: input.audiencePersonas ?? [],
      stage_tags:        input.stageTags ?? [],
      milestone_key:     input.milestoneKey ?? null,
      is_ai_generated:   true,
      status:            "pending_review",   // post-1049: admin must approve
    })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to generate AI education: ${error?.message}`)
  }

  return {
    resourceId: data.id,
    success:    true,
    status:     "pending_review",
    brandVoiceApplied: {
      brokerageAbout: !!brokerageAbout,
      brokerageBio:   !!brokerageBio,
      teamBio:        !!teamBio,
      brandVoice:     !!brandVoiceTone || brandVoiceKeywords.length > 0,
    },
  }
}

export interface GetProgressDashboardInput {
  brokerageId: string
}

export interface GetProgressDashboardOutput {
  totalEnrolled: number
  completionRate: number
  avgTimePerResource: number
}

export async function getProgressDashboard(
  supabase: any,
  input: GetProgressDashboardInput
): Promise<GetProgressDashboardOutput> {
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", input.brokerageId)

  const totalEnrolled = contacts?.length || 0

  // Post-1043: completion comes from learning_assignments where contact_id set.
  const { data: completions } = await supabase
    .from("learning_assignments")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .not("contact_id", "is", null)
    .eq("status", "completed")

  const completionRate = totalEnrolled > 0 ? Math.round(((completions?.length || 0) / totalEnrolled) * 100) : 0

  return {
    totalEnrolled,
    completionRate,
    avgTimePerResource: 0, // Schema doesn't track time spent
  }
}

export interface BulkAssignResourcesInput {
  resourceIds: string[]
  contactIds: string[]
  brokerageId: string
}

export interface BulkAssignResourcesOutput {
  assignedCount: number
  success: boolean
}

export async function bulkAssignResources(
  supabase: any,
  input: BulkAssignResourcesInput
): Promise<BulkAssignResourcesOutput> {
  // Post-1043: bulk-assign creates learning_assignments rows.
  // resourceIds are learning_modules.id values.
  const assignments = input.contactIds.flatMap((contactId) =>
    input.resourceIds.map((moduleId) => ({
      brokerage_id:   input.brokerageId,
      module_id:      moduleId,
      contact_id:     contactId,
      signal_source:  "bulk:assign",
      priority_score: 60,
      status:         "open",
    }))
  )

  // ON CONFLICT (contact_id, module_id) DO NOTHING — idempotent
  const { error } = await supabase
    .from("learning_assignments")
    .upsert(assignments, { onConflict: "contact_id,module_id", ignoreDuplicates: true })

  return {
    assignedCount: error ? 0 : assignments.length,
    success:       !error,
  }
}

export interface GetResourceUsageAnalyticsInput {
  resourceId: string
  brokerageId: string
}

export interface GetResourceUsageAnalyticsOutput {
  viewCount: number
  completionCount: number
  avgCompletionTime: number
}

export async function getResourceUsageAnalytics(
  supabase: any,
  input: GetResourceUsageAnalyticsInput
): Promise<GetResourceUsageAnalyticsOutput> {
  // Post-1043: analytics come from learning_assignments per module.
  const { data: progress } = await supabase
    .from("learning_assignments")
    .select("status, completed_at")
    .eq("module_id", input.resourceId)
    .eq("brokerage_id", input.brokerageId)

  const completed = progress?.filter((p: { status: string }) => p.status === "completed") || []

  return {
    viewCount:         progress?.length || 0,
    completionCount:   completed.length,
    avgCompletionTime: 0,
  }
}
