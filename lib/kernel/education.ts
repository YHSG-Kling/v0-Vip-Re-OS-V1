// lib/kernel/education.ts
// LAYER 1 — Education delivery and plan resolution.
// Reads from journey_blueprints, transaction_milestones, and contacts.
// Writes progress to activities (activity_type = 'education').
// No side effects beyond DB writes; does NOT log compliance events.

import { createClient } from "@/lib/supabase/server"
import type { EducationFormat, JourneyPhase, Persona } from "./types"

// ─── AGE SEGMENT ──────────────────────────────────────────────────────────────

export type AgeSegment = "18-30" | "30-50" | "50-65" | "65+"

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

/** Derive cohort from a numeric age. Pure utility, no DB access. */
export function generationalCohortFromAge(age: number | null | undefined): GenerationalCohort {
  if (age == null || age <= 0 || !Number.isFinite(age)) return "unknown"
  if (age < 30)  return "gen_z"
  if (age < 46)  return "millennial"
  if (age < 62)  return "gen_x"
  if (age < 80)  return "boomer"
  return "silent"
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
        .select("milestone_name")
        .eq("transaction_id", tx.id)
        .eq("status", "pending")
        .order("target_date", { ascending: true })
        .limit(1)
        .maybeSingle()

      if (milestone?.milestone_name) {
        resolvedMilestoneKey = milestone.milestone_name
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
  contentType: "video" | "article" | "interactive" | "assessment"
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
      case "article":       return ["article"]
      case "interactive":   return ["quiz"]
      case "assessment":    return ["quiz"]
      default:              return ["article"]
    }
  })()

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
    contact_id: input.contactId,
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

export interface GetPersonalizedLearningPathInput {
  contactId: string
  brokerageId: string
}

export interface GetPersonalizedLearningPathOutput {
  nextResource?: { id: string; title: string; estimatedMinutes: number }
  completionPercentage: number
  estimatedTimeRemaining: number
}

export async function getPersonalizedLearningPath(
  supabase: any,
  input: GetPersonalizedLearningPathInput
): Promise<GetPersonalizedLearningPathOutput> {
  // Post-1043: completed modules come from learning_assignments.
  const { data: progress } = await supabase
    .from("learning_assignments")
    .select("module_id")
    .eq("contact_id", input.contactId)
    .eq("status", "completed")

  const completedIds = new Set(progress?.map((p: { module_id: string }) => p.module_id) || [])

  return {
    nextResource: undefined,
    completionPercentage:   completedIds.size,
    estimatedTimeRemaining: 0,
  }
}

export interface GenerateAIEducationInput {
  topic: string
  contentType: "video_script" | "article" | "quiz"
  tone: "professional" | "conversational"
  brokerageId: string
  createdBy: string
}

export interface GenerateAIEducationOutput {
  resourceId: string
  success: boolean
}

export async function generateAIEducation(
  supabase: any,
  input: GenerateAIEducationInput
): Promise<GenerateAIEducationOutput> {
  // Store generated content as a learning_module (canonical store)
  const channels = input.contentType.includes("video") ? ["video"] : ["article"]
  const { data, error } = await supabase
    .from("learning_modules")
    .insert({
      brokerage_id:      input.brokerageId,
      authored_by:       input.createdBy,
      title:             `AI: ${input.topic}`,
      summary:           "Generated by AI education engine",
      body:              "AI-generated content",
      estimated_minutes: 5,
      channels,
      is_ai_generated:   true,
      status:            "published",
      published_at:      new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to generate AI education: ${error?.message}`)
  }

  return {
    resourceId: data.id,
    success: true,
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
