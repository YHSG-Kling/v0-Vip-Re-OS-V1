/**
 * lib/content-guardian/index.ts
 *
 * Unified content pipeline:
 *   1. Check content against BrandVoice rules (prohibited words, tone)
 *   2. Scan for fair housing violations
 *   3. Submit flagged content to content_approvals for admin review
 *   4. Return content + violation metadata
 *
 * Wire into every AI content generation route.
 */

import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { createServiceClient } from "@/lib/supabase/service"
import { detectFairHousingViolations as detectCanonicalFairHousing } from "@/lib/compliance-rules/fair-housing-patterns"

export type ContentType =
  | "listing_description"
  | "email"
  | "social_post"
  | "blog"
  | "video_script"

export interface GuardContentParams {
  content: string
  agentId: string
  brokerageId: string
  contentType: ContentType
  teamId?: string
  /**
   * The uuid of the entity this text belongs to, WHEN IT ALREADY EXISTS —
   * written straight to `approval_items.item_id` so the reviewer can open the
   * thing that was flagged. Omit it when the content has not been persisted yet
   * and use `attachApprovalSubject` after it has: see the ordering note below.
   */
  subjectId?: string
}

export interface GuardContentResult {
  content: string
  violations: string[]
  notes: string[]
  flagged: boolean
  brandVoiceChecked: boolean
  persistenceError?: boolean
  /**
   * The `approval_items` row this scan raised, when it raised one. NULL when the
   * content was clean, or when the row could not be written. Callers that persist
   * the entity AFTER scanning pass this back to `attachApprovalSubject`.
   */
  approvalItemId?: string | null
}

// Fair-Housing detection is single-sourced from the canonical pattern set
// (lib/compliance-rules/fair-housing-patterns.ts) so this content pipeline and the
// messaging/dispatch gates can never drift. content-guardian's former private list has
// been folded INTO the canonical set (familial-status, good-schools, exclusive, handicap).
function detectFairHousingViolations(text: string): string[] {
  return detectCanonicalFairHousing(text).map((r) => `Fair housing risk: "${r.phrase}" (${r.reference})`)
}

// Map content type to brand voice params
function contentTypeToJourney(ct: ContentType): "buyer" | "seller" {
  return ct === "email" ? "buyer" : "seller"
}

/**
 * ─── THE ORDERING PROBLEM, AND THE RULING ON IT (wave 14) ────────────────────
 *
 * `approval_items.item_id` is READ by the unified approval queue
 * (lib/kernel/approval-queue-aggregator.ts:361, rendered at :581 as
 * `"<item_type> — <item_id>"`) so a reviewer can open the flagged thing. This
 * function is the table's only writer and never named the column, so every
 * flagged item reached the queue as `"video_script — "`: a reviewer told
 * something is wrong, with no way to find out WHAT.
 *
 * There were two ways to close it, and they are not equivalent:
 *
 *   (a) SCAN AFTER PERSISTENCE. The entity would already have an id, so the
 *       insert could carry it. REJECTED. It inverts the owner's compliance-first
 *       ruling: the flagged text would be written into the listing / marketing /
 *       script table BEFORE the fair-housing scan runs, and every consumer that
 *       reads those tables — the MLS push, the campaign sender — would be able to
 *       pick it up in the window between. "Publish, then check" is not a
 *       compliance pipeline.
 *
 *   (b) CARRY THE ID BACK AND STAMP IT.  CHOSEN. The scan stays exactly where it
 *       is, first. Callers that ALREADY hold the entity id (lib/kernel/listings.ts
 *       generates against a loaded listing row) pass `subjectId` and the insert
 *       names it directly — no second write at all. Callers that generate text
 *       and persist afterwards (app/actions/ai-listing-intake.ts) get the
 *       `approvalItemId` back and call `attachApprovalSubject` once the row
 *       exists.
 *
 * The residual window under (b) is a flagged item that is briefly unlinked, which
 * is the honest state: at that instant there genuinely is no entity to link to.
 * Under (a) the window is a NON-COMPLIANT ENTITY THAT IS ALREADY READABLE. Those
 * are not the same risk.
 */
export async function guardContent(params: GuardContentParams): Promise<GuardContentResult> {
  const { content, agentId, brokerageId, contentType, teamId, subjectId } = params
  const violations: string[] = []
  const notes: string[] = []
  let brandVoiceChecked = false

  // 1. Brand voice check
  try {
    const bvResult = await applyBrandVoice({
      content,
      brokerageId,
      teamId,
      actorUserId: agentId,
      actorRole: "agent",
      journeyType: contentTypeToJourney(contentType),
      persona: "professional",
      messageType: contentType,
    })
    if (bvResult.violations?.length) violations.push(...bvResult.violations)
    if (bvResult.notes?.length) notes.push(...bvResult.notes)
    brandVoiceChecked = true
  } catch {
    // Non-fatal
  }

  // 2. Fair housing scan
  violations.push(...detectFairHousingViolations(content))

  // 3. Submit to content_approvals if violations found
  const flagged = violations.length > 0
  let persistenceError: boolean | undefined
  let approvalItemId: string | null = null
  if (flagged) {
    try {
      const supabase = createServiceClient()
      const { data: inserted, error: insertError } = await supabase
        .from("approval_items")
        .insert({
          brokerage_id: brokerageId,
          agent_id: agentId,
          item_type: contentType,
          // The link the reviewer opens. NULL when the caller has no entity yet —
          // and NULL is the honest value for that moment, not a placeholder.
          item_id: subjectId ?? null,
          status: "pending",
          // pass 14: content_approvals was a PHANTOM table — flagged content rides
          // the real approval_items queue; the violations + excerpt live in
          // review_notes for the reviewer.
          review_notes: JSON.stringify({ violations, excerpt: content.slice(0, 500) }),
        })
        .select("id")
        .single()
      if (insertError) {
        console.error("[ContentGuardian] approval_items insert failed:", insertError)
        persistenceError = true
      } else {
        approvalItemId = (inserted?.id as string | null) ?? null
      }
    } catch (err) {
      console.error("[ContentGuardian] approval_items insert threw:", err)
      persistenceError = true
    }
  }

  return {
    content, violations, notes, flagged, brandVoiceChecked, approvalItemId,
    ...(persistenceError ? { persistenceError } : {}),
  }
}

/**
 * Stamp the flagged item's SUBJECT once the entity it describes exists.
 *
 * The second half of ruling (b) above. Called with the `approvalItemId`
 * `guardContent` returned and the id of the row the caller has just persisted —
 * so a reviewer opening `"listing_description — <uuid>"` in the approval queue
 * lands on the actual record instead of a dangling em-dash.
 *
 * Deliberately tolerant of both arguments being absent: the overwhelmingly common
 * case is content that was NOT flagged, and a caller should be able to write
 * `await attachApprovalSubject(res.approvalItemId, row?.id)` unconditionally
 * rather than guarding every call site (a guard each caller could get wrong is
 * how the id gets dropped again).
 *
 * NEVER throws. The entity is already saved by the time this runs; failing the
 * caller's whole operation because a review LINK could not be stamped would turn
 * a cosmetic gap into a lost listing.
 */
export async function attachApprovalSubject(
  approvalItemId: string | null | undefined,
  subjectId: string | null | undefined,
): Promise<boolean> {
  if (!approvalItemId || !subjectId) return false
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("approval_items")
      .update({ item_id: subjectId })
      .eq("id", approvalItemId)
      // Only ever fills a BLANK. A reviewer's queue entry that already points
      // somewhere must not be repointed by a later generation run.
      .is("item_id", null)
    if (error) {
      // Read, never swallowed — supabase-js RESOLVES refusals.
      console.error("[ContentGuardian] approval_items subject stamp failed:", error)
      return false
    }
    return true
  } catch (err) {
    console.error("[ContentGuardian] approval_items subject stamp threw:", err)
    return false
  }
}
