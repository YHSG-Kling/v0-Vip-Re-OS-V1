// lib/content/performance-predictor.ts
// Layer 9.3 Content Performance Predictor
// MARKETING content predictor — NOT buyer_behavior_predictions
// Tables: content_performance_predictions, prediction_accuracy_log

import { createClient } from "@/lib/supabase/server"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { processKernelEvent, KernelEvent } from "@/lib/kernel"
import Anthropic from "@anthropic-ai/sdk"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type ContentType = 
  | "social_post" 
  | "blog_post" 
  | "newsletter" 
  | "ad_creative" 
  | "podcast_episode"

export type ConfidenceLevel = "low" | "medium" | "high"

export interface RecommendedPublishWindow {
  day: string
  hour: number
  timezone: string
}

export interface PredictionResult {
  predicted_score: number
  predicted_ctr: number
  predicted_engagement_rate: number
  recommended_publish_window: RecommendedPublishWindow
  rationale: string
  confidence: ConfidenceLevel
}

export interface PredictContentPerformanceParams {
  brokerageId: string
  userId: string
  contentType: ContentType
  sourceTable: string
  sourceId: string
  contentText: string
  platform?: string
  scheduledFor?: string
}

// ─── PLATFORM BEST TIMES ──────────────────────────────────────────────────────

const PLATFORM_BEST_TIMES: Record<string, { days: string[]; hours: number[] }> = {
  facebook: { days: ["Tuesday", "Wednesday", "Thursday"], hours: [10, 11, 12, 13, 14] },
  instagram: { days: ["Monday", "Wednesday", "Friday"], hours: [11, 12, 13] },
  linkedin: { days: ["Tuesday", "Wednesday", "Thursday"], hours: [9, 10, 11] },
  twitter: { days: ["Tuesday", "Wednesday", "Thursday"], hours: [9, 10, 11, 12] },
  tiktok: { days: ["Tuesday", "Thursday", "Saturday"], hours: [12, 15, 19, 21] },
  youtube: { days: ["Thursday", "Friday", "Saturday"], hours: [14, 15, 16, 17] },
  pinterest: { days: ["Saturday", "Sunday"], hours: [20, 21, 22] },
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// ─── predictContentPerformance ────────────────────────────────────────────────

/**
 * Predicts content performance using a multi-signal algorithm:
 * 1. Text analysis via Claude (hook strength, clarity, CTA presence, local relevance)
 * 2. Historical engagement signal from social_engagement_tracking
 * 3. Timing signal based on scheduled publish time
 * 
 * ADVISORY ONLY — never triggers publish or scheduling.
 */
export async function predictContentPerformance(
  params: PredictContentPerformanceParams
): Promise<{ success: boolean; prediction?: PredictionResult; error?: string }> {
  const { brokerageId, userId, contentType, sourceTable, sourceId, contentText, platform, scheduledFor } = params

  // ── Feature gate ───────────────────────────────────────────────────────────
  const access = await canAccessFeature(userId, "content_performance_predictor")
  if (!access.allowed) {
    return { success: false, error: access.reason || "Feature not available" }
  }

  const supabase = await createClient()

  try {
    // ── STEP 1: Text Analysis via Claude ─────────────────────────────────────
    let textScore = 50 // Default
    let rationale = "Unable to analyze text."
    
    try {
      const anthropic = new Anthropic()
      
      const prompt = `Analyze this marketing content for a real estate professional and score it on four dimensions (0-25 each):

CONTENT:
"""
${contentText.slice(0, 2000)}
"""

Score each dimension:
1. Hook strength (0-25): Does the first sentence compel the reader to continue?
2. Clarity (0-25): Is the message clear and easy to understand?
3. CTA presence (0-25): Is there a clear call to action?
4. Local relevance (0-25): Does it mention location, neighborhood, or local market?

Return ONLY valid JSON in this exact format, no other text:
{"hook": <number>, "clarity": <number>, "cta": <number>, "local": <number>, "rationale": "<brief explanation of strengths and weaknesses>"}`

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      })

      const textContent = response.content[0]
      if (textContent.type === "text") {
        try {
          // Parse the JSON response
          const jsonMatch = textContent.text.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            const hook = Math.min(25, Math.max(0, Number(parsed.hook) || 0))
            const clarity = Math.min(25, Math.max(0, Number(parsed.clarity) || 0))
            const cta = Math.min(25, Math.max(0, Number(parsed.cta) || 0))
            const local = Math.min(25, Math.max(0, Number(parsed.local) || 0))
            textScore = hook + clarity + cta + local
            rationale = parsed.rationale || "Analysis complete."
          }
        } catch (parseError) {
          console.error("[ContentPredictor] Failed to parse Claude response:", parseError)
        }
      }
    } catch (claudeError) {
      console.error("[ContentPredictor] Claude API error:", claudeError)
      // Fall back to default text score
    }

    // ── STEP 2: Historical Signal ────────────────────────────────────────────
    let historicalScore = 50
    let confidence: ConfidenceLevel = "low"

    if (platform) {
      const { data: engagementData, error: engagementError } = await supabase
        .from("social_engagement_tracking")
        .select("likes_count, comments_count, shares_count, impressions_count")
        .eq("brokerage_id", brokerageId)
        .eq("platform", platform)

      if (!engagementError && engagementData && engagementData.length > 0) {
        // Calculate average engagement rate
        let totalEngagement = 0
        let totalImpressions = 0

        for (const row of engagementData) {
          totalEngagement += (row.likes_count || 0) + (row.comments_count || 0) + (row.shares_count || 0)
          totalImpressions += row.impressions_count || 0
        }

        const rowCount = engagementData.length

        if (rowCount >= 10) {
          confidence = "high"
          const avgEngagementRate = totalImpressions > 0 ? totalEngagement / totalImpressions : 0
          historicalScore = Math.min(100, Math.round(avgEngagementRate * 10000))
        } else if (rowCount >= 5) {
          confidence = "medium"
          historicalScore = 50
        } else {
          confidence = "low"
          historicalScore = 50
        }
      }
    }

    // ── STEP 3: Timing Signal ────────────────────────────────────────────────
    let timingScore = 70 // Default
    let recommendedWindow: RecommendedPublishWindow = {
      day: "Tuesday",
      hour: 10,
      timezone: "America/New_York",
    }

    const platformTimes = platform ? PLATFORM_BEST_TIMES[platform.toLowerCase()] : null

    if (platformTimes) {
      // Set recommended window based on platform
      recommendedWindow = {
        day: platformTimes.days[0],
        hour: platformTimes.hours[0],
        timezone: "America/New_York",
      }

      if (scheduledFor) {
        const scheduledDate = new Date(scheduledFor)
        const dayOfWeek = DAY_NAMES[scheduledDate.getUTCDay()]
        const hourOfDay = scheduledDate.getUTCHours()

        const isOptimalDay = platformTimes.days.includes(dayOfWeek)
        const isOptimalHour = platformTimes.hours.includes(hourOfDay)

        if (isOptimalDay && isOptimalHour) {
          timingScore = 100
        } else if (isOptimalDay || isOptimalHour) {
          timingScore = 80
        } else {
          timingScore = 60
        }
      }
    }

    // ── STEP 4: Final Score Calculation ──────────────────────────────────────
    // predicted_score = (text_score * 0.4) + (historical_score * 0.3) + (timing_score * 0.3)
    const predictedScore = Math.round(
      (textScore * 0.4) + (historicalScore * 0.3) + (timingScore * 0.3)
    )

    // predicted_ctr = predicted_score / 2000
    const predictedCtr = predictedScore / 2000

    // predicted_engagement_rate = historical_score / 10000
    const predictedEngagementRate = historicalScore / 10000

    // ── STEP 5: Save Prediction ──────────────────────────────────────────────
    const { data: prediction, error: insertError } = await supabase
      .from("content_performance_predictions")
      .insert({
        brokerage_id: brokerageId,
        content_type: contentType,
        source_table: sourceTable,
        source_id: sourceId,
        predicted_score: predictedScore,
        predicted_ctr: predictedCtr,
        predicted_engagement_rate: predictedEngagementRate,
        recommended_publish_window: recommendedWindow,
        rationale,
        confidence,
      })
      .select("id")
      .single()

    if (insertError) {
      console.error("[ContentPredictor] Failed to save prediction:", insertError)
      return { success: false, error: insertError.message }
    }

    // ── STEP 6: Increment usage + Kernel event ───────────────────────────────
    await incrementFeatureUsage(userId, "content_performance_predictor")

    await processKernelEvent({
      eventType: KernelEvent.CONTENT_PERFORMANCE_PREDICTED,
      brokerageId,
      userId,
      entityType: "content_performance_predictions",
      entityId: prediction.id,
      metadata: {
        content_type: contentType,
        source_table: sourceTable,
        source_id: sourceId,
        predicted_score: predictedScore,
        confidence,
      },
    })

    return {
      success: true,
      prediction: {
        predicted_score: predictedScore,
        predicted_ctr: predictedCtr,
        predicted_engagement_rate: predictedEngagementRate,
        recommended_publish_window: recommendedWindow,
        rationale,
        confidence,
      },
    }
  } catch (error) {
    console.error("[ContentPredictor] Unexpected error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}

// ─── logActualPerformance ─────────────────────────────────────────────────────

/**
 * Logs actual performance data after a post has been published to track
 * prediction accuracy over time.
 */
export async function logActualPerformance(
  predictionId: string,
  actualEngagementData: {
    likes?: number
    comments?: number
    shares?: number
    impressions?: number
    clicks?: number
  },
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  // Get original prediction
  const { data: prediction, error: predError } = await supabase
    .from("content_performance_predictions")
    .select("predicted_score, predicted_ctr, predicted_engagement_rate")
    .eq("id", predictionId)
    .single()

  if (predError || !prediction) {
    return { success: false, error: "Prediction not found" }
  }

  // Calculate actual metrics
  const totalEngagement = 
    (actualEngagementData.likes || 0) + 
    (actualEngagementData.comments || 0) + 
    (actualEngagementData.shares || 0)

  const impressions = actualEngagementData.impressions || 1
  const clicks = actualEngagementData.clicks || 0

  // actual_engagement_rate = total_engagement / impressions
  const actualEngagementRate = totalEngagement / impressions

  // actual_ctr = clicks / impressions
  const actualCtr = clicks / impressions

  // actual_score = normalize engagement rate to 0-100 scale (similar to prediction)
  const actualScore = Math.min(100, Math.round(actualEngagementRate * 10000))

  // delta_score = predicted - actual
  const deltaScore = prediction.predicted_score - actualScore

  // Insert accuracy log
  const { error: insertError } = await supabase
    .from("prediction_accuracy_log")
    .insert({
      brokerage_id: brokerageId,
      prediction_id: predictionId,
      actual_score: actualScore,
      actual_engagement_rate: actualEngagementRate,
      actual_ctr: actualCtr,
      delta_score: deltaScore,
    })

  if (insertError) {
    return { success: false, error: insertError.message }
  }

  return { success: true }
}

// ─── getPrediction ────────────────────────────────────────────────────────────

/**
 * Retrieves an existing prediction for a piece of content.
 */
export async function getPrediction(
  sourceTable: string,
  sourceId: string,
  brokerageId: string
): Promise<{ success: boolean; prediction?: any; error?: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("content_performance_predictions")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("source_table", sourceTable)
    .eq("source_id", sourceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, prediction: data }
}

// ─── getPredictionAccuracyStats ───────────────────────────────────────────────

/**
 * Returns aggregate accuracy statistics for a brokerage's predictions.
 */
export async function getPredictionAccuracyStats(
  brokerageId: string
): Promise<{
  success: boolean
  stats?: {
    totalPredictions: number
    avgDeltaScore: number
    accuracyRate: number
  }
  error?: string
}> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("prediction_accuracy_log")
    .select("delta_score")
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  if (!data || data.length === 0) {
    return {
      success: true,
      stats: {
        totalPredictions: 0,
        avgDeltaScore: 0,
        accuracyRate: 0,
      },
    }
  }

  const totalPredictions = data.length
  const avgDeltaScore = data.reduce((sum, row) => sum + Math.abs(row.delta_score || 0), 0) / totalPredictions

  // Accuracy rate = % of predictions within 15 points of actual
  const accurateCount = data.filter((row) => Math.abs(row.delta_score || 0) <= 15).length
  const accuracyRate = (accurateCount / totalPredictions) * 100

  return {
    success: true,
    stats: {
      totalPredictions,
      avgDeltaScore: Math.round(avgDeltaScore * 10) / 10,
      accuracyRate: Math.round(accuracyRate),
    },
  }
}
