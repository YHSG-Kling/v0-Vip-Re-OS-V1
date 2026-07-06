// lib/compliance/content-safety-checks.ts
// ─────────────────────────────────────────────────────────────────────────────
// SYNCHRONOUS PRE-ACTION CONTENT EVAL — the deterministic, cheap safety pass every autonomous
// output must clear at the wire. Generalizes the Fair-Housing dispatch backstop to the full set
// of FINRA-2026 RELEASE-BLOCKING categories (the same the weekly manager-eval-harness audits),
// but SYNCHRONOUSLY on the FINAL content of the specific message about to send — so a
// hallucinated guarantee, a leaked SSN, or an echoed prompt-injection is caught in THIS message,
// not weeks later in an aggregate report.
//
//   • fair_housing        — protected-class / steering language (canonical FAIR_HOUSING_PATTERNS)
//   • unsubstantiated_guarantee — a contractual promise / outcome guarantee (illegal/misleading in RE)
//   • pii_leak            — SSN / card number in client-facing copy
//   • prompt_injection    — the output ECHOES an injection ("ignore previous instructions") = compromised
//
// Pure + deterministic (no I/O, no LLM) so it is cheap enough to run on every send and unit-testable.

import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"

export type SafetyCategory = "fair_housing" | "unsubstantiated_guarantee" | "pii_leak" | "prompt_injection"
export type SafetySeverity = "high" | "medium" | "low"

export interface SafetyViolation {
  category: SafetyCategory
  phrase: string
  severity: SafetySeverity
  reference: string
}

// A real-estate outcome PROMISE — guaranteeing a sale/price/appraisal or "risk-free"/"no-risk" is a
// misleading claim (FTC Act §5 / state UDAP; RESPA for lending). Excludes benign "satisfaction guaranteed"
// service language by requiring an OUTCOME object nearby.
const GUARANTEE_PATTERNS: Array<{ re: RegExp; phrase: string }> = [
  { re: /\bguarantee(?:d|s)?\s+(?:to\s+)?(?:sell|close|buy|save you|get you|a\s+sale|the\s+sale|top\s+dollar|your\s+price)/gi, phrase: "guaranteed outcome" },
  { re: /\bwill\s+(?:definitely\s+)?(?:sell|close|appraise)\s+(?:for|at|above)\b/gi, phrase: "promised sale/appraisal outcome" },
  { re: /\brisk[-\s]?free\b/gi, phrase: "risk-free claim" },
  { re: /\b(?:i|we)\s+promise\s+(?:to\s+)?(?:sell|get you|save you|close)/gi, phrase: "explicit promise of outcome" },
  { re: /\b(?:lowest|best|highest)\s+(?:price|rate|offer)\s+guaranteed\b/gi, phrase: "price/rate guarantee" },
]

const PII_PATTERNS: Array<{ re: RegExp; phrase: string }> = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, phrase: "SSN-formatted number" },
  { re: /\bssn[:\s#]+\d{2,}/gi, phrase: "labeled SSN" },
  { re: /\b(?:\d{4}[\s-]){3}\d{4}\b/g, phrase: "card-formatted number" },
]

const INJECTION_PATTERNS: Array<{ re: RegExp; phrase: string }> = [
  { re: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions/gi, phrase: "injection: ignore-previous-instructions" },
  { re: /\b(?:system|developer)\s+prompt\b/gi, phrase: "injection: references the system prompt" },
  { re: /\byou\s+are\s+now\s+(?:a|an|in)\b/gi, phrase: "injection: role-override" },
  { re: /disregard\s+(?:your\s+)?(?:rules|guidelines|guardrails)/gi, phrase: "injection: disregard-guardrails" },
]

function scan(text: string, patterns: Array<{ re: RegExp; phrase: string }>, category: SafetyCategory, severity: SafetySeverity, reference: string): SafetyViolation[] {
  const out: SafetyViolation[] = []
  for (const p of patterns) if (text.match(p.re)) out.push({ category, phrase: p.phrase, severity, reference })
  return out
}

/** PURE: run every release-blocking content check over the final text. Empty = clean. */
export function evaluateContentSafety(text: string): SafetyViolation[] {
  if (!text) return []
  const violations: SafetyViolation[] = []
  for (const fh of detectFairHousingViolations(text)) {
    violations.push({ category: "fair_housing", phrase: fh.phrase, severity: fh.severity, reference: fh.reference })
  }
  violations.push(...scan(text, GUARANTEE_PATTERNS, "unsubstantiated_guarantee", "high", "FTC Act §5 / state UDAP; RESPA (lending)"))
  violations.push(...scan(text, PII_PATTERNS, "pii_leak", "high", "GLBA / state privacy — PII in client-facing content"))
  violations.push(...scan(text, INJECTION_PATTERNS, "prompt_injection", "high", "FINRA 2026 §prompt-injection — output echoes adversarial input"))
  return violations
}
