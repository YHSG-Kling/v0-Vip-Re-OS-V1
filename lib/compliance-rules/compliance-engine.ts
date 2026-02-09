"use server"

import {
  ComplianceContentInput,
  RuleViolation,
  evaluateRegulatoryCompliance,
  evaluateBrokeragePolicyCompliance,
  evaluateBrandCompliance,
  evaluateAISafetyCompliance,
} from "./rule-evaluators"

// ============================================
// SYSTEM 4.2 – COMPLIANCE ENGINE
// Orchestrates all compliance evaluations
// ============================================

/**
 * Compliance Verdict (Runtime Only - Never Persisted)
 */
export interface ComplianceVerdict {
  compliance_status: "pass" | "fail" | "review_required"
  violations: RuleViolation[]
  required_actions: string[]
  evaluated_at: string
  summary: {
    total_violations: number
    by_category: Record<string, number>
    by_severity: Record<string, number>
    highest_severity: "low" | "medium" | "high" | null
  }
}

/**
 * Evaluate content against ALL compliance rules
 * This is the main entry point for System 4.2
 */
export async function evaluateContentCompliance(input: ComplianceContentInput): Promise<ComplianceVerdict> {
  const violations: RuleViolation[] = []

  // Run all rule evaluations in parallel
  const [regulatoryViolations, brokerageViolations, brandViolations, aiSafetyViolations] = await Promise.all([
    Promise.resolve(evaluateRegulatoryCompliance(input)),
    Promise.resolve(evaluateBrokeragePolicyCompliance(input)),
    Promise.resolve(evaluateBrandCompliance(input)),
    Promise.resolve(evaluateAISafetyCompliance(input)),
  ])

  violations.push(
    ...regulatoryViolations,
    ...brokerageViolations,
    ...brandViolations,
    ...aiSafetyViolations,
  )

  // Determine compliance status
  const hasHighSeverity = violations.some((v) => v.severity === "high")
  const hasMediumSeverity = violations.some((v) => v.severity === "medium")

  let compliance_status: "pass" | "fail" | "review_required"
  if (hasHighSeverity) {
    compliance_status = "fail"
  } else if (hasMediumSeverity || violations.length > 0) {
    compliance_status = "review_required"
  } else {
    compliance_status = "pass"
  }

  // Determine required actions
  const required_actions = determineRequiredActions(violations, input)

  // Build summary
  const summary = buildSummary(violations)

  return {
    compliance_status,
    violations,
    required_actions,
    evaluated_at: new Date().toISOString(),
    summary,
  }
}

/**
 * Evaluate content against SPECIFIC rule category only
 */
export async function evaluateSpecificCategory(
  input: ComplianceContentInput,
  category: "regulatory" | "brokerage" | "brand" | "ai_safety"
): Promise<RuleViolation[]> {
  switch (category) {
    case "regulatory":
      return evaluateRegulatoryCompliance(input)
    case "brokerage":
      return evaluateBrokeragePolicyCompliance(input)
    case "brand":
      return evaluateBrandCompliance(input)
    case "ai_safety":
      return evaluateAISafetyCompliance(input)
    default:
      return []
  }
}

/**
 * Quick compliance check (high-severity only)
 * Used for fast validation before more detailed evaluation
 */
export async function quickComplianceCheck(input: ComplianceContentInput): Promise<{
  has_critical_issues: boolean
  critical_violations: RuleViolation[]
}> {
  const allViolations = await evaluateContentCompliance(input)
  const critical_violations = allViolations.violations.filter((v) => v.severity === "high")

  return {
    has_critical_issues: critical_violations.length > 0,
    critical_violations,
  }
}

/**
 * Batch evaluate multiple content pieces
 */
export async function batchEvaluateCompliance(
  inputs: ComplianceContentInput[]
): Promise<Array<{ input: ComplianceContentInput; verdict: ComplianceVerdict }>> {
  const results = await Promise.all(
    inputs.map(async (input) => ({
      input,
      verdict: await evaluateContentCompliance(input),
    }))
  )

  return results
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function determineRequiredActions(violations: RuleViolation[], input: ComplianceContentInput): string[] {
  const actions: string[] = []

  // Check for regulatory violations
  const hasRegulatoryViolations = violations.some((v) => v.rule_category === "regulatory")
  if (hasRegulatoryViolations) {
    actions.push("legal_review_required")
    actions.push("content_rewrite_required")
  }

  // Check for high severity violations
  const hasHighSeverity = violations.some((v) => v.severity === "high")
  if (hasHighSeverity) {
    actions.push("manual_approval_required")
  }

  // Check for missing disclaimers
  const hasBrandViolations = violations.some(
    (v) => v.rule_category === "brand" && v.rule_name === "Missing Required Disclaimer"
  )
  if (hasBrandViolations) {
    actions.push("add_required_disclaimers")
  }

  // Check for AI safety issues
  const hasAISafetyViolations = violations.some((v) => v.rule_category === "ai_safety")
  if (hasAISafetyViolations) {
    actions.push("rewrite_for_buyer_focus")
  }

  // If no violations, mark as ready
  if (violations.length === 0) {
    actions.push("ready_for_use")
  }

  // If only low severity, suggest optional review
  const onlyLowSeverity = violations.length > 0 && violations.every((v) => v.severity === "low")
  if (onlyLowSeverity) {
    actions.push("optional_review_recommended")
  }

  return actions
}

function buildSummary(violations: RuleViolation[]): {
  total_violations: number
  by_category: Record<string, number>
  by_severity: Record<string, number>
  highest_severity: "low" | "medium" | "high" | null
} {
  const by_category: Record<string, number> = {
    regulatory: 0,
    brokerage: 0,
    brand: 0,
    ai_safety: 0,
  }

  const by_severity: Record<string, number> = {
    low: 0,
    medium: 0,
    high: 0,
  }

  let highest_severity: "low" | "medium" | "high" | null = null

  for (const violation of violations) {
    by_category[violation.rule_category]++
    by_severity[violation.severity]++

    if (violation.severity === "high") {
      highest_severity = "high"
    } else if (violation.severity === "medium" && highest_severity !== "high") {
      highest_severity = "medium"
    } else if (violation.severity === "low" && !highest_severity) {
      highest_severity = "low"
    }
  }

  return {
    total_violations: violations.length,
    by_category,
    by_severity,
    highest_severity,
  }
}

/**
 * Format compliance verdict for human-readable display
 */
export function formatComplianceVerdict(verdict: ComplianceVerdict): string {
  let output = `Compliance Status: ${verdict.compliance_status.toUpperCase()}\n\n`

  output += `Summary:\n`
  output += `- Total Violations: ${verdict.summary.total_violations}\n`
  output += `- Highest Severity: ${verdict.summary.highest_severity || "None"}\n`
  output += `- Evaluated: ${new Date(verdict.evaluated_at).toLocaleString()}\n\n`

  if (verdict.violations.length > 0) {
    output += `Violations by Category:\n`
    for (const [category, count] of Object.entries(verdict.summary.by_category)) {
      if (count > 0) {
        output += `- ${category}: ${count}\n`
      }
    }
    output += `\n`

    output += `Detailed Violations:\n`
    for (const violation of verdict.violations) {
      output += `\n[${violation.severity.toUpperCase()}] ${violation.rule_name}\n`
      output += `  ${violation.description}\n`
      if (violation.offending_excerpt) {
        output += `  Excerpt: "${violation.offending_excerpt}"\n`
      }
      if (violation.suggested_fix) {
        output += `  Suggested Fix: ${violation.suggested_fix}\n`
      }
      if (violation.regulation_reference) {
        output += `  Reference: ${violation.regulation_reference}\n`
      }
    }
  }

  if (verdict.required_actions.length > 0) {
    output += `\nRequired Actions:\n`
    for (const action of verdict.required_actions) {
      output += `- ${action.replace(/_/g, " ")}\n`
    }
  }

  return output
}
