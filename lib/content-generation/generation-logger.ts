"use server"

import { createClient } from "@/lib/supabase/server"
import { ContentGenerationOutput } from "./content-generator"

// ============================================
// GENERATION ACTIVITY LOGGING
// Logs all content generation to activities table (ONLY)
// ============================================

/**
 * Log content generation event to activities table
 * This is the ONLY database write allowed by System 4.1
 */
export async function logContentGeneration(params: {
  agent_id: string
  content_output: ContentGenerationOutput
  entity_id?: string // UUID of generated content (runtime only, not persisted)
  entity_type?: string // 'content'
}): Promise<{ success: boolean; activity_id?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("activities")
      .insert({
        agent_id: params.agent_id,
        activity_type: "content_generated",
        title: `Generated ${params.content_output.content_type}`,
        description: `AI-generated ${params.content_output.content_type} content for ${params.content_output.channel_intent || "general"} channel`,
        notes: JSON.stringify({
          content_type: params.content_output.content_type,
          channel_intent: params.content_output.channel_intent,
          intended_audience: params.content_output.intended_audience,
          suggested_usage: params.content_output.suggested_usage,
          generated_at: params.content_output.generated_at,
          word_count: params.content_output.metadata?.word_count,
          character_count: params.content_output.metadata?.character_count,
          // DO NOT store raw_content here (draft only, never persisted)
          content_preview: params.content_output.raw_content.substring(0, 200) + "...",
        }),
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error) {
      console.error("[System 4.1] Failed to log content generation:", error)
      return { success: false, error: error.message }
    }

    return { success: true, activity_id: data.id }
  } catch (error) {
    console.error("[System 4.1] Error logging content generation:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log batch content generation
 */
export async function logBatchContentGeneration(params: {
  agent_id: string
  batch_results: Array<{
    content_output: ContentGenerationOutput
    success: boolean
    error?: string
  }>
}): Promise<{ success: boolean; logged_count: number }> {
  let logged_count = 0

  for (const result of params.batch_results) {
    if (result.success) {
      const log = await logContentGeneration({
        agent_id: params.agent_id,
        content_output: result.content_output,
      })
      if (log.success) {
        logged_count++
      }
    }
  }

  return { success: true, logged_count }
}

/**
 * Log omnipresent content generation (one idea → many formats)
 */
export async function logOmnipresentGeneration(params: {
  agent_id: string
  core_idea: string
  formats_generated: ContentGenerationOutput[]
}): Promise<{ success: boolean; activity_id?: string }> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("activities")
      .insert({
        agent_id: params.agent_id,
        activity_type: "omnipresent_content_generated",
        title: `Generated omnipresent content`,
        description: `AI-generated content across ${params.formats_generated.length} formats from one core idea`,
        notes: JSON.stringify({
          core_idea: params.core_idea,
          formats: params.formats_generated.map((f) => ({
            content_type: f.content_type,
            channel_intent: f.channel_intent,
            word_count: f.metadata?.word_count,
          })),
          generated_at: new Date().toISOString(),
        }),
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error) {
      console.error("[System 4.1] Failed to log omnipresent generation:", error)
      return { success: false }
    }

    return { success: true, activity_id: data.id }
  } catch (error) {
    console.error("[System 4.1] Error logging omnipresent generation:", error)
    return { success: false }
  }
}

/**
 * Get content generation activity history
 * Read from activities table
 */
export async function getContentGenerationHistory(params: {
  agent_id: string
  limit?: number
  content_type?: string
}): Promise<Array<{
  id: string
  title: string
  description: string
  activity_type: string
  notes: any
  completed_at: string
}>> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("id, title, description, activity_type, notes, completed_at")
      .eq("agent_id", params.agent_id)
      .in("activity_type", ["content_generated", "omnipresent_content_generated"])
      .order("completed_at", { ascending: false })

    if (params.limit) {
      query = query.limit(params.limit)
    }

    const { data, error } = await query

    if (error) {
      console.error("[System 4.1] Failed to get content history:", error)
      return []
    }

    // Filter by content_type if specified
    if (params.content_type && data) {
      return data.filter((activity) => {
        try {
          const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes
          return notes.content_type === params.content_type
        } catch {
          return false
        }
      })
    }

    return data || []
  } catch (error) {
    console.error("[System 4.1] Error getting content history:", error)
    return []
  }
}

/**
 * Get content generation stats (aggregated from activities)
 */
export async function getContentGenerationStats(params: {
  agent_id: string
  date_range?: { start: string; end: string }
}): Promise<{
  total_generated: number
  by_content_type: Record<string, number>
  by_channel: Record<string, number>
  recent_generations: number
}> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("notes, completed_at")
      .eq("agent_id", params.agent_id)
      .in("activity_type", ["content_generated", "omnipresent_content_generated"])

    if (params.date_range) {
      query = query.gte("completed_at", params.date_range.start).lte("completed_at", params.date_range.end)
    }

    const { data, error } = await query

    if (error || !data) {
      return { total_generated: 0, by_content_type: {}, by_channel: {}, recent_generations: 0 }
    }

    const stats = {
      total_generated: data.length,
      by_content_type: {} as Record<string, number>,
      by_channel: {} as Record<string, number>,
      recent_generations: 0,
    }

    // Count by type and channel
    for (const activity of data) {
      try {
        const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes
        const contentType = notes.content_type || "unknown"
        const channel = notes.channel_intent || "general"

        stats.by_content_type[contentType] = (stats.by_content_type[contentType] || 0) + 1
        stats.by_channel[channel] = (stats.by_channel[channel] || 0) + 1

        // Count recent (last 7 days)
        const completedAt = new Date(activity.completed_at)
        const sevenDaysAgo = new Date()
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
        if (completedAt >= sevenDaysAgo) {
          stats.recent_generations++
        }
      } catch (e) {
        // Skip malformed entries
      }
    }

    return stats
  } catch (error) {
    console.error("[System 4.1] Error getting content stats:", error)
    return { total_generated: 0, by_content_type: {}, by_channel: {}, recent_generations: 0 }
  }
}
