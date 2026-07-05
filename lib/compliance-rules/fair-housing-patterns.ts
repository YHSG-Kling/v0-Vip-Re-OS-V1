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

  // ── Familial-status exclusion (consolidated from content-guardian — these were a real
  //    coverage GAP in the canonical set; "no kids" / "adults only" are direct §3604 violations) ──
  {
    pattern: /\b(no\s+children|no\s+kids|adults?\s+only|couples?\s+only|singles?\s+only)\b/gi,
    phrase: "no children / adults only",
    severity: "high",
    fix: "Describe the home's features, not who may live there",
    reference: "Fair Housing Act § 3604(c) — familial status",
  },
  {
    pattern: /perfect\s+for\s+(singles|couples|families\s+with\s+no\s+kids)/gi,
    phrase: "perfect for singles/couples/no-kids",
    severity: "high",
    fix: "Describe the home, not the ideal occupant",
    reference: "Fair Housing Act § 3604(c) — familial status",
  },
  // Steering proxies — school quality is the classic redlining/steering signal
  {
    pattern: /\b(good|great|top|excellent)\s+schools?\b/gi,
    phrase: "good/great schools",
    severity: "medium",
    fix: "Reference the specific school district by name without a quality judgment",
    reference: "Fair Housing Act § 3604(c) — steering",
  },
  {
    pattern: /\b(exclusive|restricted|select)\s+(neighborhood|community|area)\b/gi,
    phrase: "exclusive/restricted neighborhood",
    severity: "high",
    fix: "Describe the location's amenities, not its exclusivity",
    reference: "Fair Housing Act § 3604(c) — steering",
  },
  // Religious-institution proximity — broaden to catch the "walking distance to church" phrasing
  {
    pattern: /(walk|walking\s+distance)\s+(to|from)\s+(church|mosque|synagogue|temple)/gi,
    phrase: "walking distance to a place of worship",
    severity: "medium",
    fix: "Close to community amenities",
    reference: "Fair Housing Act § 3604(c) — religion",
  },
  // Disability language
  {
    pattern: /\bhandicap(ped)?\b/gi,
    phrase: "handicap/handicapped",
    severity: "low",
    fix: "Use 'accessible' and describe the specific accessible feature",
    reference: "Fair Housing Amendments Act of 1988 — disability",
  },
]

/**
 * Detect Fair Housing pattern matches in content. Uses .match() (not stateful
 * .test()) so the global-flagged patterns are safe to reuse across calls.
 */
export function detectFairHousingViolations(content: string): FairHousingPattern[] {
  return FAIR_HOUSING_PATTERNS.filter((rule) => content.match(rule.pattern) !== null)
}
