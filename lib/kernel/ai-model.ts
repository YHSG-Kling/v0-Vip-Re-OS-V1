// lib/kernel/ai-model.ts
// LAYER 0 — AI model resolution for the platform.
//
// Cascade:
//   ROUTING = most specific scope wins  (user > team > brokerage > superadmin > default)
//   CAPPING = strictest tier_cap wins   (all scopes evaluated, lowest tier enforced)
//
// Governance: even explicit caller model requests are capped when actor context
// is available. Platform/brokerage governance always governs individual preference.
//
// Cross-provider capping: MODEL_TIER_ORDER spans all providers. Capping
// "gpt-4-turbo" with "claude-sonnet" returns "claude-sonnet" — a provider switch.
// This is intentional. tier_cap is operator policy, not a quality preference.
// Operators set caps knowing this behavior.
//
// superadmin rows: IMPORTANT — build31 confirms provider_overrides.scope_id is
// nullable (no NOT NULL constraint). Superadmin rows store scope_id = NULL.
// If this schema assumption ever changes, update the scopeFilters logic below.
//
// No side effects. Read-only.

import { createClient } from "@/lib/supabase/server"
import { selectModelForTask } from "@/lib/ai/models"
import type { AIModel } from "@/lib/ai/cost-tracking"

// ─── TIER ORDER ────────────────────────────────────────────────────────────────
// All 10 AIModel literals from lib/ai/cost-tracking.ts, cheapest → most capable.
// Tier ordering crosses provider families intentionally — see file header.
// To add a new model: add it to AIModel in cost-tracking.ts AND insert it
// at the correct tier position here. Do not append blindly to the end.

const MODEL_TIER_ORDER: AIModel[] = [
  "gpt-4o-mini",          // cheapest — simple classification, routing decisions
  "claude-haiku",         // cheap Anthropic — high-volume internal tasks
  "gemini-flash",         // cheap Google — vision tasks
  "perplexity-sonar",     // web search, lightweight research
  "gpt-4o",               // strong OpenAI — structured JSON extraction
  "gemini-pro",           // full Google — vision + analysis
  "perplexity-sonar-pro", // deep web research
  "claude-sonnet",        // main Anthropic — all client-facing content
  "gpt-4-turbo",          // OpenAI high capability
  "claude-opus",          // most capable — premium tier only
]

// Returns the lower-tier model of (requested, cap).
// If requested <= cap in tier order: returns requested unchanged.
// If requested > cap: returns cap (may be a different provider — see header).
// If either model is unknown in the tier list: returns requested unchanged.
function applyTierCap(requested: AIModel, cap: AIModel): AIModel {
  const requestedTier = MODEL_TIER_ORDER.indexOf(requested)
  const capTier       = MODEL_TIER_ORDER.indexOf(cap)
  if (requestedTier === -1 || capTier === -1) return requested
  return requestedTier <= capTier ? requested : cap
}

// ─── TYPES ─────────────────────────────────────────────────────────────────────

export interface ResolveAIModelParams {
  // The feature/task name — must match a key in AI_TASK_ROUTING
  feature: string
  // Full actor context for cascade evaluation
  actorContext: {
    userId:      string
    agentId?:    string   // optional — not all call sites have an agent row
    brokerageId: string
    teamId?:     string
  }
  // Optional: caller's preferred model. Will still be capped by governance rules.
  // If not provided, selectModelForTask(feature) determines the preference.
  requestedModel?: AIModel
}

// Raw row from provider_overrides query
interface RawOverrideRow {
  scope_type: string
  scope_id:   string | null
  config:     Record<string, unknown>
}

// Typed scope row after validation
interface ScopeRow {
  scope_type: string
  scope_id:   string | null
  config:     AIOverrideConfig
}

interface AIOverrideConfig {
  // Per-task model preferences for this scope.
  // Keys must match feature strings in AI_TASK_ROUTING (lib/ai/models.ts).
  model_routing?: Partial<Record<string, AIModel>>
  // Maximum allowed model for this scope. Any model above this tier is clamped.
  // Applies to ALL models resolved at this scope including explicit caller requests.
  tier_cap?: AIModel
}

// ─── RESOLVE AI MODEL ──────────────────────────────────────────────────────────

export async function resolveAIModel(
  params: ResolveAIModelParams
): Promise<AIModel> {
  const { feature, actorContext, requestedModel } = params

  // Layer 1: platform default from static routing table (no DB)
  const { model: platformDefault } = selectModelForTask(feature)

  // Starting preference: explicit caller request if provided, else platform default
  const preferredModel: AIModel = requestedModel ?? platformDefault

  const supabase = await createClient()

  // ── Fetch all applicable override rows in one query ─────────────────────────
  // One query for all scopes — avoids 4 sequential round trips.
  // Filter to only 'ai' provider rows. order by updated_at desc so if the
  // unique index migration hasn't run yet, find() still picks the newest row.
  const { data: rawRows } = await supabase
    .from("provider_overrides")
    .select("scope_type, scope_id, config")
    .eq("provider_type", "ai")
    .eq("enabled", true)
    .in("scope_type", ["superadmin", "brokerage", "team", "user"])
    .order("updated_at", { ascending: false })

  if (!rawRows || rawRows.length === 0) {
    return preferredModel
  }

  // Scope IDs that apply to this actor — used to filter the result set
  // superadmin: scope_id = NULL (confirmed by build31 schema)
  // All others: match on specific UUID
  const applicableScopeIds: Record<string, string | null> = {
    superadmin: null,
    brokerage:  actorContext.brokerageId,
    ...(actorContext.teamId ? { team: actorContext.teamId } : {}),
    user:       actorContext.userId,
  }

  // Filter raw rows to only those that match this actor's scopes
  const applicable: ScopeRow[] = (rawRows as RawOverrideRow[])
    .filter(row => {
      if (!(row.scope_type in applicableScopeIds)) return false
      const expectedId = applicableScopeIds[row.scope_type]
      // superadmin: both must be null
      if (expectedId === null) return row.scope_id === null
      return row.scope_id === expectedId
    })
    .map(row => ({
      scope_type: row.scope_type,
      scope_id:   row.scope_id,
      config:     (row.config ?? {}) as AIOverrideConfig,
    }))

  if (applicable.length === 0) {
    return preferredModel
  }

  // ── ROUTING: most specific scope with model_routing[feature] ────────────────
  // If caller passed an explicit requestedModel, that IS the routing preference.
  // Only fall through to scope routing if no explicit request.
  let routedModel: AIModel = preferredModel

  if (!requestedModel) {
    // No explicit request — find the most specific scope that has a routing entry
    const SCOPE_SPECIFICITY = ["user", "team", "brokerage", "superadmin"]
    for (const scopeType of SCOPE_SPECIFICITY) {
      const row = applicable.find(r => r.scope_type === scopeType)
      const entry = row?.config?.model_routing?.[feature]
      if (entry) {
        routedModel = entry as AIModel
        break
      }
    }
  }

  // ── CAPPING: strictest tier_cap across ALL applicable scopes ─────────────────
  // Collect every cap that applies to this actor regardless of routing scope.
  // Strictest (lowest tier index) wins.
  // This ensures brokerage/superadmin governance governs user-level overrides.
  let effectiveCap: AIModel | null = null

  for (const row of applicable) {
    const cap = row.config?.tier_cap
    if (!cap) continue
    if (effectiveCap === null) {
      effectiveCap = cap
    } else {
      const existingTier = MODEL_TIER_ORDER.indexOf(effectiveCap)
      const newTier      = MODEL_TIER_ORDER.indexOf(cap)
      if (newTier !== -1 && (existingTier === -1 || newTier < existingTier)) {
        effectiveCap = cap
      }
    }
  }

  // ── FINAL: apply strictest cap to routed model ───────────────────────────────
  if (effectiveCap) {
    return applyTierCap(routedModel, effectiveCap)
  }
  return routedModel
}
