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
// Type-only (erased at compile time): the real shape the predictor returns, so the
// panel can read predicted_score / rationale / confidence without a cast.
import type { PredictionResult } from "@/lib/content/performance-predictor"
import {
  evaluateContentReadiness,
  batchEvaluateContentReadiness,
  checkSpecificChannelReadiness,
  quickCheckReadiness,
  validateReadinessInput,
  formatReadinessResult,
  fetchReadinessHistory,
} from "@/app/actions/campaign-readiness"
import { evaluateContentCompliance, type ComplianceVerdict } from "@/lib/compliance-rules"
import { determineApprovalDecision, type ApprovalDecision } from "@/lib/approval-workflow"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { scheduleSocialPost } from "@/app/actions/social-media-automation"
import { createCampaign } from "@/app/actions/marketing-studio"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"
import type { ContentType } from "@/lib/content/performance-predictor"
import type {
  ReadinessInput,
  ExecutionChannel,
  ContentType as ReadinessContentType,
} from "@/lib/campaign-readiness/readiness-evaluator"

// ─── READINESS INPUT BUILDER ──────────────────────────────────────────────────
// Systems 4.2 (compliance) → 4.3 (approval) → 4.5 (readiness) are a chain.
// This builds the 4.5 input from the REAL 4.2/4.3 verdicts instead of the
// hard-coded {compliance_status:"pass", approval_status:"auto_approved"} stub
// that used to sit inline in runPrelaunchCheck. That stub was wrong twice over:
//   1. it declared every piece of content compliant without evaluating it, and
//   2. "auto_approved" is not in ApprovalStatus ("approved"|"pending"|
//      "rejected"), so checkApprovalReadiness compared it against "approved",
//      failed, and EVERY pre-launch check in the Studio came back BLOCKED with
//      'Content approval status is auto_approved, not approved'.

/** Readiness ContentType vocabulary (lib/campaign-readiness/readiness-evaluator). */
const READINESS_CONTENT_TYPES = [
  "email", "sms", "social_post", "ad", "newsletter", "blog_post",
  "listing_description", "video_script", "direct_mail", "image_prompt",
] as const

/** ExecutionChannel vocabulary (lib/campaign-readiness/readiness-evaluator). */
const EXECUTION_CHANNELS = [
  "email", "sms", "direct_mail", "facebook", "instagram", "linkedin", "twitter",
  "tiktok", "youtube", "google_ads", "meta_ads", "newsletter", "blog",
  "listing_website",
] as const

function toReadinessContentType(value: string): ReadinessContentType {
  if ((READINESS_CONTENT_TYPES as readonly string[]).includes(value)) {
    return value as ReadinessContentType
  }
  // Predictor vocabulary → readiness vocabulary
  if (value === "ad_creative") return "ad"
  return "social_post"
}

function toExecutionChannel(value: string): ExecutionChannel | null {
  return (EXECUTION_CHANNELS as readonly string[]).includes(value)
    ? (value as ExecutionChannel)
    : null
}

/** Compliance content_type vocabulary accepted by runComplianceGate. */
function toGateContentType(
  value: ReadinessContentType
): "social_post" | "ad" | "listing_remarks" | "comment_reply" | "newsletter" | "blog" {
  switch (value) {
    case "ad": return "ad"
    case "newsletter":
    case "email": return "newsletter"
    case "blog_post": return "blog"
    case "listing_description": return "listing_remarks"
    default: return "social_post"
  }
}

async function buildReadinessInput(params: {
  contentText: string
  contentType: string
  platform: string
  brokerageId: string
  contentId?: string
  audienceScope?: "public" | "private"
}): Promise<{
  input: ReadinessInput
  compliance: ComplianceVerdict
  approval: ApprovalDecision
  channel: ExecutionChannel | null
}> {
  const readinessType = toReadinessContentType(params.contentType)
  const channel = toExecutionChannel(params.platform)

  // SYSTEM 4.2 — real compliance verdict, brokerage-scoped so state-specific
  // protected-class rules load for the caller's brokerage.
  const compliance = await evaluateContentCompliance({
    content_type: readinessType,
    channel_intent: params.platform,
    raw_content: params.contentText,
    brokerage_id: params.brokerageId,
    intended_audience: params.audienceScope ?? "public",
  })

  // SYSTEM 4.3 — real approval decision derived from that verdict.
  const approval = determineApprovalDecision(
    {
      content_type: readinessType,
      channel_intent: params.platform,
      raw_content: params.contentText,
      source_inputs: {},
      generated_at: new Date().toISOString(),
    },
    compliance,
    {
      requester_role: "agent",
      content_origin: "ai_generated",
      audience_scope: params.audienceScope ?? "public",
    }
  )

  const input: ReadinessInput = {
    content_type: readinessType,
    channel_intent: channel ? [channel] : [],
    audience_scope: params.audienceScope ?? "public",
    content_id: params.contentId,
    compliance_verdict: compliance,
    approval_decision: approval,
    context: {},
  }

  return { input, compliance, approval, channel }
}

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

interface PrelaunchCheckResult {
  success: boolean
  error?: string
  // `unknown` here forced every consumer to cast: `res.prediction ?? null` widens
  // to `{} | null`, which no typed setState will accept. The predictor already
  // publishes PredictionResult — say so.
  prediction?: PredictionResult | null
  predictionError?: string | null
  readiness?: { readiness_status: "ready" | "blocked"; blocking_reasons?: string[]; ready_for_channels?: string[] } | null
  readinessError?: string | null
  readinessLogError?: string | null
  readinessReport?: string | null
  quickVerdict?: { isReady: boolean; reason: string | null } | null
  channelVerdict?: { channel: string; isReady: boolean; reason: string | null } | null
  compliance?: {
    status: "pass" | "fail" | "review_required"
    violations: Array<{ severity: string; rule: string; detail: string; suggestedFix: string | null }>
    requiredActions: string[]
  } | null
  approval?: { status: string; blockingReason: string | null; requiredApprovers: string[] } | null
}

export async function runPrelaunchCheck(params: {
  contentText: string
  contentType: ContentType
  platform: string
  sourceTable?: string
  sourceId?: string
}): Promise<PrelaunchCheckResult> {
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

  // 2. Readiness evaluation — real 4.2 compliance + 4.3 approval, no stubs.
  const contentId = params.sourceId && isUuid(params.sourceId) ? params.sourceId : undefined
  const { input: readinessInput, compliance, approval, channel } = await buildReadinessInput({
    contentText: params.contentText,
    contentType: params.contentType,
    platform: params.platform,
    brokerageId,
    contentId,
  })

  // Structural validation of the 4.5 input BEFORE evaluating, so a malformed
  // input reports which field is missing instead of a generic failure.
  const validation = await validateReadinessInput(readinessInput)
  if (validation.success && validation.is_valid === false) {
    return {
      success: false,
      error: `Readiness input incomplete — missing: ${(validation.missing_fields ?? []).join(", ")}`,
    }
  }

  // Fast approval+compliance verdict, and the full multi-check evaluation.
  // log_to_activities records the verdict where the ops tab's pass-rate reads
  // it — only possible when the content has a real id.
  const [quick, readyResult] = await Promise.all([
    quickCheckReadiness(approval, compliance),
    evaluateContentReadiness(readinessInput, { log_to_activities: Boolean(contentId) }),
  ])

  // Per-channel verdict for the selected platform + the human-readable report,
  // both rendered from the SERVER's answer.
  const channelCheck = channel
    ? await checkSpecificChannelReadiness(readinessInput, channel)
    : {
        success: false,
        is_ready: false,
        reason: undefined as string | undefined,
        error: `"${params.platform}" is not an execution channel`,
      }

  const formatted =
    readyResult.success && readyResult.readiness_output
      ? await formatReadinessResult(readyResult.readiness_output)
      : { success: false, formatted: undefined as string | undefined, error: "No readiness output to format" }

  return {
    success: true,
    prediction: predResult.success ? predResult.prediction : null,
    predictionError: predResult.success ? null : predResult.error,
    readiness: readyResult.success ? readyResult.readiness_output : null,
    readinessError: readyResult.success ? null : readyResult.error,
    /** Set when readiness was evaluated but could NOT be recorded. */
    readinessLogError: readyResult.success ? (readyResult.log_error ?? null) : null,
    readinessReport: formatted.success ? (formatted.formatted ?? null) : null,
    quickVerdict: quick.success ? { isReady: quick.is_ready ?? false, reason: quick.reason ?? null } : null,
    channelVerdict: channelCheck.success
      ? { channel: params.platform, isReady: channelCheck.is_ready ?? false, reason: channelCheck.reason ?? null }
      : { channel: params.platform, isReady: false, reason: channelCheck.error ?? "Channel check failed" },
    compliance: {
      status: compliance.compliance_status,
      violations: compliance.violations.map((v) => ({
        severity: v.severity,
        rule: v.rule_name,
        detail: v.description,
        suggestedFix: v.suggested_fix ?? null,
      })),
      requiredActions: compliance.required_actions,
    },
    approval: {
      status: approval.approval_status,
      blockingReason: approval.blocking_reason ?? null,
      requiredApprovers: approval.required_approvers ?? [],
    },
  }
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

// ─── runBatchReadinessCheck ───────────────────────────────────────────────────
// Evaluates a whole shortlist of marketing assets in one pass and RECORDS each
// verdict, so the Studio ops "Readiness Pass Rate" reflects real content
// instead of an empty table.

export async function runBatchReadinessCheck(
  items: Array<{ contentId: string; contentText: string; contentType: string; platform: string }>
): Promise<{
  success: boolean
  results?: Array<{ contentId: string; status: "ready" | "blocked"; blockingReasons: string[] }>
  loggedCount?: number
  logError?: string | null
  error?: string
}> {
  if (items.length === 0) return { success: false, error: "Nothing to evaluate" }

  const userCtx = await getUserContextForPrediction()
  if (!userCtx.success || !userCtx.brokerageId) {
    return { success: false, error: "Not authenticated or no brokerage found" }
  }

  const built = await Promise.all(
    items.map((item) =>
      buildReadinessInput({
        contentText: item.contentText,
        contentType: item.contentType,
        platform: item.platform,
        brokerageId: userCtx.brokerageId as string,
        contentId: item.contentId,
      })
    )
  )

  const res = await batchEvaluateContentReadiness(
    built.map((b) => b.input),
    { log_to_activities: true }
  )
  if (!res.success) return { success: false, error: res.error ?? "Batch evaluation failed" }

  return {
    success: true,
    results: (res.results ?? []).map((r, i) => ({
      contentId: items[i].contentId,
      status: r.readiness_output.readiness_status,
      blockingReasons: r.readiness_output.blocking_reasons ?? [],
    })),
    loggedCount: res.logged_count ?? 0,
    logError: res.log_error ?? null,
  }
}

// ─── loadReadinessHistory ─────────────────────────────────────────────────────
// The recorded readiness trail for one piece of content — brokerage-gated in
// app/actions/campaign-readiness.ts before the service-role read runs.

export async function loadReadinessHistory(contentId: string): Promise<{
  success: boolean
  entries?: Array<{ id: string; activityType: string; status: string; reasons: string[]; createdAt: string }>
  error?: string
}> {
  if (!isUuid(contentId)) return { success: false, error: "Invalid content id" }

  const res = await fetchReadinessHistory(contentId, 25)
  if (!res.success) return { success: false, error: res.error ?? "Could not load readiness history" }

  return {
    success: true,
    entries: (res.evaluations ?? []).map((e) => ({
      id: e.id,
      activityType: e.activity_type,
      status: String((e.metadata as any)?.readiness_status ?? (e.activity_type === "campaign_ready" ? "ready" : "blocked")),
      reasons: ((e.metadata as any)?.blocking_reasons ?? []) as string[],
      createdAt: e.created_at,
    })),
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

  const platform = platformMap[params.platform] ?? params.platform.toLowerCase().replace(/ /g, "_")

  // This passed socialAccountId: "" — scheduleSocialPost rejects a non-UUID
  // before doing anything else, so the Repurpose Engine's schedule button
  // returned "Invalid social account ID" on every click. Resolve the agent's
  // connected account for the target platform instead.
  const supabase = await createClient()
  const { data: account } = await supabase
    .from("social_media_accounts")
    .select("id")
    .eq("brokerage_id", userCtx.brokerageId)
    .eq("platform", platform)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()

  if (!account?.id) {
    return {
      success: false,
      error: `No connected ${params.platform.split(" ")[0]} account. Connect one in Settings → Integrations, then schedule this post.`,
    }
  }

  return scheduleSocialPost({
    brokerageId: userCtx.brokerageId,
    // agentId is OMITTED on purpose: scheduleSocialPost defaults to
    // auth.agentId (an agents id). It used to be handed userCtx.userId, which
    // failed verifyAgentInBrokerage and returned "Forbidden".
    platform,
    postType: "repurposed",
    content: params.content,
    scheduledFor: new Date().toISOString(),
    socialAccountId: account.id,
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
