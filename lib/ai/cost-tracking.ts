import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export type AIModel =
  | "claude-sonnet"
  | "claude-opus"
  | "claude-haiku"
  | "gpt-4o"
  | "gpt-4-turbo"
  | "gpt-4o-mini"
  | "gpt-5-mini"
  | "gemini-pro"
  | "gemini-flash"
  | "perplexity-sonar"
  | "perplexity-sonar-pro"

/**
 * Get current pricing for all AI models
 * Pricing is per 1 MILLION tokens in USD
 *
 * VERIFIED 2026-09-12 against the Vercel AI Gateway catalog
 * (docs/ai-agent-surfaces-2026-09.md §2 — Exa research against
 * vercel.com/ai-gateway/models). Each row's `source` is that model's own
 * gateway catalog page. This replaced a stale table that priced claude-sonnet
 * / claude-haiku / gemini-flash at OLDER model generations' rates — a wrong
 * number here is a wrong invoice (CLAUDE.md §5).
 */
export function getModelPricing(): Record<AIModel, {
  input: number      // Price per 1M tokens in USD
  output: number     // Price per 1M tokens in USD
  lastUpdated: string // ISO date when pricing was verified
  source: string      // Gateway catalog page this row was verified against
}> {
  return {
    // anthropic/claude-sonnet-4.6
    "claude-sonnet": {
      input: 3.00,   // $3 per 1M input tokens
      output: 15.00, // $15 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/claude-sonnet-4.6"
    },
    // anthropic/claude-opus-4.6 — price unchanged this wave (out of scope:
    // no chat surface routes to opus), but re-verified present in the
    // gateway's GatewayModelId union on 2026-09-12 (@ai-sdk/gateway).
    "claude-opus": {
      input: 5.00,   // $5 per 1M input tokens (Opus 4.6 — the $15/$75 rows were Opus 3/4 list)
      output: 25.00, // $25 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/claude-opus-4.6"
    },
    // anthropic/claude-haiku-4.5
    "claude-haiku": {
      input: 1.00,   // $1 per 1M input tokens
      output: 5.00,  // $5 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/claude-haiku-4.5"
    },

    // openai/gpt-4o
    "gpt-4o": {
      input: 2.50,   // $2.50 per 1M input tokens
      output: 10.00, // $10 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/gpt-4o"
    },
    "gpt-4-turbo": {
      input: 10.00,  // $10 per 1M input tokens
      output: 30.00, // $30 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/gpt-4-turbo"
    },
    // openai/gpt-4o-mini
    "gpt-4o-mini": {
      input: 0.15,   // $0.15 per 1M input tokens
      output: 0.60,  // $0.60 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/gpt-4o-mini"
    },
    // openai/gpt-5-mini — new key this wave (docs/ai-agent-surfaces-2026-09.md §2)
    "gpt-5-mini": {
      input: 0.25,   // $0.25 per 1M input tokens
      output: 2.00,  // $2.00 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/gpt-5-mini"
    },

    // google/gemini-2.5-pro
    "gemini-pro": {
      input: 1.25,   // $1.25 per 1M input tokens (≤200K prompt tier)
      output: 10.00, // $10 per 1M output tokens (Gemini 2.5 Pro — the $5 row was 1.5 Pro list)
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/gemini-2.5-pro"
    },
    // google/gemini-2.5-flash
    "gemini-flash": {
      input: 0.30,   // $0.30 per 1M input tokens
      output: 2.50,  // $2.50 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/gemini-2.5-flash"
    },

    // perplexity/sonar
    "perplexity-sonar": {
      input: 1.00,   // $1 per 1M input tokens
      output: 1.00,  // $1 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/sonar (provider rate: docs.perplexity.ai/docs/pricing)"
    },
    // perplexity/sonar-pro
    "perplexity-sonar-pro": {
      input: 3.00,   // $3 per 1M input tokens
      output: 15.00, // $15 per 1M output tokens
      lastUpdated: "2026-09-12",
      source: "https://vercel.com/ai-gateway/models/sonar-pro (provider rate: docs.perplexity.ai/docs/pricing)"
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
  /**
   * Additive fields merged onto `context_json` beside the token/pricing
   * snapshot below — for a caller whose usage row needs to carry something
   * this ledger's fixed columns do not (e.g. lib/voice/twilio-voice.ts's
   * `toolRound` / `deadlineHit` flags, blind-spot burn-down, lane 74C). Never
   * overwrites `input_tokens` / `output_tokens` / `request_id` /
   * `pricing_snapshot` — those are spread first, so a caller cannot silently
   * clobber the cost-ledger's own fields.
   */
  contextExtra?: Record<string, unknown> | null
  /**
   * Lane 86D (m668) — the PLATFORM's own AI agents (prospect chat, platform
   * voice line, platform live avatar) serve prospects with no tenant. Their
   * rows land with brokerage_id NULL and `platform_paid = true`: on the ledger
   * (manager-ops reads them), never on any tenant's counters, cap or invoice.
   * Ignored (and never stamped) when a brokerageId is present — tenant spend
   * is never relabelled platform spend.
   */
  platformPaid?: boolean
}): Promise<void> {
  // A row with neither tenant, user nor platform flag is refused by
  // ai_tool_usage_anon_rows_carry_tenant — say so here instead of letting the
  // insert fail into a console line nobody reads.
  const platformPaid = !params.brokerageId && params.platformPaid === true
  if (!params.brokerageId && !params.userId && !platformPaid) {
    console.warn(`[cost-tracking] ai_tool_usage row for feature "${params.feature}" has no tenant, user or platform flag — not booked`)
    return
  }
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
        // Spread ONLY when true (m668 applied live 2026-09-27; the column
        // defaults false, so tenant rows need not name it).
        ...(platformPaid ? { platform_paid: true } : {}),
        context_json: {
          input_tokens: params.inputTokens,
          output_tokens: params.outputTokens,
          request_id: params.requestId,
          pricing_snapshot: pricing,
          ...(params.contextExtra ?? {}),
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

/** The idempotency key a stored context_json (TEXT holding JSON, or an object) carries, or null. */
function contextKey(raw: unknown): string | null {
  try {
    const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as { idempotency_key?: unknown } | null
    return typeof o?.idempotency_key === "string" ? o.idempotency_key : null
  } catch { return null }
}

/**
 * THE IMAGE-SPEND BOOKING (wave 139, lane 139C) — logAIUsage's sibling for a model call priced PER
 * IMAGE, not per token. Before it, OpenAI image generation / photo edits (lib/ai/image-generation.ts,
 * lib/listings/photo-intelligence.ts) reached the AI Gateway (or the direct key) and booked NOTHING
 * unless one of two callers hand-rolled an ai_tool_usage insert — spend invisible to per-manager cost,
 * the per-agent P&L and the Finance Manager. Same ledger (ai_tool_usage, CLAUDE.md §5), same tenant
 * rules as logAIUsage (a tenant, a user, or the m668 platform flag), plus:
 *   · model_used stays NULL (the column is CHECK-constrained to TEXT models) — the image model, the
 *     price state, the cost basis and the unit ride context_json, exactly where the two existing
 *     hand-rolled image bookings already put them;
 *   · an IDEMPOTENCY KEY — a retried step / re-run cron books the charge ONCE (tenant-pinned read;
 *     m750's unique index holds it under a race → 23505 is "already booked", not a failure);
 *   · an UNKNOWN cost books the image at 0¢ with price_state 'unknown' (never a guessed number).
 * Never throws; returns what happened so the caller can report it.
 */
export async function logAIImageUsage(
  params: {
    brokerageId: string | null
    userId?: string | null
    agentId?: string | null
    feature: string
    manager?: string | null
    /** The image model that SERVED the call ("openai/gpt-image-1", "dall-e-3"). */
    model: string
    images?: number
    /** null = unknown price. */
    costUsd: number | null
    priceState: "fixed" | "variable" | "unknown" | "free"
    costBasis: "estimated" | "final"
    idempotencyKey?: string | null
    platformPaid?: boolean
    contextExtra?: Record<string, unknown> | null
  },
  deps: { client?: ReturnType<typeof createServiceClient> } = {},
): Promise<{ booked: boolean; duplicate: boolean; error: string | null }> {
  const platformPaid = !params.brokerageId && params.platformPaid === true
  if (!params.brokerageId && !params.userId && !platformPaid) {
    return { booked: false, duplicate: false, error: `image spend for "${params.feature}" has no tenant, user or platform flag — not booked` }
  }
  try {
    const svc = deps.client ?? createServiceClient()
    const key = (params.idempotencyKey ?? "").trim() || null
    if (key) {
      // context_json is a TEXT column (live schema) holding compact JSON — narrowed with LIKE on the
      // serialized key, then CONFIRMED by parsing each candidate (a LIKE is a superset, never the proof).
      const needle = `%"idempotency_key":${JSON.stringify(key).replace(/[%_\\]/g, (c) => `\\${c}`)}%`
      let q = svc.from("ai_tool_usage").select("id, context_json").like("context_json", needle)
      q = params.brokerageId ? q.eq("brokerage_id", params.brokerageId) : q.is("brokerage_id", null)
      const { data: prior, error: priorErr } = await q.limit(5)
      if (priorErr) console.error("[cost-tracking] image-spend idempotency lookup refused, booking anyway (the unique index still holds):", priorErr.message)
      else if (((prior ?? []) as Array<{ context_json: unknown }>).some((r) => contextKey(r.context_json) === key)) return { booked: false, duplicate: true, error: null }
    }
    const unknown = params.priceState === "unknown" || params.costUsd === null
    const { data, error } = await svc.from("ai_tool_usage").insert({
      user_id: params.userId ?? null,
      brokerage_id: params.brokerageId,
      agent_id: params.agentId ?? null,
      tool_name: "image_generation",
      // 0 BY CONSTRAINT: ai_tool_usage_tokens_name_their_model refuses tokens without a (text) model_used.
      tokens_used: 0,
      model_used: null,
      cost_cents: unknown ? 0 : Math.round((params.costUsd as number) * 100),
      feature: params.feature,
      manager: params.manager ?? null,
      success: true,
      ...(platformPaid ? { platform_paid: true } : {}),
      context_json: {
        ...(params.contextExtra ?? {}),
        model: params.model,
        unit: "image",
        images: params.images ?? 1,
        cost_usd: unknown ? null : params.costUsd,
        price_state: unknown ? "unknown" : params.priceState,
        cost_basis: params.costBasis,
        coverage: "platform_covered",
        ...(key ? { idempotency_key: key } : {}),
      },
    }).select("id")
    if (error && key && String((error as { code?: string }).code ?? "") === "23505") return { booked: false, duplicate: true, error: null }
    if (error) {
      console.error("[cost-tracking] image spend NOT booked on ai_tool_usage:", error.message)
      return { booked: false, duplicate: false, error: error.message }
    }
    const n = ((data ?? []) as unknown[]).length
    return n === 1 ? { booked: true, duplicate: false, error: null } : { booked: false, duplicate: false, error: `ai_tool_usage insert returned ${n} rows` }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    console.error("[cost-tracking] image spend booking threw:", m)
    return { booked: false, duplicate: false, error: m }
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
