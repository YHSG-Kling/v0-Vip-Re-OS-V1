"use server"

/**
 * Public-facing server action for property valuation.
 *
 * Two consumers:
 *   - Public Home Value page (homeowner submits address → gets evaluation)
 *   - Agent CRM "Run CMA" button (agent submits → gets agent-mode evaluation)
 *
 * The underlying engine in lib/property/property-evaluation.ts is the same;
 * this file just exposes it as a server action.
 */

import { createServiceClient } from "@/lib/supabase/service"
import {
  evaluatePropertyValue,
  type PropertyEvaluation,
  type EvaluationAudience,
} from "@/lib/property/property-evaluation"

export type { PropertyEvaluation, EvaluationAudience }

/**
 * WHY THE TENANT IS RESOLVED HERE AND NOT ACCEPTED FROM THE CALLER.
 *
 * Investor mode now pulls REAL rental comparables, and that pull is metered and
 * budget-capped against a brokerage. This file is a `"use server"` module, so
 * every export is a public HTTP endpoint and every argument is attacker-
 * controlled — a `brokerageId` parameter would let anyone on the internet spend
 * an arbitrary tenant's RentCast budget by naming them.
 *
 * `agentId` is already public (the home-value page is built from a public agent
 * slug and the sibling lead-capture action already takes it), and it is a UUID,
 * so it is not enumerable. It is resolved SERVER-SIDE to the brokerage that owns
 * it. The worst an attacker can do is spend the budget of an agent whose id they
 * already had — the same exposure the page's existing lead capture carries — and
 * the eligibility gate and vendor budget cap still stand in front of it.
 *
 * No agent id → no rental lookup, and the report says so instead of estimating.
 */
async function resolveAgentTenant(
  agentId: string | null | undefined,
): Promise<{ brokerageId: string | null; agentUserId: string | null }> {
  if (!agentId) return { brokerageId: null, agentUserId: null }
  const svc = createServiceClient()
  // supabase-js RESOLVES a refused read; destructure and check rather than
  // trusting `data` alone. A refused read must not become "no tenant" silently
  // in the log, though it does produce the same honest no-rent outcome.
  const { data, error } = await svc
    .from("agents")
    .select("brokerage_id, user_id")
    .eq("id", agentId)
    .maybeSingle()
  if (error) {
    console.error("[property-evaluation] could not resolve agent tenant:", error.message)
    return { brokerageId: null, agentUserId: null }
  }
  const row = data as { brokerage_id: string | null; user_id: string | null } | null
  return { brokerageId: row?.brokerage_id ?? null, agentUserId: row?.user_id ?? null }
}

export async function evaluatePropertyAction(params: {
  address: string
  city: string
  state: string
  zip?: string
  audience?: EvaluationAudience
  /** The public agent whose branded page this evaluation was requested from.
   *  Used ONLY to resolve the tenant a rental-comp lookup is metered against. */
  agentId?: string | null
}): Promise<PropertyEvaluation> {
  const { brokerageId, agentUserId } = await resolveAgentTenant(params.agentId)
  return evaluatePropertyValue({
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    audience: params.audience,
    brokerageId,
    agentUserId,
    systemSource: "home_value_investor_report",
  })
}
