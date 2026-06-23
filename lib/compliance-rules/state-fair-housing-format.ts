/**
 * Pure (no server-only): the canonical advisory line for a state protected-class violation.
 * Lives apart from state-fair-housing.ts (which is server-only because it reads the DB) so the
 * gates AND the simulators can format findings identically without pulling in the DB layer.
 */
import type { RuleViolation } from "./rule-evaluators"

export function formatStateFairHousingAdvisory(v: RuleViolation, stateCode: string): string {
  return `State Fair Housing (${stateCode}, ${v.severity}): "${v.offending_excerpt}" — ${v.suggested_fix} (${v.regulation_reference})`
}
