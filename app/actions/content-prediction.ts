"use server"

// app/actions/content-prediction.ts
// Layer 9.3 Content Performance Predictor — Server Actions

import { predictContentPerformance, getPrediction, type ContentType } from "@/lib/content/performance-predictor"
import { createClient } from "@/lib/supabase/server"

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
  const supabase = await createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage found" }
  }

  return {
    success: true,
    userId: user.id,
    brokerageId: profile.brokerage_id,
  }
}
