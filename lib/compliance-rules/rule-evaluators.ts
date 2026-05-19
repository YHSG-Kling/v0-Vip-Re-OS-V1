// ============================================
// SYSTEM 4.2 – COMPLIANCE RULE EVALUATORS
// Pure evaluation logic (no database dependencies)
// ============================================

/**
 * Rule Violation Type
 */
export interface RuleViolation {
  rule_category: "regulatory" | "brokerage" | "brand" | "ai_safety"
  rule_name: string
  severity: "low" | "medium" | "high"
  description: string
  offending_excerpt?: string
  suggested_fix?: string
  regulation_reference?: string
}

/**
 * Content Input for Evaluation
 */
export interface ComplianceContentInput {
  content_type: string
  channel_intent: string
  raw_content: string
  source_inputs?: Record<string, any>
  intended_audience?: string
  /** Brokerage that owns the content — used to load state-specific protected classes. */
  brokerage_id?: string
  /** Two-letter US state code. If provided directly, overrides brokerage_id lookup. */
  state_code?: string
  context?: {
    listing_id?: string
    transaction_id?: string
    contact_type?: string
    persona?: string
  }
}

// ============================================
// REGULATORY RULES (FAIR HOUSING, ADVERTISING LAWS)
// ============================================

const FAIR_HOUSING_PROTECTED_CLASSES = [
  "race",
  "color",
  "religion",
  "national origin",
  "sex",
  "disability",
  "familial status",
  "handicap",
  "children",
]

const FAIR_HOUSING_VIOLATIONS = [
  // Critical - Direct protected class references
  {
    pattern: /perfect\s+(for|area\s+for)\s+famil/gi,
    phrase: "perfect for families",
    severity: "high" as const,
    fix: "Spacious layout with multiple bedrooms",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /(great|perfect|ideal)\s+(for|area\s+for)\s+retire/gi,
    phrase: "great for retirees",
    severity: "high" as const,
    fix: "Single-level living with accessible features",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /young\s+professional/gi,
    phrase: "young professional area",
    severity: "high" as const,
    fix: "Urban location with dining and entertainment",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /adult\s+(only\s+)?community/gi,
    phrase: "adult community",
    severity: "high" as const,
    fix: "Age-qualified community (if verified 55+)",
    reference: "Housing for Older Persons Act",
  },
  {
    pattern: /(empty\s+nesters?|mature\s+buyers?)/gi,
    phrase: "empty nesters/mature buyers",
    severity: "high" as const,
    fix: "Low-maintenance home",
    reference: "Fair Housing Act § 3604(c)",
  },

  // Medium - Implicit protected class steering
  {
    pattern: /walk\s+to\s+(church|mosque|synagogue|temple)/gi,
    phrase: "walk to church/religious institution",
    severity: "medium" as const,
    fix: "Close to community amenities",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /safe\s+(area|neighborhood|community)/gi,
    phrase: "safe area",
    severity: "medium" as const,
    fix: "Well-maintained neighborhood",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /quiet\s+neighborhood/gi,
    phrase: "quiet neighborhood",
    severity: "medium" as const,
    fix: "Peaceful surroundings",
    reference: "Fair Housing Act § 3604(c)",
  },
  {
    pattern: /(changing|transitioning|up[\s-]and[\s-]coming)\s+(area|neighborhood)/gi,
    phrase: "changing/transitioning neighborhood",
    severity: "high" as const,
    fix: "Developing area with new amenities",
    reference: "Fair Housing Act § 3604(c)",
  },

  // Low - Accessibility language that could imply disability
  {
    pattern: /wheelchair\s+(accessible|bound|user)/gi,
    phrase: "wheelchair accessible",
    severity: "low" as const,
    fix: "Accessible features throughout",
    reference: "Fair Housing Amendments Act of 1988",
  },
]

export function evaluateRegulatoryCompliance(input: ComplianceContentInput): RuleViolation[] {
  const violations: RuleViolation[] = []
  const contentLower = input.raw_content.toLowerCase()

  // Check Fair Housing violations
  for (const rule of FAIR_HOUSING_VIOLATIONS) {
    const matches = input.raw_content.match(rule.pattern)
    if (matches) {
      const excerpt = extractExcerpt(input.raw_content, matches[0])
      violations.push({
        rule_category: "regulatory",
        rule_name: "Fair Housing Act Violation",
        severity: rule.severity,
        description: `Potentially violates Fair Housing Act by using language that could imply preference or discrimination: "${rule.phrase}"`,
        offending_excerpt: excerpt,
        suggested_fix: rule.fix,
        regulation_reference: rule.reference,
      })
    }
  }

  // Check for direct protected class mentions
  for (const protectedClass of FAIR_HOUSING_PROTECTED_CLASSES) {
    const pattern = new RegExp(`\\b${protectedClass}\\b`, "gi")
    if (pattern.test(input.raw_content)) {
      const excerpt = extractExcerpt(input.raw_content, protectedClass)
      violations.push({
        rule_category: "regulatory",
        rule_name: "Protected Class Reference",
        severity: "high",
        description: `Direct reference to protected class: "${protectedClass}". This may violate Fair Housing Act § 3604(c).`,
        offending_excerpt: excerpt,
        suggested_fix: "Remove all references to protected classes",
        regulation_reference: "Fair Housing Act § 3604(c)",
      })
    }
  }

  // Check for misleading pricing claims (UDAAP/RESPA)
  const pricingViolations = [
    {
      pattern: /guaranteed\s+(appreciation|profit|return)/gi,
      name: "Guaranteed Investment Return",
      fix: "Remove guarantees - use 'potential' or 'historically'",
    },
    {
      pattern: /can'?t\s+lose/gi,
      name: "Can't Lose Promise",
      fix: "Remove absolute claims about investment",
    },
    {
      pattern: /double\s+your\s+money/gi,
      name: "Specific Return Promise",
      fix: "Remove specific return claims",
    },
  ]

  for (const rule of pricingViolations) {
    if (rule.pattern.test(input.raw_content)) {
      violations.push({
        rule_category: "regulatory",
        rule_name: rule.name,
        severity: "high",
        description: "Misleading financial claim that may violate UDAAP or state advertising laws",
        offending_excerpt: extractExcerpt(input.raw_content, rule.pattern),
        suggested_fix: rule.fix,
        regulation_reference: "UDAAP (Unfair, Deceptive, or Abusive Acts or Practices)",
      })
    }
  }

  return violations
}

// ============================================
// BROKERAGE POLICY RULES
// ============================================

const BROKERAGE_POLICY_VIOLATIONS = [
  {
    pattern: /\b(i|me|my)\s+(brokerage|office|team)\b/gi,
    name: "Incorrect Brokerage Attribution",
    severity: "medium" as const,
    fix: "Use official brokerage name and attribution",
  },
  {
    pattern: /\#1\s+(agent|realtor|broker)/gi,
    name: "Unsubstantiated Claim",
    severity: "medium" as const,
    fix: "Remove or provide verifiable source (e.g., 'Top 5% in 2024 by XYZ')",
  },
  {
    pattern: /off[\s-]market\s+(deal|listing|opportunity)/gi,
    name: "Exclusive Dealing Language",
    severity: "low" as const,
    fix: "Ensure compliance with MLS rules before claiming 'off-market'",
  },
]

export function evaluateBrokeragePolicyCompliance(input: ComplianceContentInput): RuleViolation[] {
  const violations: RuleViolation[] = []

  for (const rule of BROKERAGE_POLICY_VIOLATIONS) {
    if (rule.pattern.test(input.raw_content)) {
      violations.push({
        rule_category: "brokerage",
        rule_name: rule.name,
        severity: rule.severity,
        description: `May violate brokerage policy or professional standards`,
        offending_excerpt: extractExcerpt(input.raw_content, rule.pattern),
        suggested_fix: rule.fix,
      })
    }
  }

  return violations
}

// ============================================
// BRAND & DISCLAIMER RULES
// ============================================

const DISCLAIMER_REQUIREMENTS = [
  {
    content_type: "listing_description",
    required_elements: ["Equal Housing Opportunity statement"],
  },
  {
    content_type: "ad_copy",
    required_elements: ["Brokerage name", "Equal Housing Opportunity logo or statement"],
  },
  {
    content_type: "email",
    required_elements: ["Unsubscribe link", "Physical address"],
  },
]

export function evaluateBrandCompliance(input: ComplianceContentInput): RuleViolation[] {
  const violations: RuleViolation[] = []

  // Check for required disclaimers based on content type
  const requirement = DISCLAIMER_REQUIREMENTS.find((req) => req.content_type === input.content_type)

  if (requirement) {
    for (const element of requirement.required_elements) {
      const missingElement = !checkForElement(input.raw_content, element)
      if (missingElement) {
        violations.push({
          rule_category: "brand",
          rule_name: "Missing Required Disclaimer",
          severity: "medium",
          description: `Missing required element: ${element}`,
          suggested_fix: `Add ${element} to content`,
        })
      }
    }
  }

  // Check for consistent branding language
  if (/call\s+me\s+now/gi.test(input.raw_content)) {
    violations.push({
      rule_category: "brand",
      rule_name: "Pushy CTA Language",
      severity: "low",
      description: "CTA language is too aggressive for brand voice",
      suggested_fix: "Use softer CTAs like 'Let's connect' or 'I'm here to help'",
    })
  }

  return violations
}

// ============================================
// AI SAFETY & ETHICAL LANGUAGE RULES
// ============================================

const AI_SAFETY_VIOLATIONS = [
  {
    pattern: /(you'd\s+be\s+crazy|you'?re\s+an\s+idiot)\s+(not\s+to|if\s+you\s+don'?t)/gi,
    name: "Manipulative/Shaming Language",
    severity: "high" as const,
  },
  {
    pattern: /limited\s+time\s+offer/gi,
    name: "False Urgency",
    severity: "medium" as const,
  },
  {
    pattern: /(this\s+won'?t\s+last|act\s+fast|hurry)/gi,
    name: "Pressure Tactics",
    severity: "medium" as const,
  },
  {
    pattern: /trust\s+me/gi,
    name: "Trust Me (Ironic Anti-Trust)",
    severity: "low" as const,
  },
  {
    pattern: /i'?m\s+the\s+best\s+(agent|realtor)/gi,
    name: "Ego-Driven Claims",
    severity: "low" as const,
  },
]

export function evaluateAISafetyCompliance(input: ComplianceContentInput): RuleViolation[] {
  const violations: RuleViolation[] = []

  for (const rule of AI_SAFETY_VIOLATIONS) {
    if (rule.pattern.test(input.raw_content)) {
      violations.push({
        rule_category: "ai_safety",
        rule_name: rule.name,
        severity: rule.severity,
        description: "Content uses manipulative or ethically questionable language",
        offending_excerpt: extractExcerpt(input.raw_content, rule.pattern),
        suggested_fix: "Rewrite to focus on buyer benefits without pressure or manipulation",
      })
    }
  }

  // Check "Them First" ratio (buyer-focused vs agent-focused)
  const themFirstScore = calculateThemFirstScore(input.raw_content)
  if (themFirstScore < 0.7) {
    violations.push({
      rule_category: "ai_safety",
      rule_name: "Insufficient 'Them First' Focus",
      severity: "medium",
      description: `Content is only ${Math.round(themFirstScore * 100)}% buyer-focused (target: 70%+). Too much agent/brand promotion.`,
      suggested_fix: "Rewrite to focus more on buyer benefits, feelings, and outcomes rather than agent credentials or services",
    })
  }

  return violations
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function extractExcerpt(content: string, searchTerm: string | RegExp, contextChars: number = 50): string {
  const pattern = typeof searchTerm === "string" ? new RegExp(searchTerm, "gi") : searchTerm
  const match = content.match(pattern)
  if (!match) return ""

  const index = content.indexOf(match[0])
  const start = Math.max(0, index - contextChars)
  const end = Math.min(content.length, index + match[0].length + contextChars)

  let excerpt = content.substring(start, end)
  if (start > 0) excerpt = "..." + excerpt
  if (end < content.length) excerpt = excerpt + "..."

  return excerpt
}

function checkForElement(content: string, element: string): boolean {
  const elementChecks: Record<string, RegExp> = {
    "Equal Housing Opportunity statement": /equal\s+housing\s+opportunity/gi,
    "Equal Housing Opportunity logo or statement": /equal\s+housing\s+opportunity/gi,
    "Brokerage name": /\b[A-Z][a-z]+\s+(Realty|Real Estate|Properties)\b/gi,
    "Unsubscribe link": /(unsubscribe|opt[\s-]out)/gi,
    "Physical address": /\d+\s+[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}/gi,
  }

  const pattern = elementChecks[element]
  return pattern ? pattern.test(content) : false
}

function calculateThemFirstScore(content: string): number {
  // Count buyer-focused words (you, your, imagine, feel, enjoy)
  const buyerWords = (content.match(/\b(you|your|yours|imagine|feel|enjoy|benefit|discover|experience)\b/gi) || [])
    .length

  // Count agent-focused words (I, me, my, we, our, us)
  const agentWords = (content.match(/\b(i|me|my|mine|we|us|our|ours)\b/gi) || []).length

  // Calculate ratio
  const totalWords = buyerWords + agentWords
  if (totalWords === 0) return 0.5 // Neutral if no personal pronouns

  return buyerWords / totalWords
}
