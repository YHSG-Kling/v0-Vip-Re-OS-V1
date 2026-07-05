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
}

export interface GuardContentResult {
  content: string
  violations: string[]
  notes: string[]
  flagged: boolean
  brandVoiceChecked: boolean
  persistenceError?: boolean
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

export async function guardContent(params: GuardContentParams): Promise<GuardContentResult> {
  const { content, agentId, brokerageId, contentType, teamId } = params
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
  if (flagged) {
    try {
      const supabase = createServiceClient()
      const { error: insertError } = await supabase.from("content_approvals").insert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        content_type: contentType,
        original_content: content,
        violations: violations,
        status: "pending",
      })
      if (insertError) {
        console.error("[ContentGuardian] content_approvals insert failed:", insertError)
        persistenceError = true
      }
    } catch (err) {
      console.error("[ContentGuardian] content_approvals insert threw:", err)
      persistenceError = true
    }
  }

  return { content, violations, notes, flagged, brandVoiceChecked, ...(persistenceError ? { persistenceError } : {}) }
}
