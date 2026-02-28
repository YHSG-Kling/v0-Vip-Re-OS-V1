// lib/kernel/portal.ts
// LAYER 1 — Portal-facing education functions.
// Provides lifetime track display for the client portal.
// All functions require a contactId; reads are contact-scoped.
// No side effects beyond writing activity progress records.

import { createClient } from "@/lib/supabase/server"
import { getEducationDelivery, getEducationPlan } from "./education"
import type { AgeSegment, EducationLesson, EducationPlan } from "./education"

// ─── LIFETIME TRACK ───────────────────────────────────────────────────────────

export interface LessonProgress {
  lessonKey: string
  status: "not_started" | "in_progress" | "completed"
  startedAt?: string
  completedAt?: string
  /** Score 0-100, only set when format === 'quiz' and completed */
  quizScore?: number
}

export interface LifetimeTrack {
  contactId: string
  /** Every plan the contact has ever been enrolled in, in chronological order */
  plans: Array<{
    enrolledAt: string
    journeyType: "buyer" | "seller"
    journeyPhase: "pre" | "active"
    persona: string
    ageSegment: AgeSegment
    lessons: EducationLesson[]
    progress: LessonProgress[]
    completionPercent: number
  }>
  /** Aggregated stats across all plans */
  totals: {
    lessonsCompleted: number
    lessonsTotal: number
    quizzesPassed: number
    lifetimeCompletionPercent: number
  }
}

// ─── MARK LESSON PROGRESS ─────────────────────────────────────────────────────

export interface MarkLessonParams {
  contactId: string
  brokerageId: string
  lessonKey: string
  status: "in_progress" | "completed"
  /** Required when status === 'completed' and lesson format === 'quiz' */
  quizScore?: number
}

/**
 * Records lesson progress for a contact by writing to the activities table.
 * Uses activity_type = 'education' and encodes lesson data in notes as JSON.
 * Idempotent — if a completed record already exists it will not be downgraded.
 */
export async function markLessonProgress(params: MarkLessonParams): Promise<void> {
  const supabase = await createClient()

  // Check for existing completed record — never downgrade a completed lesson
  const { data: existing } = await supabase
    .from("activities")
    .select("id, status, notes")
    .eq("contact_id", params.contactId)
    .eq("activity_type", "education")
    .eq("title", params.lessonKey)
    .maybeSingle()

  if (existing?.status === "completed") {
    return
  }

  const notePayload = JSON.stringify({
    lessonKey: params.lessonKey,
    quizScore: params.quizScore ?? null,
  })

  if (existing) {
    await supabase
      .from("activities")
      .update({
        status: params.status,
        notes: notePayload,
        completed_at: params.status === "completed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
  } else {
    await supabase.from("activities").insert({
      brokerage_id: params.brokerageId,
      contact_id: params.contactId,
      activity_type: "education",
      title: params.lessonKey,
      status: params.status,
      notes: notePayload,
      entity_type: "contact",
      scheduled_at: new Date().toISOString(),
      completed_at: params.status === "completed" ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }
}

// ─── GET LESSON PROGRESS ──────────────────────────────────────────────────────

async function getLessonProgressForContact(
  contactId: string,
  lessonKeys: string[],
): Promise<LessonProgress[]> {
  const supabase = await createClient()

  if (lessonKeys.length === 0) return []

  const { data: rows } = await supabase
    .from("activities")
    .select("title, status, notes, scheduled_at, completed_at")
    .eq("contact_id", contactId)
    .eq("activity_type", "education")
    .in("title", lessonKeys)

  return lessonKeys.map((key) => {
    const row = rows?.find((r) => r.title === key)
    if (!row) {
      return { lessonKey: key, status: "not_started" as const }
    }

    let quizScore: number | undefined
    try {
      const parsed = JSON.parse(row.notes ?? "{}")
      if (typeof parsed.quizScore === "number") quizScore = parsed.quizScore
    } catch {
      // notes not JSON — ignore
    }

    return {
      lessonKey: key,
      status: (row.status ?? "not_started") as LessonProgress["status"],
      startedAt: row.scheduled_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      quizScore,
    }
  })
}

// ─── LIFETIME TRACK ───────────────────────────────────────────────────────────

/**
 * Returns the complete lifetime education track for a contact in the portal.
 *
 * Reconstructs every journey the contact has participated in by reading
 * lifecycle_events where event_type matches 'lifecycle.journey.*' and
 * joins education progress from activities.
 *
 * If no prior journey events exist, synthesises a single pre-journey buyer
 * plan as the default starting point.
 */
export async function getLifetimeEducationTrack(contactId: string): Promise<LifetimeTrack> {
  const supabase = await createClient()

  // ── 1. Read contact base data ────────────────────────────────────────────────
  const { data: contact } = await supabase
    .from("contacts")
    .select("contact_persona, contact_type, status, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()

  const persona = contact?.contact_persona ?? "other"
  const journeyType: "buyer" | "seller" =
    contact?.contact_type === "seller" ? "seller" : "buyer"

  // ── 2. Read journey lifecycle events for this contact ────────────────────────
  const { data: journeyEvents } = await supabase
    .from("lifecycle_events")
    .select("event_type, metadata, created_at")
    .eq("entity_type", "buyer")
    .eq("entity_id", contactId)
    .or("event_type.like.lifecycle.journey.%")
    .order("created_at", { ascending: true })

  // ── 3. Derive plans from journey events (or default if none) ─────────────────
  type PlanSeed = {
    enrolledAt: string
    journeyType: "buyer" | "seller"
    journeyPhase: "pre" | "active"
    persona: string
    ageSegment: AgeSegment
    milestoneKey?: string
  }

  let planSeeds: PlanSeed[] = []

  if (!journeyEvents || journeyEvents.length === 0) {
    // No recorded journey — show the pre-journey plan as starting content
    planSeeds = [
      {
        enrolledAt: new Date().toISOString(),
        journeyType,
        journeyPhase: "pre",
        persona,
        ageSegment: "30-50",
      },
    ]
  } else {
    for (const evt of journeyEvents) {
      const meta = evt.metadata as Record<string, any> | null
      planSeeds.push({
        enrolledAt: evt.created_at,
        journeyType: (meta?.journey_type as "buyer" | "seller") ?? journeyType,
        journeyPhase: (meta?.journey_phase as "pre" | "active") ?? "pre",
        persona: meta?.persona ?? persona,
        ageSegment: (meta?.age_segment as AgeSegment) ?? "30-50",
        milestoneKey: meta?.milestone_key,
      })
    }
  }

  // ── 4. Build each plan with progress ─────────────────────────────────────────
  let totalCompleted = 0
  let totalLessons = 0
  let quizzesPassed = 0

  const plans: LifetimeTrack["plans"] = []

  for (const seed of planSeeds) {
    const plan: EducationPlan = await getEducationPlan({
      journeyType: seed.journeyType,
      journeyPhase: seed.journeyPhase,
      persona: seed.persona,
      ageSegment: seed.ageSegment,
      milestoneKey: seed.milestoneKey,
      contactId,
    })

    const lessonKeys = plan.lessons.map((l) => l.key)
    const progress = await getLessonProgressForContact(contactId, lessonKeys)

    const completed = progress.filter((p) => p.status === "completed").length
    const completionPercent = lessonKeys.length > 0 ? Math.round((completed / lessonKeys.length) * 100) : 0

    totalCompleted += completed
    totalLessons += lessonKeys.length
    quizzesPassed += progress.filter(
      (p) => p.status === "completed" && p.quizScore !== undefined && p.quizScore >= 70,
    ).length

    plans.push({
      enrolledAt: seed.enrolledAt,
      journeyType: seed.journeyType,
      journeyPhase: seed.journeyPhase,
      persona: seed.persona,
      ageSegment: seed.ageSegment,
      lessons: plan.lessons,
      progress,
      completionPercent,
    })
  }

  return {
    contactId,
    plans,
    totals: {
      lessonsCompleted: totalCompleted,
      lessonsTotal: totalLessons,
      quizzesPassed,
      lifetimeCompletionPercent:
        totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0,
    },
  }
}
