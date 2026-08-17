"use server"

// app/actions/portal-education.ts
// Server actions for portal education hub.
// Handles lesson feed retrieval and marking lessons as read.
//
// Previously getLessonFeed / markLessonRead / getLessonByKey ran with no
// auth check at all — any caller could enumerate the lesson feed for any
// contact and mark lessons "completed" on any contact's learning
// assignments. resolveEducationContext is a library helper that doesn't
// enforce caller access.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveEducationContext } from "@/lib/portal/resolve-education-context"
import { getEducationPlan, type EducationLesson, type AgeSegment } from "@/lib/kernel/education"
import { staticLessonModuleId, isUuid, bridgeStaticLessonCompletion } from "@/lib/portal/static-lesson-bridge"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import type { PortalView } from "@/lib/kernel/portal"
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"

// ─── Auth helper ──────────────────────────────────────────────────────────────
async function requireContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false }
> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false }
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false }
  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())
  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }
  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  // SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
  // (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","broker_owner"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }
  return { ok: false }
}

const EMPTY_FEED: LessonFeedResult = {
  spotlight: null,
  lessons: [],
  completedCount: 0,
  totalCount: 0,
  categories: [],
}

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
  const access = await requireContactAccess(contactId)
  if (!access.ok) return EMPTY_FEED

  const supabase = createServiceClient()

  // Resolve education context (lib helper — assumes caller has already
  // verified access, which we just did above)
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

  // Transform lessons to feed items.
  // Completion lives on learning_assignments.module_id (uuids). A static lesson's
  // durable identity is its DETERMINISTIC bridge module id, so map the string key
  // to that uuid before checking completion — see lib/portal/static-lesson-bridge.
  const feedItems: LessonFeedItem[] = plan.lessons.map(lesson => ({
    ...lesson,
    isCompleted: context.completedLessonKeys.includes(staticLessonModuleId(access.brokerageId, lesson.key)),
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
  /** Either a canonical learning_modules.id (uuid) or a STATIC lesson key
   *  ("buyer_pre_intro"). Static keys are bridged to a deterministic module id. */
  lessonKey: string
}

export async function markLessonRead(params: MarkLessonReadParams): Promise<{ success: boolean; error?: string }> {
  const { contactId, lessonKey } = params

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const service = createServiceClient()

  // Completion lives on learning_assignments.module_id — a uuid FK to learning_modules.
  try {
    if (isUuid(lessonKey)) {
      // Already a canonical module (e.g. an authored milestone module) — record directly.
      const { error: upsertError } = await service
        .from("learning_assignments")
        .upsert({
          brokerage_id:   access.brokerageId,
          module_id:      lessonKey,
          contact_id:     contactId,
          signal_source:  "self:portal_read",
          priority_score: 50,
          status:         "completed",
          completed_at:   new Date().toISOString(),
        }, { onConflict: "contact_id,module_id" })
      if (upsertError) {
        console.error("[PortalEducation] Error marking module read:", upsertError)
        return { success: false, error: "Failed to mark lesson as read" }
      }
    } else {
      // STATIC lesson key — materialize it as a canonical module (deterministic id)
      // and record completion against that uuid. Fixes the former FK/uuid corruption.
      const lesson = await getLessonByKey(contactId, lessonKey)
      if (!lesson) return { success: false, error: "Unknown lesson" }
      const bridged = await bridgeStaticLessonCompletion(service, {
        brokerageId: access.brokerageId,
        contactId,
        lesson: {
          key: lesson.key,
          title: lesson.title,
          description: lesson.description,
          milestoneKey: lesson.milestoneKey,
          estimatedMinutes: lesson.estimatedMinutes,
        },
      })
      if (!bridged) {
        console.error("[PortalEducation] Error bridging static lesson read:", lessonKey)
        return { success: false, error: "Failed to mark lesson as read" }
      }
    }
  } catch (err) {
    console.error("[PortalEducation] Exception marking lesson read:", err)
    return { success: false, error: "Failed to mark lesson as read" }
  }

  // Emit kernel event
  await processKernelEvent({
    event: KernelEvent.PORTAL_EDUCATION_VIEWED,
    entityType: "contact",
    entityId: contactId,
    brokerageId: access.brokerageId,
  }).catch(err => {
    console.error("[PortalEducation] Error emitting kernel event:", err)
  })

  return { success: true }
}

// ─── PORTAL EDUCATION COMPLETED → NOTIFY THE SUPERVISING AGENT ───────────────

/**
 * Tell the contact's supervising agent that the client has finished every portal
 * lesson.
 *
 * MOVED HERE FROM THE CLIENT. `app/portal/[contactId]/learn/learn-client.tsx`
 * used to write this `notifications` row itself, from the browser, on the
 * contact's own session, and it was broken twice over:
 *
 *   1. IT WROTE AN `agents.id` INTO `notifications.user_id`. The prop it used is
 *      `contact.agent_id`, and `contacts.agent_id` is an `agents.id` (migration
 *      111), while `notifications.user_id` is `REFERENCES users(id)` — DISJOINT
 *      spaces. Every one of these inserts was refused 23503, and the call site
 *      was `.then(() => {}).catch(() => {})`, which catches nothing at all
 *      because supabase-js RESOLVES a refused query. The agent has never been
 *      told, and nothing anywhere recorded that.
 *   2. IT COULD NOT HONESTLY STAMP A TENANT. A client component has no
 *      trustworthy brokerage to stamp — anything it sent would be a prop, and
 *      stamping the wrong one is the same dark bell as stamping none.
 *
 * Both are answered by resolving server-side, from the RECORD the row is filed
 * against: `requireContactAccess` already reads the contact and yields its
 * brokerage, and the agents row supplies the recipient's users.id. The tenant is
 * then the RECIPIENT's `users.brokerage_id` — the one resolver, and the exact
 * value app/api/dashboard/badge-counts/route.ts:62 compares against.
 */
export async function notifyPortalEducationCompleted(params: {
  contactId: string
  contactFirstName?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const service = createServiceClient()

  // The supervising agent comes from the CONTACT record, not from the caller —
  // a portal contact is not an agent and must not name one.
  const { data: contactRow, error: contactError } = await service
    .from("contacts")
    .select("agent_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (contactError) {
    console.error("[PortalEducation] notifyPortalEducationCompleted: contacts lookup refused:", contactError.message)
    return { success: false, error: "Could not resolve the supervising agent" }
  }
  const agentId = (contactRow as { agent_id: string | null } | null)?.agent_id ?? null
  if (!agentId) return { success: false, error: "This contact has no supervising agent" }

  const recipient = await resolveAgentRecipient(service, agentId)
  if (!recipient.ok) {
    console.error(`[PortalEducation] notifyPortalEducationCompleted: ${recipient.reason}`)
    return { success: false, error: "Could not resolve the supervising agent" }
  }
  if (!recipient.userId || !recipient.brokerageId) {
    console.error(
      `[PortalEducation] notifyPortalEducationCompleted: agent ${agentId} resolves to no user or no brokerage — completion notification NOT written rather than written where the bell cannot count it`,
    )
    return { success: false, error: "Could not resolve the supervising agent" }
  }

  // Idempotent: one completion notice per contact. The dedupe read is
  // tenant-scoped for the same reason the write is — an untenanted or foreign
  // prior row must not suppress this one — and destructures `error`, because a
  // refused dedupe read that arrives as "no prior row" would send a duplicate.
  const { data: prior, error: priorError } = await service
    .from("notifications")
    .select("id")
    .eq("brokerage_id", recipient.brokerageId)
    .eq("user_id", recipient.userId)
    .eq("type", "portal_education_completed")
    .eq("entity_id", params.contactId)
    .limit(1)
    .maybeSingle()
  if (priorError) {
    console.error("[PortalEducation] notifyPortalEducationCompleted: dedupe read refused:", priorError.message)
    return { success: false, error: "Could not check for a prior notification" }
  }
  if (prior) return { success: true }

  const { error: insertError } = await service.from("notifications").insert({
    user_id: recipient.userId,
    brokerage_id: recipient.brokerageId,
    type: "portal_education_completed",
    title: `${params.contactFirstName ?? "Your client"} completed all portal lessons`,
    entity_type: "contact",
    entity_id: params.contactId,
  })
  if (insertError) {
    console.error("[PortalEducation] notifyPortalEducationCompleted: insert refused:", insertError.message)
    return { success: false, error: "Failed to notify the agent" }
  }

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
