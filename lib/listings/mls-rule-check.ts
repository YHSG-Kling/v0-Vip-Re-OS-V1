/**
 * lib/listings/mls-rule-check.ts
 *
 * Pre-submission MLS rule validator. Catches the avoidable rejections
 * BEFORE the listing is sent to the MLS — saving the agent the resubmit
 * cycle that often takes 24-48 hours.
 *
 * Rules are organised into three buckets:
 *
 *   • Universal (every MLS enforces) — required fields, photo minimums,
 *     fair-housing language, school-district disclaimers
 *   • Common (most MLSs enforce)     — square footage source, lockbox
 *     details, virtual tour requirements
 *   • Per-MLS (config-driven)        — specific board rules indexed by
 *     mls_code; consumers can extend RULE_REGISTRY without touching the
 *     core engine
 *
 * Every rule returns a severity (error | warning | info) and a fixHint
 * the UI can render directly so the agent knows exactly what to change.
 */

export type RuleSeverity = "error" | "warning" | "info"

export interface MlsRuleViolation {
  ruleId: string
  severity: RuleSeverity
  field: string | null
  message: string
  fixHint: string
}

export interface MlsRuleCheckInput {
  mlsCode?: string | null

  listPrice?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  sqftSource?: string | null
  yearBuilt?: number | null
  propertyType?: string | null
  description?: string | null
  publicRemarks?: string | null

  photoCount?: number | null
  hasVirtualTour?: boolean | null

  schoolDistrict?: string | null
  showsSchoolNames?: boolean | null

  lockboxType?: string | null
  showingInstructions?: string | null
}

export interface MlsRuleCheckResult {
  passed: boolean
  errorCount: number
  warningCount: number
  violations: MlsRuleViolation[]
}

// Lifted directly from HUD / NAR fair housing guidance — these are the
// commonly-flagged tokens. The full check is the LLM brand-compliance
// gate; this list is for the cheap pre-submit sanity pass.
const FAIR_HOUSING_TOKENS = [
  /\bfamily\s+(neighborhood|area)\b/i,
  /\b(perfect|ideal|great)\s+for\s+(family|families|couples?|seniors?|christian|jewish|muslim)\b/i,
  /\bno\s+kids\b/i,
  /\bsafe\s+(neighborhood|area)\b/i,
  /\bgood\s+schools?\b/i,
  /\bexclusive\s+(neighborhood|area)\b/i,
  /\bwalking\s+distance\b/i, // ADA — replace with "near"
  /\bmaster\s+(bed|bath)/i, // many MLSs require "primary"
]

type RuleFn = (input: MlsRuleCheckInput) => MlsRuleViolation[]

const UNIVERSAL_RULES: RuleFn[] = [
  // Required fields
  (i) =>
    !i.listPrice || i.listPrice <= 0
      ? [
          {
            ruleId: "U001",
            severity: "error",
            field: "listPrice",
            message: "List price is required and must be greater than $0.",
            fixHint: "Set the list price before submitting.",
          },
        ]
      : [],
  (i) =>
    i.bedrooms == null || i.bedrooms < 0
      ? [
          {
            ruleId: "U002",
            severity: "error",
            field: "bedrooms",
            message: "Bedroom count is required.",
            fixHint: "Enter the bedroom count (0 is valid for studios).",
          },
        ]
      : [],
  (i) =>
    i.bathrooms == null || i.bathrooms < 0
      ? [
          {
            ruleId: "U003",
            severity: "error",
            field: "bathrooms",
            message: "Bathroom count is required.",
            fixHint: "Enter the bathroom count.",
          },
        ]
      : [],
  // Photo minimum — most MLSs enforce 4-8 minimum
  (i) =>
    (i.photoCount ?? 0) < 4
      ? [
          {
            ruleId: "U010",
            severity: "error",
            field: "photoCount",
            message: `Only ${i.photoCount ?? 0} photo(s) attached — most MLSs require at least 4.`,
            fixHint: "Add more property photos before submitting.",
          },
        ]
      : [],
  // Fair-housing language
  (i) => {
    const text = `${i.description ?? ""}\n${i.publicRemarks ?? ""}`
    const hits: MlsRuleViolation[] = []
    for (const pattern of FAIR_HOUSING_TOKENS) {
      if (pattern.test(text)) {
        hits.push({
          ruleId: "U020",
          severity: "warning",
          field: i.publicRemarks ? "publicRemarks" : "description",
          message: `Possible fair-housing language: "${pattern.source}"`,
          fixHint: "Rewrite to focus on property features, not the buyer profile.",
        })
      }
    }
    return hits
  },
  // School-district disclaimer
  (i) =>
    i.showsSchoolNames && !/(verify|disclaim|approximat|not guarant)/i.test(i.description ?? "")
      ? [
          {
            ruleId: "U030",
            severity: "warning",
            field: "description",
            message: "School names referenced without a verification disclaimer.",
            fixHint:
              "Add: \"Buyer to verify school assignments — boundaries subject to change.\"",
          },
        ]
      : [],
]

const COMMON_RULES: RuleFn[] = [
  // Square footage source
  (i) =>
    i.sqft != null && !i.sqftSource
      ? [
          {
            ruleId: "C001",
            severity: "warning",
            field: "sqftSource",
            message: "Square footage provided without a source.",
            fixHint:
              "Pick a source (Tax Records / Owner / Appraisal / Builder Plans) — required by most MLSs.",
          },
        ]
      : [],
  // Lockbox details
  (i) =>
    !i.showingInstructions || i.showingInstructions.length < 10
      ? [
          {
            ruleId: "C002",
            severity: "warning",
            field: "showingInstructions",
            message: "Showing instructions are missing or too short.",
            fixHint: "Add lockbox type, access window, and listing-agent contact info.",
          },
        ]
      : [],
  // Public remarks length
  (i) => {
    const len = (i.publicRemarks ?? "").length
    if (len === 0) {
      return [
        {
          ruleId: "C003",
          severity: "warning",
          field: "publicRemarks",
          message: "Public remarks are empty.",
          fixHint: "Add 2-3 sentences highlighting the property — required for IDX feeds.",
        },
      ]
    }
    if (len > 1000) {
      return [
        {
          ruleId: "C004",
          severity: "error",
          field: "publicRemarks",
          message: `Public remarks are ${len} characters — most MLSs cap at 1000.`,
          fixHint: "Trim the description to under 1000 characters.",
        },
      ]
    }
    return []
  },
  // Virtual tour
  (i) =>
    !i.hasVirtualTour
      ? [
          {
            ruleId: "C010",
            severity: "info",
            field: "hasVirtualTour",
            message: "No virtual tour link attached.",
            fixHint:
              "Listings with a virtual tour see ~25% more inquiries. Consider adding one.",
          },
        ]
      : [],
]

// Per-MLS overrides — extend without touching the engine. Use the official
// MLS code (e.g. NWMLS, GAMLS, BRIGHT) so it can be wired off the agent's
// brokerage MLS config.
const RULE_REGISTRY: Record<string, RuleFn[]> = {
  NWMLS: [
    (i) =>
      i.bathrooms != null && i.bathrooms % 0.25 !== 0
        ? [
            {
              ruleId: "NWMLS001",
              severity: "error",
              field: "bathrooms",
              message: "NWMLS requires bathrooms in 0.25 increments (1, 1.25, 1.5, …).",
              fixHint: "Round to the nearest 0.25.",
            },
          ]
        : [],
  ],
  BRIGHT: [
    (i) =>
      (i.photoCount ?? 0) < 8
        ? [
            {
              ruleId: "BRIGHT001",
              severity: "warning",
              field: "photoCount",
              message: "BRIGHT MLS strongly recommends at least 8 photos.",
              fixHint: "Add more photos to avoid being flagged in the broker review queue.",
            },
          ]
        : [],
  ],
}

export function checkMlsRules(input: MlsRuleCheckInput): MlsRuleCheckResult {
  const rules = [...UNIVERSAL_RULES, ...COMMON_RULES]
  if (input.mlsCode && RULE_REGISTRY[input.mlsCode]) {
    rules.push(...RULE_REGISTRY[input.mlsCode])
  }

  const violations: MlsRuleViolation[] = []
  for (const rule of rules) {
    try {
      violations.push(...rule(input))
    } catch (err) {
      console.warn("[mls-rule-check] rule failure:", err)
    }
  }

  const errorCount = violations.filter((v) => v.severity === "error").length
  const warningCount = violations.filter((v) => v.severity === "warning").length

  return {
    passed: errorCount === 0,
    errorCount,
    warningCount,
    violations,
  }
}
