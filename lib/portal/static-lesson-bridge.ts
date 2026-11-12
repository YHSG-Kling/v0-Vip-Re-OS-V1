// lib/portal/static-lesson-bridge.ts
// ─────────────────────────────────────────────────────────────────────────────
// STATIC-LESSON → CANONICAL BRIDGE (owner: "close the loops" — the flagged static
// customer-lesson drift). The customer portal's /learn feed is built from an
// in-code lesson catalog (lib/kernel/education.ts BUYER_/SELLER_ lessons) whose
// keys are STRINGS ("buyer_pre_intro", …). Completion, however, lives on
// learning_assignments.module_id — a NOT-NULL uuid with a FOREIGN KEY to
// learning_modules.id. markLessonRead used to write the raw string key into that
// column, which fails BOTH the uuid type check AND the FK on every customer
// lesson-read, and the read-back (completedLessonKeys = module uuids) could never
// match a static string key — so static-lesson completion was broken end to end.
//
// This bridge closes the loop WITHOUT a mass migration or a content regression:
// the first time a customer completes a static lesson, it is materialized as a
// real learning_modules row under a DETERMINISTIC id (uuid v5 of
// `${brokerageId}:${lessonKey}`), so the same lesson always maps to the same
// module across the write path (markLessonRead) and the read path (getLessonFeed).
// The FK is satisfied, completion records durably, and the read-back matches.
//
// Bridge modules carry the STATIC_BRIDGE_TAG in gap_tags so the milestone-gated
// customer feed EXCLUDES them — the lesson keeps rendering on /learn (its origin),
// and does not also appear in the portal-home education panel. One canonical rail,
// no duplicate surface.

import { v5 as uuidv5 } from "uuid"

/** Fixed namespace uuid — makes the static-lesson → module id stable and reproducible
 *  across the write and read paths. (Any constant valid uuid works as a v5 namespace.) */
const STATIC_LESSON_NAMESPACE = "6f3b0c2a-1e4d-4a6b-8c9d-0e1f2a3b4c5d"

/** gap_tags marker identifying a bridged static lesson (excluded from the milestone panel). */
export const STATIC_BRIDGE_TAG = "static_bridge"

/** PURE: the deterministic learning_modules.id for a static lesson in a brokerage. */
export function staticLessonModuleId(brokerageId: string, lessonKey: string): string {
  return uuidv5(`${brokerageId}:${lessonKey}`, STATIC_LESSON_NAMESPACE)
}

/** PURE: is a string a uuid (an already-canonical module id) vs a static lesson key? */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

type Svc = { from: (t: string) => any }

/** The minimal lesson shape the bridge needs to materialize a module. */
export interface BridgeLesson {
  key: string
  title: string
  description: string
  milestoneKey: string | null
  estimatedMinutes: number
}

/**
 * Materialize a static lesson as a canonical published customer learning_modules row
 * (idempotent by deterministic id) and record the contact's completion on
 * learning_assignments against that uuid. Returns the module id, or null on failure.
 */
export async function bridgeStaticLessonCompletion(
  svc: Svc,
  params: { brokerageId: string; contactId: string; lesson: BridgeLesson },
): Promise<string | null> {
  const moduleId = staticLessonModuleId(params.brokerageId, params.lesson.key)

  // 1. Ensure the bridge module exists (deterministic id ⇒ upsert is idempotent).
  const { error: modErr } = await svc.from("learning_modules").upsert({
    id: moduleId,
    brokerage_id: params.brokerageId,
    title: params.lesson.title,
    summary: params.lesson.description,
    body: params.lesson.description,
    audience_roles: ["customer"],
    status: "published",
    is_ai_generated: false,
    gap_tags: [STATIC_BRIDGE_TAG],
    milestone_key: params.lesson.milestoneKey,
    estimated_minutes: params.lesson.estimatedMinutes,
    channels: ["portal"],
  }, { onConflict: "id" })
  if (modErr) return null

  // 2. Record the completion against the real uuid (FK now satisfied).
  const { error: asgErr } = await svc.from("learning_assignments").upsert({
    brokerage_id: params.brokerageId,
    module_id: moduleId,
    contact_id: params.contactId,
    signal_source: "self:portal_read",
    priority_score: 50,
    status: "completed",
    completed_at: new Date().toISOString(),
  }, { onConflict: "contact_id,module_id" })
  if (asgErr) return null

  return moduleId
}
