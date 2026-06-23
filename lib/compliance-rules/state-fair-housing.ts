/**
 * State-specific fair housing protected-class evaluator.
 *
 * The federal Fair Housing Act covers 7 classes. State laws often add more
 * (CA source of income, NY arrest record, MA marital status, etc.). This
 * module loads the active protected classes for a brokerage's state and
 * extends the existing rule-evaluators.ts federal check.
 *
 * Cache: state_protected_classes is reference data; cached in-process for
 * 5 minutes to keep the eval path cheap.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { RuleViolation } from "./rule-evaluators"

interface StateClassRow {
  protected_class:      string
  regulation_reference: string
  severity_default:     "low" | "medium" | "high" | "critical"
  patterns:             string[]
}

const cache = new Map<string, { rows: StateClassRow[]; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

async function loadStateClasses(stateCode: string): Promise<StateClassRow[]> {
  const upper = stateCode.toUpperCase()
  const cached = cache.get(upper)
  if (cached && cached.expiresAt > Date.now()) return cached.rows

  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("state_protected_classes")
      .select("protected_class, regulation_reference, severity_default, patterns")
      .eq("state_code", upper)
      .eq("is_active", true)
    const rows = (data ?? []) as StateClassRow[]
    cache.set(upper, { rows, expiresAt: Date.now() + CACHE_TTL_MS })
    return rows
  } catch (err) {
    console.error("[state-fair-housing] load failed:", err)
    return []
  }
}

/**
 * Run state-specific protected-class checks against content.
 * Returns RuleViolation[] (same shape as the federal evaluator) so callers
 * can concat() and present a unified violation list to the admin.
 */
export async function evaluateStateProtectedClasses(params: {
  content:   string
  stateCode: string | null | undefined
}): Promise<RuleViolation[]> {
  if (!params.stateCode) return []
  const classes = await loadStateClasses(params.stateCode)
  if (classes.length === 0) return []

  const violations: RuleViolation[] = []
  const lower = params.content.toLowerCase()

  for (const c of classes) {
    // 1. Direct mention of the protected-class name (high severity)
    const className = c.protected_class.toLowerCase()
    if (lower.includes(className)) {
      violations.push({
        rule_category:        "regulatory",
        rule_name:            `state_fair_housing_${c.protected_class.replace(/\s+/g, "_")}`,
        severity:             c.severity_default === "critical" ? "high" : c.severity_default,
        description:          `Content references "${c.protected_class}" — a state-protected class under ${c.regulation_reference}.`,
        offending_excerpt:    c.protected_class,
        suggested_fix:        "Rewrite to describe property features instead of demographic categories.",
        regulation_reference: c.regulation_reference,
      })
    }

    // 2. Pattern-based detection (state-specific phrasings like "no Section 8")
    for (const pat of c.patterns ?? []) {
      try {
        const re = new RegExp(pat, "gi")
        const matches = params.content.match(re)
        if (matches && matches.length > 0) {
          violations.push({
            rule_category:        "regulatory",
            rule_name:            `state_fair_housing_pattern_${c.protected_class.replace(/\s+/g, "_")}`,
            severity:             c.severity_default === "critical" ? "high" : c.severity_default,
            description:          `Phrase "${matches[0]}" violates ${c.protected_class} protections in ${params.stateCode}.`,
            offending_excerpt:    matches[0],
            suggested_fix:        "Remove or rephrase to focus on property features.",
            regulation_reference: c.regulation_reference,
          })
        }
      } catch (err) {
        // Invalid regex — skip and continue
        console.warn("[state-fair-housing] invalid pattern:", pat, err)
      }
    }
  }

  return violations
}

// The canonical advisory formatter lives in the pure (non-server-only) sibling so simulators
// and client paths can reuse it; re-exported here for callers already importing from this module.
export { formatStateFairHousingAdvisory } from "./state-fair-housing-format"

/**
 * Resolve the state for a brokerage (used by the compliance engine to know
 * which extra classes apply). Returns null when brokerage has no state.
 */
export async function resolveBrokerageState(brokerageId: string): Promise<string | null> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("brokerages")
      .select("state")
      .eq("id", brokerageId)
      .maybeSingle()
    return (data?.state as string | null)?.toUpperCase() ?? null
  } catch {
    return null
  }
}
