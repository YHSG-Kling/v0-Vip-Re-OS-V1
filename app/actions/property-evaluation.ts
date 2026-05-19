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

import {
  evaluatePropertyValue,
  type PropertyEvaluation,
  type EvaluationAudience,
} from "@/lib/property/property-evaluation"

export type { PropertyEvaluation, EvaluationAudience }

export async function evaluatePropertyAction(params: {
  address: string
  city: string
  state: string
  zip?: string
  audience?: EvaluationAudience
}): Promise<PropertyEvaluation> {
  return evaluatePropertyValue(params)
}
