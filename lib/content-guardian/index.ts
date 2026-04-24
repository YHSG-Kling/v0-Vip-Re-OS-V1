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
}

// Fair housing trigger phrases
const FAIR_HOUSING_PATTERNS: RegExp[] = [
  /\b(no children|adults only|no kids)\b/i,
  /\b(perfect for (singles|couples|families with no kids))\b/i,
  /\b(exclusive|restricted|select)\s+(neighborhood|community|area)\b/i,
  /\b(walking distance to (church|mosque|temple|synagogue))\b/i,
  /\b(handicap|handicapped)\b/i,
  /\b(good schools|great schools)\b/i,
]

function detectFairHousingViolations(text: string): string[] {
  const found: string[] = []
  for (const pattern of FAIR_HOUSING_PATTERNS) {
    const match = text.match(pattern)
    if (match) found.push(`Fair housing risk: "${match[0]}"`)
  }
  return found
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
  if (flagged) {
    try {
      const supabase = createServiceClient()
      await supabase.from("content_approvals").insert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        content_type: contentType,
        content_text: content,
        violations: violations,
        status: "pending",
        submitted_at: new Date().toISOString(),
      })
    } catch {
      // Non-fatal
    }
  }

  return { content, violations, notes, flagged, brandVoiceChecked }
}
