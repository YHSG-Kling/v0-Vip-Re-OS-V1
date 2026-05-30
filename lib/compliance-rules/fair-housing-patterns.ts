// lib/compliance-rules/fair-housing-patterns.ts
// Single source of truth for real-estate Fair Housing content patterns.
//
// Shared by:
//   - lib/compliance-rules/rule-evaluators.ts (evaluateRegulatoryCompliance) —
//     the messaging content gate (kernel evaluateOutbound Gate 4) + admin engine.
//   - lib/kernel/marketing/real-estate-compliance-gate.ts — the social/ads gate.
//
// Keeping one list prevents the two gates' Fair Housing coverage from drifting.
// Each entry carries a suggested compliant rewrite (fix) and the legal reference.

export interface FairHousingPattern {
  pattern: RegExp
  phrase: string
  severity: "high" | "medium" | "low"
  fix: string
  reference: string
}

export const FAIR_HOUSING_PATTERNS: FairHousingPattern[] = [
  // Critical — direct protected-class references
  {
    pattern: /perfect\s+(for|area\s+for)\s+famil/gi,
    phrase: "perfect for families",
    severity: "high",
    fix: "Spacious layout with multiple bedrooms",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /(great|perfect|ideal)\s+(for|area\s+for)\s+retire/gi,
    phrase: "great for retirees",
    severity: "high",
    fix: "Single-level living with accessible features",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /young\s+professional/gi,
    phrase: "young professional area",
    severity: "high",
    fix: "Urban location with dining and entertainment",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /adult\s+(only\s+)?community/gi,
    phrase: "adult community",
    severity: "high",
    fix: "Age-qualified community (if verified 55+)",
    reference: "Housing for Older Persons Act",
  },
  {
    pattern: /(empty\s+nesters?|mature\s+buyers?)/gi,
    phrase: "empty nesters/mature buyers",
    severity: "high",
    fix: "Low-maintenance home",
    reference: "Fair Housing Act § 3604(c)",
  },

  // Medium — implicit protected-class steering
  {
    pattern: /walk\s+to\s+(church|mosque|synagogue|temple)/gi,
    phrase: "walk to church/religious institution",
    severity: "medium",
    fix: "Close to community amenities",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /safe\s+(area|neighborhood|community)/gi,
    phrase: "safe area",
    severity: "medium",
    fix: "Well-maintained neighborhood",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /quiet\s+neighborhood/gi,
    phrase: "quiet neighborhood",
    severity: "medium",
    fix: "Peaceful surroundings",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /(changing|transitioning|up[\s-]and[\s-]coming)\s+(area|neighborhood)/gi,
    phrase: "changing/transitioning neighborhood",
    severity: "high",
    fix: "Developing area with new amenities",
    reference: "Fair Housing Act § 3604(c)",
  },

  // Low — accessibility language that could imply disability
  {
    pattern: /wheelchair\s+(accessible|bound|user)/gi,
    phrase: "wheelchair accessible",
    severity: "low",
    fix: "Accessible features throughout",
    reference: "Fair Housing Amendments Act of 1988",
  },
]

/**
 * Detect Fair Housing pattern matches in content. Uses .match() (not stateful
 * .test()) so the global-flagged patterns are safe to reuse across calls.
 */
export function detectFairHousingViolations(content: string): FairHousingPattern[] {
  return FAIR_HOUSING_PATTERNS.filter((rule) => content.match(rule.pattern) !== null)
}
