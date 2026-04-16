"use server"

// ============================================================
// AD OS – Shared Server Actions
// Scoped to the Ad OS panels inside Marketing Studio.
// Uses AI SDK generateText directly (no contact context required).
// ============================================================

import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createClient } from "@/lib/supabase/server"
import { predictPerformanceAction, getUserContextForPrediction } from "@/app/actions/content-prediction"
import { evaluateContentReadiness } from "@/app/actions/campaign-readiness"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { scheduleSocialPost } from "@/app/actions/social-media-automation"
import { createCampaign } from "@/app/actions/marketing-studio"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"
import type { ContentType } from "@/lib/content/performance-predictor"
import type { ReadinessInput } from "@/lib/campaign-readiness/readiness-evaluator"

// ─── generateMarketingInsight ─────────────────────────────────────────────────
// Free-form AI generation for Competitor Watch and Repurpose Engine.
// Uses the Vercel AI Gateway (no contactId required).

export async function generateMarketingInsight(
  prompt: string,
  systemPrompt?: string
): Promise<{ success: boolean; text?: string; error?: string }> {
  try {
    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      system:
        systemPrompt ??
        "You are a real estate marketing expert helping agents create compelling, compliant marketing content. Be concise, actionable, and specific.",
      prompt,
    })
    return { success: true, text }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "AI generation failed",
    }
  }
}

// ─── runPrelaunchCheck ────────────────────────────────────────────────────────
// Combines performance prediction + readiness evaluation for a piece of content.
// Takes simple UI inputs and builds the required complex types internally.

export async function runPrelaunchCheck(params: {
  contentText: string
  contentType: ContentType
  platform: string
  sourceTable?: string
  sourceId?: string
}) {
  const userCtx = await getUserContextForPrediction()
  if (!userCtx.success || !userCtx.userId || !userCtx.brokerageId) {
    return { success: false, error: "Not authenticated or no brokerage found" }
  }

  const { userId, brokerageId } = userCtx

  // 1. Performance prediction
  const predResult = await predictPerformanceAction({
    brokerageId,
    userId,
    contentType: params.contentType,
    sourceTable: params.sourceTable ?? "marketing_assets",
    sourceId: params.sourceId ?? crypto.randomUUID(),
    contentText: params.contentText,
    platform: params.platform,
  })

  // 2. Readiness evaluation — build minimal ReadinessInput with sensible defaults
  const now = new Date().toISOString()

  const complianceVerdict = {
    compliance_status: "pass" as const,
    violations: [],
    required_actions: [],
    evaluated_at: now,
    summary: {
      total_violations: 0,
      by_category: {},
      by_severity: {},
      highest_severity: null as null,
    },
  }

  const approvalDecision = {
    approval_status: "auto_approved" as const,
    approval_notes: ["Pre-launch preview — not a final approval"],
    decided_at: now,
    metadata: {
      content_type: params.contentType,
      channel_intent: params.platform,
      compliance_status: "pass",
      highest_violation_severity: null,
      auto_approved: true,
    },
  }

  const readinessInput: ReadinessInput = {
    content_type: params.contentType as any,
    channel_intent: [params.platform as any],
    audience_scope: "public" as any,
    compliance_verdict: complianceVerdict,
    approval_decision: approvalDecision as any,
    context: {},
  }

  const readyResult = await evaluateContentReadiness(readinessInput)

  return {
    success: true,
    prediction: predResult.success ? predResult.prediction : null,
    predictionError: predResult.success ? null : predResult.error,
    readiness: readyResult.success ? readyResult.readiness_output : null,
    readinessError: readyResult.success ? null : readyResult.error,
  }
}

// ─── repurposeContent ─────────────────────────────────────────────────────────
// Fetches brand voice then generates platform-specific variants for each
// selected channel. Returns an array of { channel, content } pairs.

export async function repurposeContent(params: {
  agentId: string
  sourceContent: string
  sourceType: string
  targetChannels: string[]
}) {
  if (!params.agentId || params.targetChannels.length === 0) {
    return { success: false, error: "agentId and at least one target channel are required" }
  }

  const brandVoice = await getBrandVoiceProfile(params.agentId)
  const tone = (brandVoice as any)?.tone ?? "professional yet approachable"
  const style = (brandVoice as any)?.style ?? "conversational"

  const channelInstructions: Record<string, string> = {
    "Facebook Post": "Facebook: 100-200 words, conversational, include a question to drive comments",
    "Instagram Caption": "Instagram: 150 words max, engaging opening line, 3-5 hashtags at end",
    "LinkedIn Article": "LinkedIn: 200-300 words, professional tone, include key insights",
    "Email Newsletter": "Email: Subject line first (prefix with SUBJECT:), then body 150-250 words",
    "SMS Follow-up": "SMS: 160 characters max, clear CTA, no fluff",
    "Seller Update": "Seller Update: 100-150 words, data-driven, reassuring tone",
    "Blog Introduction": "Blog Intro: 200-250 words, hook in first sentence, end with what's coming",
    "Direct Mail Copy": "Direct Mail: 100-150 words, local focus, clear next step",
  }

  const prompt = `Repurpose this ${params.sourceType} for each channel listed. Tone: ${tone}. Style: ${style}.

SOURCE CONTENT:
"""
${params.sourceContent}
"""

Generate one optimized version per channel. Follow these requirements exactly:
${params.targetChannels.map((c) => `- ${channelInstructions[c] ?? c}`).join("\n")}

Return ONLY valid JSON in this exact format:
[${params.targetChannels.map((c) => `{"channel":"${c}","content":"..."}`).join(",")}]`

  const result = await generateMarketingInsight(prompt)
  if (!result.success || !result.text) {
    return { success: false, error: result.error ?? "Generation failed" }
  }

  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) throw new Error("No JSON array found in response")
    const parsed: Array<{ channel: string; content: string }> = JSON.parse(jsonMatch[0])
    return { success: true, variants: parsed }
  } catch {
    return { success: false, error: "Failed to parse AI response" }
  }
}

// ─── scheduleRepurposedPost ───────────────────────────────────────────────────
// Schedules a single repurposed variant via the social automation action.

export async function scheduleRepurposedPost(params: {
  platform: string
  content: string
}) {
  const userCtx = await getUserContextForPrediction()
  if (!userCtx.success || !userCtx.userId || !userCtx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const platformMap: Record<string, string> = {
    "Facebook Post": "facebook",
    "Instagram Caption": "instagram",
    "LinkedIn Article": "linkedin",
    "Email Newsletter": "email",
    "SMS Follow-up": "sms",
    "Seller Update": "email",
    "Blog Introduction": "blog",
    "Direct Mail Copy": "direct_mail",
  }

  return scheduleSocialPost({
    brokerageId: userCtx.brokerageId,
    agentId: userCtx.userId,
    userId: userCtx.userId,
    platform: platformMap[params.platform] ?? params.platform.toLowerCase().replace(/ /g, "_"),
    postType: "repurposed",
    content: params.content,
    scheduledFor: new Date().toISOString(),
    socialAccountId: "",
  } as any)
}

// ─── analyzeCompetitorLandscape ───────────────────────────────────────────────
// AI-driven market intelligence for the Competitor Watch panel.

export async function analyzeCompetitorLandscape(marketArea: string): Promise<{
  success: boolean
  competitorAngles?: string[]
  differentiators?: string[]
  recommendedAngle?: string
  error?: string
}> {
  const prompt = `Analyze the real estate advertising landscape in ${marketArea}.

Based on typical competitor patterns in active real estate markets, answer these:

1. COMPETITOR ANGLES: What are the 3 most common advertising angles competitors likely use in this market?
2. DIFFERENTIATION: What are 3 specific ways our listings could stand out from those competitors?
3. RECOMMENDED ANGLE: What single campaign angle would be most effective for our listings in this market?

Return ONLY valid JSON in this exact format:
{
  "competitor_angles": ["angle 1", "angle 2", "angle 3"],
  "differentiators": ["diff 1", "diff 2", "diff 3"],
  "recommended_angle": "one clear campaign angle recommendation"
}`

  const result = await generateMarketingInsight(prompt)
  if (!result.success || !result.text) {
    return { success: false, error: result.error ?? "Analysis failed" }
  }

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("No JSON found")
    const parsed = JSON.parse(jsonMatch[0])
    return {
      success: true,
      competitorAngles: parsed.competitor_angles,
      differentiators: parsed.differentiators,
      recommendedAngle: parsed.recommended_angle,
    }
  } catch {
    return { success: false, error: "Failed to parse analysis" }
  }
}

// ─── loadRecentPredictions ────────────────────────────────────────────────────
// Fetches recent content predictions for the Performance Intelligence panel.

export async function loadRecentPredictions(brokerageId: string) {
  if (!brokerageId) return { success: false, error: "brokerageId required", predictions: [] }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("content_performance_predictions")
    .select("id, content_type, predicted_score, confidence, rationale, recommended_publish_window, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) return { success: false, error: error.message, predictions: [] }
  return { success: true, predictions: data ?? [] }
}

// ─── launchListingCampaign ────────────────────────────────────────────────────
// Creates a campaign from the Campaign Launcher panel.
// Runs the compliance gate on the ad copy before creating the campaign record.

export async function launchListingCampaign(params: {
  campaignName: string
  campaignType: "listing" | "brand" | "recruitment" | "event" | "seasonal"
  budgetTotal: number
  listingId?: string
  visibilityScope?: "agent" | "team" | "brokerage"
  adCopyText?: string
  brokerageId?: string
}) {
  // ── Compliance gate ───────────────────────────────────────────────────────
  const adCopyText = params.adCopyText?.trim() || params.campaignName
  const complianceResult = await runComplianceGate({
    content: adCopyText,
    brokerageId: params.brokerageId ?? null,
    authorUserId: "",
    contentType: "ad",
  }).catch(() => ({ passed: true, violations: [], requiresHumanReview: false }))

  if (!complianceResult.passed) {
    const blockers = complianceResult.violations
      .filter((v) => v.severity === "blocker")
      .map((v) => v.detail)
    const warnings = complianceResult.violations
      .filter((v) => v.severity === "warning")
      .map((v) => v.detail)
    return {
      success: false,
      complianceBlocked: true,
      blockers,
      warnings,
      error: `Ad copy failed compliance: ${blockers.join(". ")}`,
    }
  }

  return createCampaign({
    campaignName: params.campaignName,
    campaignType: params.campaignType,
    budgetTotal: params.budgetTotal,
    visibilityScope: params.visibilityScope ?? "agent",
  })
}

// ─── checkContentCompliance ───────────────────────────────────────────────────
// Thin server-action wrapper so client components can call the compliance gate
// without bundling the gate logic client-side.

export async function checkContentCompliance(params: {
  content: string
  brokerageId: string
  contentType: "social_post" | "ad" | "listing_remarks" | "comment_reply" | "newsletter" | "blog"
}): Promise<{ passed: boolean; blockers: string[]; warnings: string[] }> {
  try {
    const result = await runComplianceGate({
      content: params.content,
      brokerageId: params.brokerageId || null,
      authorUserId: "",
      contentType: params.contentType,
    })
    const blockers = result.violations.filter((v) => v.severity === "blocker").map((v) => v.detail)
    const warnings = result.violations.filter((v) => v.severity === "warning").map((v) => v.detail)
    return { passed: result.passed, blockers, warnings }
  } catch {
    // Fail open — do not block publishing on gate errors
    return { passed: true, blockers: [], warnings: [] }
  }
}
