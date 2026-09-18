"use server"

// app/actions/content-prediction.ts
// Layer 9.3 Content Performance Predictor — Server Actions

import { predictContentPerformance, getPrediction, type ContentType } from "@/lib/content/performance-predictor"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"

// A small allowlist of tables we'll allow predictions/lookups against.
// Each entry tells us the column that holds the row's brokerage id.
//
// `marketing_assets` was MISSING, and it is the default source_table the
// Marketing Studio's Pre-Launch check sends
// (app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts:runPrelaunchCheck).
// Every prediction run from that panel against a saved asset therefore came back
// "Unsupported source_table: marketing_assets" — the panel rendered it as
// predictionError and the readiness half carried on, so the failure looked like
// the predictor being flaky rather than an allowlist gap. Column verified live:
// marketing_assets.brokerage_id (uuid).
const PREDICTABLE_TABLES: Record<string, string> = {
  marketing_assets: "brokerage_id",
  social_posts: "brokerage_id",
  marketing_emails: "brokerage_id",
  email_campaigns: "brokerage_id",
  marketing_campaigns: "brokerage_id",
  newsletter_drafts: "brokerage_id",
  blog_posts: "brokerage_id",
  ai_generated_content: "brokerage_id",
}

export interface PredictPerformanceParams {
  brokerageId?: string // ignored — derived from session
  userId?: string // ignored — derived from session
  contentType: ContentType
  sourceTable: string
  sourceId: string
  contentText: string
  platform?: string
  scheduledFor?: string
}

/**
 * Verifies sourceTable/sourceId row belongs to the caller's brokerage.
 */
async function verifySourceOwnership(
  sourceTable: string,
  sourceId: string,
  brokerageId: string
): Promise<{ ok: boolean; error?: string }> {
  const tenantCol = PREDICTABLE_TABLES[sourceTable]
  if (!tenantCol) {
    return { ok: false, error: `Unsupported source_table: ${sourceTable}` }
  }
  const svc = createServiceClient()
  const { data: row } = await svc
    .from(sourceTable)
    .select(`id, ${tenantCol}`)
    .eq("id", sourceId)
    .maybeSingle()
  if (!row || (row as any)[tenantCol] !== brokerageId) {
    return { ok: false, error: "Forbidden" }
  }
  return { ok: true }
}

/**
 * Server action to predict content performance.
 */
export async function predictPerformanceAction(params: PredictPerformanceParams) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const ownership = await verifySourceOwnership(params.sourceTable, params.sourceId, ctx.brokerageId)
  if (!ownership.ok) return { success: false, error: ownership.error || "Forbidden" }

  return predictContentPerformance({
    brokerageId: ctx.brokerageId,
    userId: ctx.userId,
    contentType: params.contentType,
    sourceTable: params.sourceTable,
    sourceId: params.sourceId,
    contentText: params.contentText,
    platform: params.platform,
    scheduledFor: params.scheduledFor,
  })
}

/**
 * Server action to get existing prediction for content.
 */
export async function getPredictionAction(
  sourceTable: string,
  sourceId: string,
  _brokerageId?: string // ignored — derived from session
) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const ownership = await verifySourceOwnership(sourceTable, sourceId, ctx.brokerageId)
  if (!ownership.ok) return { success: false, error: ownership.error || "Forbidden" }

  return getPrediction(sourceTable, sourceId, ctx.brokerageId)
}

/**
 * Grade a prediction against what actually happened.
 *
 * This is the OUTCOME half of the content-performance rail. Without it
 * `prediction_accuracy_log` has no writer at all, and the rail that reads it —
 * lib/analytics/prediction-accuracy.ts (Rail 8, "content_performance"), which
 * feeds the Manager Trust panel and the earned-autonomy accuracy gate — can only
 * ever report "no published content has its actual engagement logged against a
 * prediction yet".
 *
 * TENANT: the prediction row must belong to the caller's brokerage before it can
 * be graded, and the log row is stamped with the SESSION's brokerage — never a
 * caller-supplied one. `logActualPerformance` takes brokerageId as an argument
 * and writes it verbatim, so that check has to happen here, at the door.
 */
export async function logActualPerformanceAction(params: {
  predictionId: string
  likes?: number
  comments?: number
  shares?: number
  impressions?: number
  clicks?: number
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  const { data: prediction, error } = await svc
    .from("content_performance_predictions")
    .select("id, brokerage_id")
    .eq("id", params.predictionId)
    .maybeSingle()

  // A refused read is not "no such prediction" — report the refusal rather than
  // letting an RLS/permission problem read as a missing row.
  if (error) return { success: false, error: `Could not verify the prediction: ${error.message}` }
  if (!prediction) return { success: false, error: "Prediction not found" }
  if ((prediction as { brokerage_id: string }).brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  // Impressions are the denominator of BOTH derived rates. logActualPerformance
  // substitutes 1 when it is missing, which turns "3 likes, unknown reach" into a
  // 300% engagement rate and poisons the accuracy median. Require it.
  if (!params.impressions || params.impressions < 1) {
    return { success: false, error: "Impressions are required — the engagement and click rates are computed against them." }
  }

  const { logActualPerformance } = await import("@/lib/content/performance-predictor")
  return logActualPerformance(
    params.predictionId,
    {
      likes: params.likes,
      comments: params.comments,
      shares: params.shares,
      impressions: params.impressions,
      clicks: params.clicks,
    },
    ctx.brokerageId,
  )
}

/**
 * Server action to get current user context for predictions.
 */
export async function getUserContextForPrediction() {
  // Kernel OS: getAgentContext — canonical, typed, one call
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { success: false, error: "No brokerage found" }

  return {
    success: true,
    userId: ctx.userId,
    brokerageId: ctx.brokerageId, // narrowed to string by guard above
  }
}
