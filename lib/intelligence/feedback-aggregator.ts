import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"
import { KernelEvent } from "@/lib/kernel/events"

const SOURCE_SYSTEMS = [
  "daily_briefing",
  "coaching_report",
  "market_insight",
  "behavioral_pattern",
  "smart_suggestion",
  "isa_response",
  "content_generation",
  "intent_classifier",
] as const

type SourceSystem = (typeof SOURCE_SYSTEMS)[number]

const ThemesSchema = z.object({
  themes: z.array(z.string()).max(3),
})

export async function computeWeeklyMetrics(
  brokerageId: string,
  weekStart: Date
): Promise<{ systemsProcessed: number }> {
  const supabase = createServiceClient()
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)

  let systemsProcessed = 0

  for (const sourceSystem of SOURCE_SYSTEMS) {
    // Get feedback counts for this system and week
    const { data: feedbackData, error: feedbackError } = await supabase
      .from("ai_feedback_log")
      .select("rating")
      .eq("brokerage_id", brokerageId)
      .eq("source_system", sourceSystem)
      .gte("created_at", weekStart.toISOString())
      .lt("created_at", weekEnd.toISOString())

    if (feedbackError) {
      console.error(`[FeedbackAggregator] Error fetching feedback for ${sourceSystem}:`, feedbackError)
      continue
    }

    const total = feedbackData?.length || 0

    // Skip if not enough data for reliable metrics
    if (total < 3) continue

    const positiveCount = feedbackData?.filter((f) => f.rating === 1).length || 0
    const negativeCount = total - positiveCount

    // Compute top negative themes using Claude if we have negative feedback
    let topNegativeThemes: string[] = []

    if (negativeCount >= 2) {
      const { data: negativeFeedback } = await supabase
        .from("ai_feedback_log")
        .select("feedback_text")
        .eq("brokerage_id", brokerageId)
        .eq("source_system", sourceSystem)
        .eq("rating", -1)
        .gte("created_at", weekStart.toISOString())
        .lt("created_at", weekEnd.toISOString())
        .not("feedback_text", "is", null)
        .limit(20)

      const feedbackTexts = negativeFeedback
        ?.map((f) => f.feedback_text)
        .filter(Boolean)

      if (feedbackTexts && feedbackTexts.length > 0) {
        try {
          const { object } = await generateObject({
            model: resolveModel("anthropic/claude-sonnet-4-20250514"),
            schema: ThemesSchema,
            system:
              "Identify the top 3 themes in negative feedback. Return JSON: {themes: string[]}",
            prompt: feedbackTexts.join("\n---\n"),
            maxOutputTokens: 150,
          })
          topNegativeThemes = object.themes
        } catch (error) {
          console.error(`[FeedbackAggregator] Error analyzing themes for ${sourceSystem}:`, error)
        }
      }
    }

    // Upsert metrics
    const approvalRate = total > 0 ? Math.round((positiveCount / total) * 100) : 0

    const { error: upsertError } = await supabase
      .from("ai_improvement_metrics")
      .upsert(
        {
          brokerage_id: brokerageId,
          source_system: sourceSystem,
          week_start: weekStart.toISOString().split("T")[0],
          total_feedback: total,
          positive_count: positiveCount,
          negative_count: negativeCount,
          approval_rate: approvalRate,
          top_negative_themes: topNegativeThemes,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "brokerage_id,source_system,week_start",
        }
      )

    if (upsertError) {
      console.error(`[FeedbackAggregator] Error upserting metrics for ${sourceSystem}:`, upsertError)
      continue
    }

    systemsProcessed++
  }

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    event_type: KernelEvent.AI_METRICS_COMPUTED,
    payload: {
      week_start: weekStart.toISOString(),
      systems_processed: systemsProcessed,
    },
  })

  return { systemsProcessed }
}

export async function getWeeklyMetrics(
  brokerageId: string,
  weekStart: Date
): Promise<
  Array<{
    source_system: string
    total_feedback: number
    positive_count: number
    negative_count: number
    approval_rate: number
    top_negative_themes: string[]
  }>
> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("ai_improvement_metrics")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("week_start", weekStart.toISOString().split("T")[0])

  if (error) {
    console.error("[FeedbackAggregator] Error fetching metrics:", error)
    return []
  }

  return data || []
}

export async function getLastTwoWeeksMetrics(
  brokerageId: string
): Promise<
  Array<{
    source_system: string
    week_start: string
    approval_rate: number
    top_negative_themes: string[]
  }>
> {
  const supabase = createServiceClient()

  const twoWeeksAgo = new Date()
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

  const { data, error } = await supabase
    .from("ai_improvement_metrics")
    .select("source_system, week_start, approval_rate, top_negative_themes")
    .eq("brokerage_id", brokerageId)
    .gte("week_start", twoWeeksAgo.toISOString().split("T")[0])
    .order("week_start", { ascending: false })

  if (error) {
    console.error("[FeedbackAggregator] Error fetching last 2 weeks metrics:", error)
    return []
  }

  return data || []
}
