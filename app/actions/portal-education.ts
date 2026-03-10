"use server"

// app/actions/portal-education.ts
// Server actions for portal education hub.
// Handles lesson feed retrieval and marking lessons as read.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveEducationContext } from "@/lib/portal/resolve-education-context"
import { getEducationPlan, type EducationLesson, type AgeSegment } from "@/lib/kernel/education"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import type { PortalView } from "@/lib/kernel/portal"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface LessonFeedItem extends EducationLesson {
  isCompleted: boolean
  isMilestoneRelevant: boolean
  category: string
}

export interface LessonFeedResult {
  spotlight: LessonFeedItem | null
  lessons: LessonFeedItem[]
  completedCount: number
  totalCount: number
  categories: string[]
}

// ─── CATEGORY MAPPING ─────────────────────────────────────────────────────────

const BUYER_CATEGORIES: Record<string, string> = {
  overview: "Your Journey",
  financing: "Financial Readiness",
  credit: "Financial Readiness",
  preapproval: "Financial Readiness",
  offer: "The Buying Process",
  inspection: "The Buying Process",
  appraisal: "The Buying Process",
  closing: "The Buying Process",
  search: "Home Search Tips",
  showings: "Home Search Tips",
  movein: "What to Expect",
  utilities: "What to Expect",
  maintenance: "What to Expect",
  quiz: "Knowledge Checks",
  assistance: "Financial Readiness",
  legal: "The Buying Process",
}

const SELLER_CATEGORIES: Record<string, string> = {
  overview: "The Selling Process",
  pricing: "Pricing Strategy",
  preparation: "Preparing Your Home",
  staging: "Preparing Your Home",
  disclosures: "The Selling Process",
  offer: "Negotiation & Offers",
  negotiation: "Negotiation & Offers",
  inspection: "The Selling Process",
  appraisal: "The Selling Process",
  closing: "Closing & Moving Out",
  listing: "The Selling Process",
  showings: "The Selling Process",
  quiz: "Knowledge Checks",
  legal: "The Selling Process",
}

const LIFETIME_CATEGORIES: Record<string, string> = {
  overview: "Home Ownership Basics",
  maintenance: "Maintenance Calendar",
  equity: "Building Equity",
  tax: "Tax Benefits & Deductions",
  refinance: "When to Refinance",
  insurance: "Home Ownership Basics",
  default: "Home Ownership Basics",
}

function getCategoryForLesson(lesson: EducationLesson, portalView: PortalView): string {
  const tag = lesson.tags[0] || "overview"
  
  if (portalView === "buyer") {
    return BUYER_CATEGORIES[tag] || "Your Journey"
  }
  if (portalView === "seller") {
    return SELLER_CATEGORIES[tag] || "The Selling Process"
  }
  return LIFETIME_CATEGORIES[tag] || "Home Ownership Basics"
}

// ─── CATEGORY ORDER ───────────────────────────────────────────────────────────

const BUYER_CATEGORY_ORDER = [
  "Your Journey",
  "The Buying Process",
  "Financial Readiness",
  "Home Search Tips",
  "What to Expect",
  "Knowledge Checks",
]

const SELLER_CATEGORY_ORDER = [
  "Preparing Your Home",
  "Pricing Strategy",
  "The Selling Process",
  "Negotiation & Offers",
  "Closing & Moving Out",
  "Knowledge Checks",
]

const LIFETIME_CATEGORY_ORDER = [
  "Home Ownership Basics",
  "Maintenance Calendar",
  "Building Equity",
  "Tax Benefits & Deductions",
  "When to Refinance",
]

function getCategoryOrder(portalView: PortalView): string[] {
  if (portalView === "buyer") return BUYER_CATEGORY_ORDER
  if (portalView === "seller") return SELLER_CATEGORY_ORDER
  return LIFETIME_CATEGORY_ORDER
}

// ─── GET LESSON FEED ──────────────────────────────────────────────────────────

export async function getLessonFeed(contactId: string): Promise<LessonFeedResult> {
  const supabase = await createClient()

  // Resolve education context
  const context = await resolveEducationContext(supabase, contactId)

  // Map portal view to journey type
  const journeyType = context.portalView === "seller" ? "seller" : "buyer"
  const journeyPhase = context.currentMilestone ? "active" : "pre"

  // Get education plan from kernel
  const plan = await getEducationPlan({
    journeyType,
    journeyPhase,
    persona: "other", // Will be resolved by contactId
    ageSegment: context.ageSeg,
    milestoneKey: context.currentMilestone ?? undefined,
    contactId,
  })

  // Transform lessons to feed items
  const feedItems: LessonFeedItem[] = plan.lessons.map(lesson => ({
    ...lesson,
    isCompleted: context.completedLessonKeys.includes(lesson.key),
    isMilestoneRelevant: lesson.milestoneKey === context.currentMilestone,
    category: getCategoryForLesson(lesson, context.portalView),
  }))

  // Sort: milestone-relevant first, then by category order, then by order
  const categoryOrder = getCategoryOrder(context.portalView)
  const sortedItems = [...feedItems].sort((a, b) => {
    // Completed items go to the end
    if (a.isCompleted !== b.isCompleted) {
      return a.isCompleted ? 1 : -1
    }
    // Milestone-relevant first
    if (a.isMilestoneRelevant !== b.isMilestoneRelevant) {
      return a.isMilestoneRelevant ? -1 : 1
    }
    // Then by category order
    const aCatIndex = categoryOrder.indexOf(a.category)
    const bCatIndex = categoryOrder.indexOf(b.category)
    if (aCatIndex !== bCatIndex) {
      return aCatIndex - bCatIndex
    }
    // Finally by lesson order
    return a.order - b.order
  })

  // Spotlight: first unread lesson most relevant to current milestone
  const spotlight = sortedItems.find(item => !item.isCompleted) ?? null

  // Remove spotlight from main list
  const lessons = spotlight 
    ? sortedItems.filter(item => item.key !== spotlight.key)
    : sortedItems

  // Get unique categories in order
  const categories = [...new Set(sortedItems.map(item => item.category))]
    .sort((a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b))

  const completedCount = feedItems.filter(item => item.isCompleted).length
  const totalCount = feedItems.length

  return {
    spotlight,
    lessons,
    completedCount,
    totalCount,
    categories,
  }
}

// ─── MARK LESSON READ ─────────────────────────────────────────────────────────

export interface MarkLessonReadParams {
  contactId: string
  lessonKey: string
}

export async function markLessonRead(params: MarkLessonReadParams): Promise<{ success: boolean; error?: string }> {
  const { contactId, lessonKey } = params
  const supabase = await createClient()
  const service = createServiceClient()

  // Validate access - contact must exist
  const { data: contact, error: contactError } = await service
    .from("contacts")
    .select("id, agent_id, brokerage_id")
    .eq("id", contactId)
    .single()

  if (contactError || !contact) {
    return { success: false, error: "Contact not found" }
  }

  // Upsert educational_moments
  const { error: upsertError } = await service
    .from("educational_moments")
    .upsert({
      contact_id: contactId,
      lesson_key: lessonKey,
      read_at: new Date().toISOString(),
      content_type: "lesson",
    }, {
      onConflict: "contact_id,lesson_key",
    })

  if (upsertError) {
    console.error("[PortalEducation] Error marking lesson read:", upsertError)
    return { success: false, error: "Failed to mark lesson as read" }
  }

  // Emit kernel event
  await processKernelEvent({
    eventType: KernelEvent.PORTAL_EDUCATION_VIEWED,
    entityType: "contact",
    entityId: contactId,
    agentId: contact.agent_id,
    brokerageId: contact.brokerage_id,
    metadata: { lessonKey },
  }).catch(err => {
    console.error("[PortalEducation] Error emitting kernel event:", err)
  })

  return { success: true }
}

// ─── GET LESSON BY KEY ────────────────────────────────────────────────────────

export async function getLessonByKey(
  contactId: string,
  lessonKey: string
): Promise<LessonFeedItem | null> {
  const feed = await getLessonFeed(contactId)
  
  // Check spotlight
  if (feed.spotlight?.key === lessonKey) {
    return feed.spotlight
  }
  
  // Check lessons
  return feed.lessons.find(lesson => lesson.key === lessonKey) ?? null
}
