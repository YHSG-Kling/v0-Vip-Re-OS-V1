"use server"

/**
 * Content Guardian — unified compliance + BrandVoice gate for all AI-generated content.
 *
 * Every AI content generation route should call guardContent() before returning text to the UI.
 * Violations are flagged for admin review but content is still returned (non-blocking).
 * Blocking compliance issues (severity="blocking") set flagged=true.
 */

import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import {
  scanContentComplianceService,
  submitContentForApprovalService,
} from "@/lib/application"
import { createClient } from "@/lib/supabase/server"

export type ContentType =
  | "listing_description"
  | "email"
  | "social_post"
  | "blog"
  | "video_script"
  | "newsletter"
  | "direct_mail"
  | "sms"

interface GuardContentParams {
  content: string
  agentId: string
  brokerageId: string
  userId?: string
  teamId?: string
  contentType: ContentType
  /** US state abbreviation for disclosure requirements (e.g. "TX") */
  agentState?: string
}

export interface GuardContentResult {
  /** The original content (unchanged — guardian is advisory, not rewriting) */
  content: string
  /** BrandVoice style violations */
  brandVoiceViolations: string[]
  /** BrandVoice advisory notes */
  brandVoiceNotes: string[]
  /** Compliance issues found */
  complianceIssues: string[]
  /** True when at least one blocking compliance issue was found */
  flagged: boolean
  brandVoiceApplied: boolean
}

const CHANNEL_MAP: Record<ContentType, string[]> = {
  listing_description: ["website"],
  email:               ["email"],
  newsletter:          ["email"],
  social_post:         ["social"],
  blog:                ["website"],
  video_script:        ["video"],
  direct_mail:         ["print"],
  sms:                 ["sms"],
}

const AUDIENCE_MAP: Record<ContentType, string> = {
  listing_description: "general",
  email:               "warm_lead",
  newsletter:          "warm_lead",
  social_post:         "general",
  blog:                "general",
  video_script:        "general",
  direct_mail:         "cold_lead",
  sms:                 "warm_lead",
}

export async function guardContent(params: GuardContentParams): Promise<GuardContentResult> {
  const {
    content,
    agentId,
    brokerageId,
    userId,
    teamId,
    contentType,
    agentState = "TX",
  } = params

  if (!content?.trim()) {
    return {
      content,
      brandVoiceViolations: [],
      brandVoiceNotes: [],
      complianceIssues: [],
      flagged: false,
      brandVoiceApplied: false,
    }
  }

  // Run both checks in parallel
  const [brandVoiceResult, complianceResult] = await Promise.allSettled([
    applyBrandVoice({
      content,
      brokerageId,
      teamId,
      actorUserId: userId ?? agentId,
      actorRole:   "agent",
      journeyType: contentType === "listing_description" ? "seller" : "buyer",
      persona:     "professional",
      messageType: contentType,
    }),
    scanContentComplianceService({
      contentBody:          content,
      contentType,
      targetAudience:       AUDIENCE_MAP[contentType] ?? "general",
      distributionChannels: CHANNEL_MAP[contentType] ?? ["website"],
      agentState,
    }),
  ])

  const brandVoiceViolations = brandVoiceResult.status === "fulfilled" ? brandVoiceResult.value.violations : []
  const brandVoiceNotes      = brandVoiceResult.status === "fulfilled" ? brandVoiceResult.value.notes      : []
  const complianceIssues: string[] = []
  let flagged = false

  if (complianceResult.status === "fulfilled") {
    const scan = complianceResult.value as any
    const issues = scan?.issues ?? []
    for (const issue of issues) {
      complianceIssues.push(
        issue.message ?? `${issue.type}: ${issue.found ?? issue.category}`
      )
      if (issue.severity === "blocking") flagged = true
    }
  }

  // Log violations to compliance_flags table (live table) for admin review queue
  if (flagged || brandVoiceViolations.length > 0) {
    try {
      const supabase = await createClient()
      const allViolations = [
        ...complianceIssues,
        ...brandVoiceViolations.map(v => `[BrandVoice] ${v}`),
      ]
      await supabase.from("compliance_flags").insert({
        brokerage_id:    brokerageId,
        agent_id:        agentId,
        content_type:    contentType,
        flagged_content: content.substring(0, 500),
        violation_type:  flagged ? "compliance" : "brand_voice",
        severity:        flagged ? "blocking" : "warning",
        status:          "pending",
        resolution_notes: allViolations.join(" | "),
        detected_at:     new Date().toISOString(),
      })
    } catch {
      // Non-fatal — guardian continues even if logging fails
    }
  }

  return {
    content,
    brandVoiceViolations,
    brandVoiceNotes,
    complianceIssues,
    flagged,
    brandVoiceApplied: brandVoiceResult.status === "fulfilled",
  }
}
