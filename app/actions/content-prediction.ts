"use server"

// app/actions/content-prediction.ts
// Layer 9.3 Content Performance Predictor — Server Actions

import { predictContentPerformance, getPrediction, type ContentType } from "@/lib/content/performance-predictor"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

export interface PredictPerformanceParams {
  brokerageId: string
  userId: string
  contentType: ContentType
  sourceTable: string
  sourceId: string
  contentText: string
  platform?: string
  scheduledFor?: string
}

/**
 * Server action to predict content performance.
 */
export async function predictPerformanceAction(params: PredictPerformanceParams) {
  return predictContentPerformance(params)
}

/**
 * Server action to get existing prediction for content.
 */
export async function getPredictionAction(
  sourceTable: string,
  sourceId: string,
  brokerageId: string
) {
  return getPrediction(sourceTable, sourceId, brokerageId)
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
