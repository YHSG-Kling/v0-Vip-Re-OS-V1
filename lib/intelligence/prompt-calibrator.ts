import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

const CalibrationSchema = z.object({
  system_prompt_additions: z.string(),
  avoid_patterns: z.array(z.string()),
  suggested_examples: z.string(),
})

export interface CalibrationResult {
  sourceSystem: string
  approvalRateBefore: number
  promptChanges: {
    system_prompt_additions: string
    avoid_patterns: string[]
    suggested_examples: string
  }
}

export async function calibrateSystemPrompts(
  brokerageId: string
): Promise<{ calibrations: CalibrationResult[] }> {
  const supabase = createServiceClient()
  const calibrations: CalibrationResult[] = []

  // Load last 4 weeks of metrics for this brokerage where approval_rate < 70
  const fourWeeksAgo = new Date()
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28)

  const { data: underperformingMetrics, error: metricsError } = await supabase
    .from("ai_improvement_metrics")
    .select("source_system, week_start, approval_rate, top_negative_themes")
    .eq("brokerage_id", brokerageId)
    .gte("week_start", fourWeeksAgo.toISOString().split("T")[0])
    .lt("approval_rate", 70)
    .order("week_start", { ascending: false })

  if (metricsError) {
    console.error("[PromptCalibrator] Error fetching metrics:", metricsError)
    return { calibrations: [] }
  }

  if (!underperformingMetrics || underperformingMetrics.length === 0) {
    return { calibrations: [] }
  }

  // Group by source_system and get unique underperforming systems
  const systemsToCalibrate = new Map<
    string,
    { themes: string[]; approvalRate: number }
  >()

  for (const metric of underperformingMetrics) {
    const existing = systemsToCalibrate.get(metric.source_system)
    if (!existing) {
      systemsToCalibrate.set(metric.source_system, {
        themes: metric.top_negative_themes || [],
        approvalRate: metric.approval_rate,
      })
    } else {
      // Merge themes from multiple weeks
      const mergedThemes = [
        ...new Set([...existing.themes, ...(metric.top_negative_themes || [])]),
      ]
      existing.themes = mergedThemes.slice(0, 6) // Max 6 themes
      // Keep the most recent approval rate
    }
  }

  // For each underperforming system, generate calibration
  for (const [sourceSystem, data] of systemsToCalibrate) {
    if (data.themes.length === 0) continue

    try {
      const { object: promptChanges } = await generateObject({
        model: resolveModel("anthropic/claude-sonnet-4-20250514"),
        schema: CalibrationSchema,
        system: `You are an AI quality engineer. Based on the negative feedback themes, suggest specific system prompt improvements to increase quality. Return JSON with:
- system_prompt_additions: A paragraph of guidance to add to the system prompt
- avoid_patterns: Array of specific patterns/behaviors to avoid
- suggested_examples: Example good outputs that demonstrate the desired quality`,
        prompt: JSON.stringify({
          source_system: sourceSystem,
          negative_themes: data.themes,
          current_approval_rate: data.approvalRate,
        }),
        maxOutputTokens: 500,
      })

      // Insert into model_retraining_log
      const { data: insertedLog, error: insertError } = await supabase
        .from("model_retraining_log")
        .insert({
          brokerage_id: brokerageId,
          source_system: sourceSystem,
          trigger_type: "weekly_batch",
          feedback_records_used: data.themes.length,
          approval_rate_before: data.approvalRate,
          prompt_changes: promptChanges,
          status: "completed",
        })
        .select("id")
        .single()

      if (insertError) {
        console.error(`[PromptCalibrator] Error inserting log for ${sourceSystem}:`, insertError)
        continue
      }

      calibrations.push({
        sourceSystem,
        approvalRateBefore: data.approvalRate,
        promptChanges,
      })

      // Create smart_assistant_suggestion for admins
      await supabase.from("smart_assistant_suggestions").insert({
        brokerage_id: brokerageId,
        agent_id: null, // Admin-level suggestion
        title: `AI Quality Alert: ${formatSystemName(sourceSystem)} needs attention`,
        description: `Approval rate ${data.approvalRate}% — suggested improvements available. Review the calibration log for recommended prompt changes.`,
        priority: "medium",
        context_type: "ai_quality",
        metadata: {
          source_system: sourceSystem,
          approval_rate: data.approvalRate,
          calibration_log_id: insertedLog?.id,
        },
        status: "pending",
      })
    } catch (error) {
      console.error(`[PromptCalibrator] Error calibrating ${sourceSystem}:`, error)
    }
  }

  // Emit through the canonical emitter — INSERT + reactor fan-out in one call.
  if (calibrations.length > 0) {
    await emitKernelEvent({
      event:       KernelEvent.PROMPT_CALIBRATION_UPDATED,
      brokerageId,
      entityType:  "prompt_calibration",
      entityId:    brokerageId,
      metadata: {
        systems_calibrated: calibrations.map((c) => c.sourceSystem),
        total_calibrations: calibrations.length,
      },
    })
  }

  return { calibrations }
}

export async function getCalibrationLog(
  brokerageId: string,
  limit = 20
): Promise<
  Array<{
    id: string
    source_system: string
    trigger_type: string
    feedback_records_used: number
    approval_rate_before: number
    prompt_changes: {
      system_prompt_additions: string
      avoid_patterns: string[]
      suggested_examples: string
    }
    status: string
    created_at: string
  }>
> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("model_retraining_log")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[PromptCalibrator] Error fetching calibration log:", error)
    return []
  }

  return data || []
}

function formatSystemName(system: string): string {
  return system
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
