// lib/ai/track-usage.ts
// Tracks AI Gateway usage to the ai_tool_usage table for cost monitoring and analytics

import { createServiceClient } from "@/lib/supabase/service"

export interface AIUsageLog {
  user_id?: string
  agent_id?: string
  brokerage_id?: string
  team_id?: string
  tool_name: string
  feature: string
  model_used: string
  tokens_used: number
  cost_cents?: number
  input_text?: string
  output_text?: string
  context_json?: string
}

/**
 * Log AI Gateway usage to the database for tracking and cost attribution
 */
export async function trackAIUsage(log: AIUsageLog) {
  try {
    const supabase = createServiceClient()
    
    // Insert usage log
    const { error } = await supabase.from("ai_tool_usage").insert({
      user_id: log.user_id,
      agent_id: log.agent_id,
      brokerage_id: log.brokerage_id,
      team_id: log.team_id,
      tool_name: log.tool_name,
      feature: log.feature,
      model_used: log.model_used,
      tokens_used: log.tokens_used,
      cost_cents: log.cost_cents,
      input_text: log.input_text ? log.input_text.substring(0, 500) : null, // Truncate for storage
      output_text: log.output_text ? log.output_text.substring(0, 1000) : null,
      context_json: log.context_json,
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error("[v0] Failed to track AI usage:", error)
      // Don't throw - tracking failures shouldn't break AI generation
    }
  } catch (error) {
    console.error("[v0] Error tracking AI usage:", error)
    // Don't throw - tracking failures shouldn't break AI generation
  }
}

/**
 * Calculate cost based on token usage
 * Pricing estimates (adjust based on your AI Gateway rates):
 * - GPT-4o-mini: ~$0.15/$0.60 per 1M tokens (input/output)
 * - Claude Sonnet: ~$3/$15 per 1M tokens
 */
export function estimateCostCents(model: string, tokensInput: number, tokensOutput: number): number {
  const modelKey = model.toLowerCase()
  
  // Cost per million tokens in cents
  let inputCostPerM = 15  // Default GPT-4o-mini input
  let outputCostPerM = 60 // Default GPT-4o-mini output
  
  if (modelKey.includes('gpt-4o-mini') || modelKey.includes('gpt-4-turbo')) {
    inputCostPerM = 15
    outputCostPerM = 60
  } else if (modelKey.includes('gpt-4')) {
    inputCostPerM = 3000
    outputCostPerM = 6000
  } else if (modelKey.includes('claude')) {
    if (modelKey.includes('haiku')) {
      inputCostPerM = 25
      outputCostPerM = 125
    } else if (modelKey.includes('sonnet')) {
      inputCostPerM = 300
      outputCostPerM = 1500
    } else if (modelKey.includes('opus')) {
      inputCostPerM = 1500
      outputCostPerM = 7500
    }
  }
  
  const inputCost = (tokensInput / 1_000_000) * inputCostPerM
  const outputCost = (tokensOutput / 1_000_000) * outputCostPerM
  
  return Math.ceil(inputCost + outputCost)
}
