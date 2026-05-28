"use server"

// app/actions/content-prediction.ts
// Layer 9.3 Content Performance Predictor — Server Actions

import { predictContentPerformance, getPrediction, type ContentType } from "@/lib/content/performance-predictor"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"

// A small allowlist of tables we'll allow predictions/lookups against.
// Each entry tells us the column that holds the row's brokerage id.
const PREDICTABLE_TABLES: Record<string, string> = {
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
