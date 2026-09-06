import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export type AIModel = 
  | "claude-sonnet" 
  | "claude-opus" 
  | "claude-haiku" 
  | "gpt-4o" 
  | "gpt-4-turbo" 
  | "gpt-4o-mini" 
  | "gemini-pro" 
  | "gemini-flash" 
  | "perplexity-sonar" 
  | "perplexity-sonar-pro"

/**
 * Get current pricing for all AI models
 * Pricing is per 1 MILLION tokens in USD
 * Links to provider pricing pages included for verification
 */
export function getModelPricing(): Record<AIModel, {
  input: number      // Price per 1M tokens in USD
  output: number     // Price per 1M tokens in USD
  lastUpdated: string // ISO date when pricing was verified
}> {
  return {
    // Anthropic pricing: https://www.anthropic.com/pricing
    "claude-sonnet": {
      input: 3.00,   // $3 per 1M input tokens
      output: 15.00, // $15 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    "claude-opus": {
      input: 15.00,  // $15 per 1M input tokens
      output: 75.00, // $75 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    "claude-haiku": {
      input: 0.25,   // $0.25 per 1M input tokens
      output: 1.25,  // $1.25 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    
    // OpenAI pricing: https://openai.com/pricing
    "gpt-4o": {
      input: 2.50,   // $2.50 per 1M input tokens
      output: 10.00, // $10 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    "gpt-4-turbo": {
      input: 10.00,  // $10 per 1M input tokens
      output: 30.00, // $30 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    "gpt-4o-mini": {
      input: 0.15,   // $0.15 per 1M input tokens
      output: 0.60,  // $0.60 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    
    // Google AI pricing: https://ai.google.dev/pricing
    "gemini-pro": {
      input: 1.25,   // $1.25 per 1M input tokens
      output: 5.00,  // $5 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    "gemini-flash": {
      input: 0.075,  // $0.075 per 1M input tokens
      output: 0.30,  // $0.30 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    
    // Perplexity pricing: https://docs.perplexity.ai/docs/pricing
    "perplexity-sonar": {
      input: 1.00,   // $1 per 1M input tokens
      output: 1.00,  // $1 per 1M output tokens
      lastUpdated: "2026-02-20"
    },
    "perplexity-sonar-pro": {
      input: 3.00,   // $3 per 1M input tokens
      output: 15.00, // $15 per 1M output tokens
      lastUpdated: "2026-02-20"
    }
  }
}

/**
 * Calculate cost in CENTS for a given model and token usage
 */
export function calculateCost(
  model: AIModel,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing()[model]
  
  if (!pricing) {
    console.warn(`[v0] Unknown model "${model}" - returning 0 cost`)
    return 0
  }
  
  // Calculate cost in dollars per 1M tokens
  const inputCostDollars = (inputTokens / 1_000_000) * pricing.input
  const outputCostDollars = (outputTokens / 1_000_000) * pricing.output
  const totalCostDollars = inputCostDollars + outputCostDollars
  
  // Convert to cents and round up
  return Math.ceil(totalCostDollars * 100)
}

/**
 * Estimate token count from text
 * Simple heuristic: ~4 characters per token
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Log AI usage to database and update monthly aggregates
 */
export async function logAIUsage(params: {
  /**
   * Nullable BY DESIGN (#187): null = anonymous tenant traffic — a public
   * widget visitor or a D-ID avatar turn with no authenticated staff seat.
   * The cost still belongs to the tenant, so a null-user row MUST carry
   * brokerage_id (enforced by ai_tool_usage_anon_rows_carry_tenant, m476).
   */
  userId: string | null
  /**
   * Nullable BY DESIGN. Callers used to coerce a missing tenant to `""`, which
   * Postgres rejects for a uuid column (22P02) — so the whole usage row was
   * refused and the error swallowed below. A background job with no tenant
   * still deserves to be in the ledger; it lands with brokerage_id NULL rather
   * than not landing at all.
   */
  brokerageId: string | null
  teamId?: string | null
  agentId?: string | null
  model: AIModel
  inputTokens: number
  outputTokens: number
  feature: string
  requestId?: string
  /** The governed AI manager (agent_kind) responsible for this call — powers per-manager
   *  cost/latency/SLO (lib/platform/manager-ops.ts). Additive; unset rolls up under 'unassigned'. */
  manager?: string | null
  /** Wall-clock latency of the model call, for per-manager p95. */
  executionTimeMs?: number | null
  /** false if the call errored — feeds per-manager error-rate. Defaults to true. */
  success?: boolean
}): Promise<void> {
  try {
    // SERVICE CLIENT, like every other usage writer (log-media-usage,
    // incrementUsage). The ledger's identity fields are server-resolved by the
    // caller (streamTextRouted's contract), and the rows it writes are not the
    // caller's own: the anonymous lanes (widget visitor, D-ID avatar turn)
    // have no session at all, and the widget attributes to the ASSIGNED
    // AGENT's user while auth.uid() is null. Under the cookie client every
    // ai_tool_usage insert policy (user_id = auth.uid(); tenant insert
    // TO authenticated) refused those rows and the refusal was swallowed
    // below — unbilled, uncapped spend.
    const supabase = createServiceClient()
    const totalTokens = params.inputTokens + params.outputTokens
    const costCents = calculateCost(params.model, params.inputTokens, params.outputTokens)
    const pricing = getModelPricing()[params.model]

    // Insert into ai_tool_usage table
    const { error: insertError } = await supabase
      .from("ai_tool_usage")
      .insert({
        user_id: params.userId,
        tool_name: "ai_model",
        tokens_used: totalTokens,
        model_used: params.model,
        cost_cents: costCents,
        brokerage_id: params.brokerageId,
        team_id: params.teamId,
        agent_id: params.agentId,
        feature: params.feature,
        manager: params.manager ?? null,
        execution_time_ms: params.executionTimeMs ?? null,
        success: params.success ?? true,
        context_json: {
          input_tokens: params.inputTokens,
          output_tokens: params.outputTokens,
          request_id: params.requestId,
          pricing_snapshot: pricing
        }
      })
    
    if (insertError) {
      console.error("[v0] Failed to log AI usage:", insertError)
    }
    
    // Update monthly aggregates using RPC function
    // Parameters must be in exact order: p_brokerage_id, p_month, p_tokens_input, p_tokens_output, p_cost_cents, p_model, p_feature, p_team_id, p_agent_id
    const currentMonth = new Date().toISOString().slice(0, 7) + "-01" // YYYY-MM-01 format

    // The monthly aggregate is PER BROKERAGE — there is nothing to increment
    // without one, and calling it with null would fail inside the function.
    // Skipped explicitly rather than fired and swallowed.
    if (params.brokerageId) {
      const { error: rpcError } = await supabase.rpc("increment_ai_usage_monthly", {
        p_brokerage_id: params.brokerageId,
        p_month: currentMonth,
        p_tokens_input: params.inputTokens,
        p_tokens_output: params.outputTokens,
        p_cost_cents: costCents,
        p_model: params.model,
        p_feature: params.feature,
        p_team_id: params.teamId || null,
        p_agent_id: params.agentId || null
      })

      if (rpcError) {
        console.error("[v0] Failed to increment monthly usage:", rpcError)
      }
    }

    // Bump the generic usage_counters row so lib/usage/check-cap.ts sees
    // AI consumption against the 'ai_tokens_monthly' fair-use metric.
    // Without this the cap check would always read zero and never trip.
    if (params.brokerageId) {
      try {
        const { incrementUsage } = await import("@/lib/usage")
        await incrementUsage(params.brokerageId, "ai_tokens_monthly", totalTokens)
      } catch (counterError) {
        console.error("[v0] Failed to bump ai_tokens_monthly counter:", counterError)
      }
    }

    // THE BILLING METER — `billing_usage.ai_calls_count`.
    //
    // A DIFFERENT RAIL from the three writes above, with different readers, and
    // it had NO WRITER ANYWHERE IN THE PRODUCT. `ai_usage_log` is the per-call
    // ledger, `ai_usage_monthly` is the token rollup, `usage_counters` is the
    // fair-use cap rail — and `billing_usage` is what the tenant's usage bars
    // (app/settings/billing/usage-section.tsx) and the OVERAGE PROJECTION
    // (app/components/features/admin/overage-calculator.tsx →
    // lib/kernel/billing.ts calculateOverageExposure) read. Both showed zero for
    // every tenant on every day because nothing ever wrote the table.
    //
    // The unit is CALLS, not tokens: `ai_calls_count` counts requests, and every
    // invocation of logAIUsage is exactly one completed model call. Tokens are
    // already metered on the two rails above; folding them in here would make
    // the overage projection compare token counts against a call allowance.
    if (params.brokerageId) {
      try {
        const { recordUsageEvent } = await import("@/lib/kernel/billing")
        const metered = await recordUsageEvent({
          brokerageId: params.brokerageId,
          metric: "ai_calls",
          units: 1,
        })
        if (!metered.success) {
          console.warn("[v0] billing_usage ai_calls not recorded:", metered.error)
        }
      } catch (meterError) {
        console.error("[v0] Failed to record billing_usage ai_calls:", meterError)
      }
    }
  } catch (error) {
    console.error("[v0] Error in logAIUsage:", error)
    // Don't throw - logging failures shouldn't break the application
  }
}

/**
 * Get current month's usage statistics
 */
export async function getCurrentMonthUsage(params: {
  brokerageId?: string
  teamId?: string
  agentId?: string
}): Promise<{
  totalTokens: number
  totalCostCents: number
  usageByModel: Record<string, { tokens: number; cost_cents: number }>
  usageByFeature: Record<string, { tokens: number; cost_cents: number }>
} | null> {
  try {
    const supabase = await createClient()
    
    const { data, error } = await supabase.rpc("get_current_month_usage", {
      p_brokerage_id: params.brokerageId || null,
      p_team_id: params.teamId || null,
      p_agent_id: params.agentId || null
    })
    
    if (error) {
      console.error("[v0] Failed to get current month usage:", error)
      return null
    }
    
    return data
  } catch (error) {
    console.error("[v0] Error in getCurrentMonthUsage:", error)
    return null
  }
}

/**
 * Check if AI features are enabled at platform level.
 *
 * READ ON THE SERVICE CLIENT, DELIBERATELY. This is a PLATFORM kill switch —
 * `emergency_mode` and `ai_enabled` are the superadmin's stop button for every
 * tenant at once — and it holds no tenant data, so there is nothing here for
 * a caller's own session to scope. Reading it through `createClient()` made the
 * switch depend on the CALLER's row-level permissions, and the failure below is
 * fail-OPEN: a refused read returns `{ enabled: true }`. That combination means
 * any caller who could not read `platform_settings` would sail past a live
 * emergency stop while the log line scrolled by. The service client removes the
 * dependency entirely, which is also what lets `platform_settings` come off
 * `SELECT USING (true) TO PUBLIC` (m417) without disarming the switch.
 *
 * Fail-open is kept on purpose: a settings outage should not take AI down for
 * every tenant. What changes is that the read now actually succeeds.
 */
export async function checkPlatformAIEnabled(): Promise<{
  enabled: boolean
  reason?: string
}> {
  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("platform_settings")
      .select("ai_enabled, emergency_mode")
      .eq("id", true)
      .single()
    
    if (error) {
      console.error("[v0] Failed to check platform AI settings:", error)
      // Fail open - allow AI if we can't check settings
      return { enabled: true }
    }
    
    if (!data) {
      // No settings found - fail open
      return { enabled: true }
    }
    
    if (data.emergency_mode) {
      return { 
        enabled: false, 
        reason: "Platform is in emergency mode - AI features temporarily disabled" 
      }
    }
    
    if (!data.ai_enabled) {
      return { 
        enabled: false, 
        reason: "AI features are disabled at platform level" 
      }
    }
    
    return { enabled: true }
  } catch (error) {
    console.error("[v0] Error checking platform AI settings:", error)
    // Fail open on errors
    return { enabled: true }
  }
}
