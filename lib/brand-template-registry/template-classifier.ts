// ============================================
// SYSTEM 4.4 – TEMPLATE CLASSIFIER
// Logical template matching (no database storage)
// ============================================

/**
 * Template Trust Level
 */
export type TemplateTrustLevel = "brokerage_approved" | "team_approved" | "unapproved"

/**
 * Template Metadata (runtime input)
 */
export interface TemplateMetadata {
  template_id?: string
  template_name?: string
  template_category?: string
  content_type: string
  channel_intent: string
  is_from_template?: boolean
  template_source?: "brokerage" | "team" | "custom"
}

/**
 * Template Classification Result (ephemeral output)
 */
export interface TemplateClassification {
  trust_level: TemplateTrustLevel
  auto_approval_eligible: boolean
  classification_reason: string
  matched_template?: {
    id: string
    name: string
    category: string
    source: "brokerage" | "team"
  }
  confidence_score: number // 0-100
  classified_at: string
}

/**
 * Classify content against known template patterns
 * This is LOGICAL matching, not file-based
 */
export function classifyTemplate(metadata: TemplateMetadata): TemplateClassification {
  const classified_at = new Date().toISOString()

  // RULE 1: Explicit template match from brokerage
  if (metadata.is_from_template && metadata.template_source === "brokerage") {
    return {
      trust_level: "brokerage_approved",
      auto_approval_eligible: true,
      classification_reason: "Content explicitly created from brokerage-approved template",
      matched_template: {
        id: metadata.template_id || "brokerage_unknown",
        name: metadata.template_name || "Brokerage Template",
        category: metadata.template_category || "general",
        source: "brokerage",
      },
      confidence_score: 100,
      classified_at,
    }
  }

  // RULE 2: Explicit template match from team
  if (metadata.is_from_template && metadata.template_source === "team") {
    return {
      trust_level: "team_approved",
      auto_approval_eligible: true,
      classification_reason: "Content created from team-approved template",
      matched_template: {
        id: metadata.template_id || "team_unknown",
        name: metadata.template_name || "Team Template",
        category: metadata.template_category || "general",
        source: "team",
      },
      confidence_score: 95,
      classified_at,
    }
  }

  // RULE 3: Pattern-based brokerage template detection
  const brokeragePatterns = detectBrokeragePatterns(metadata)
  if (brokeragePatterns.confidence > 80) {
    return {
      trust_level: "brokerage_approved",
      auto_approval_eligible: true,
      classification_reason: `Content matches brokerage template patterns: ${brokeragePatterns.matched_patterns.join(", ")}`,
      matched_template: brokeragePatterns.matched_template,
      confidence_score: brokeragePatterns.confidence,
      classified_at,
    }
  }

  // RULE 4: Pattern-based team template detection
  const teamPatterns = detectTeamPatterns(metadata)
  if (teamPatterns.confidence > 70) {
    return {
      trust_level: "team_approved",
      auto_approval_eligible: true,
      classification_reason: `Content matches team template patterns: ${teamPatterns.matched_patterns.join(", ")}`,
      matched_template: teamPatterns.matched_template,
      confidence_score: teamPatterns.confidence,
      classified_at,
    }
  }

  // RULE 5: Standard content types (MLS listings, standard emails)
  if (isStandardContentType(metadata)) {
    return {
      trust_level: "team_approved",
      auto_approval_eligible: false, // Still requires review
      classification_reason: "Standard content type using common format",
      confidence_score: 60,
      classified_at,
    }
  }

  // DEFAULT: Unapproved custom content
  return {
    trust_level: "unapproved",
    auto_approval_eligible: false,
    classification_reason: "Custom content does not match approved templates",
    confidence_score: 0,
    classified_at,
  }
}

/**
 * Detect brokerage template patterns
 */
function detectBrokeragePatterns(metadata: TemplateMetadata): {
  confidence: number
  matched_patterns: string[]
  matched_template?: {
    id: string
    name: string
    category: string
    source: "brokerage"
  }
} {
  const matched_patterns: string[] = []
  let confidence = 0

  // Known brokerage template categories
  const brokerageCategories = [
    "mls_listing",
    "open_house_announcement",
    "price_reduction",
    "just_listed",
    "just_sold",
    "market_report",
    "compliance_required",
  ]

  if (metadata.template_category && brokerageCategories.includes(metadata.template_category)) {
    matched_patterns.push("brokerage_category")
    confidence += 40
  }

  // Brokerage-only content types
  const brokerageContentTypes = ["listing_description"]
  if (brokerageContentTypes.includes(metadata.content_type)) {
    matched_patterns.push("brokerage_content_type")
    confidence += 30
  }

  // High-value channels require brokerage templates
  const brokerageChannels = ["google_ads", "meta_ads"]
  if (metadata.channel_intent && brokerageChannels.includes(metadata.channel_intent)) {
    matched_patterns.push("brokerage_channel")
    confidence += 20
  }

  // Template naming conventions
  if (metadata.template_name) {
    if (
      metadata.template_name.toLowerCase().includes("brokerage") ||
      metadata.template_name.toLowerCase().includes("official") ||
      metadata.template_name.toLowerCase().includes("corporate")
    ) {
      matched_patterns.push("brokerage_naming")
      confidence += 30
    }
  }

  const matched_template =
    matched_patterns.length > 0
      ? {
          id: metadata.template_id || "brokerage_detected",
          name: metadata.template_name || "Detected Brokerage Template",
          category: metadata.template_category || "general",
          source: "brokerage" as const,
        }
      : undefined

  return {
    confidence,
    matched_patterns,
    matched_template,
  }
}

/**
 * Detect team template patterns
 */
function detectTeamPatterns(metadata: TemplateMetadata): {
  confidence: number
  matched_patterns: string[]
  matched_template?: {
    id: string
    name: string
    category: string
    source: "team"
  }
} {
  const matched_patterns: string[] = []
  let confidence = 0

  // Known team template categories
  const teamCategories = [
    "personal_brand",
    "farming_area",
    "sphere_update",
    "client_testimonial",
    "neighborhood_spotlight",
    "buyer_guide",
    "seller_guide",
  ]

  if (metadata.template_category && teamCategories.includes(metadata.template_category)) {
    matched_patterns.push("team_category")
    confidence += 35
  }

  // Team-level content types
  const teamContentTypes = ["newsletter", "blog", "social_post"]
  if (teamContentTypes.includes(metadata.content_type)) {
    matched_patterns.push("team_content_type")
    confidence += 25
  }

  // Team channels
  const teamChannels = ["instagram", "facebook", "linkedin", "email"]
  if (metadata.channel_intent && teamChannels.includes(metadata.channel_intent)) {
    matched_patterns.push("team_channel")
    confidence += 15
  }

  // Template naming conventions
  if (metadata.template_name) {
    if (
      metadata.template_name.toLowerCase().includes("team") ||
      metadata.template_name.toLowerCase().includes("personal") ||
      metadata.template_name.toLowerCase().includes("custom")
    ) {
      matched_patterns.push("team_naming")
      confidence += 25
    }
  }

  const matched_template =
    matched_patterns.length > 0
      ? {
          id: metadata.template_id || "team_detected",
          name: metadata.template_name || "Detected Team Template",
          category: metadata.template_category || "general",
          source: "team" as const,
        }
      : undefined

  return {
    confidence,
    matched_patterns,
    matched_template,
  }
}

/**
 * Check if content type is standard/common
 */
function isStandardContentType(metadata: TemplateMetadata): boolean {
  const standardTypes = [
    "email",
    "sms_script",
    "listing_description",
    "open_house_announcement",
  ]

  return standardTypes.includes(metadata.content_type)
}

/**
 * Batch template classification
 */
export function batchClassifyTemplates(
  metadataList: TemplateMetadata[]
): TemplateClassification[] {
  return metadataList.map((metadata) => classifyTemplate(metadata))
}

/**
 * Check if template is eligible for auto-approval
 * Used by System 4.3 (Approval Workflow)
 */
export function isAutoApprovalEligible(classification: TemplateClassification): boolean {
  return (
    classification.auto_approval_eligible &&
    classification.confidence_score >= 80 &&
    (classification.trust_level === "brokerage_approved" ||
      classification.trust_level === "team_approved")
  )
}

/**
 * Get trust level priority (for conflict resolution)
 */
export function getTrustLevelPriority(level: TemplateTrustLevel): number {
  const priorities: Record<TemplateTrustLevel, number> = {
    brokerage_approved: 3,
    team_approved: 2,
    unapproved: 1,
  }
  return priorities[level]
}

/**
 * Format classification for display
 */
export function formatTemplateClassification(classification: TemplateClassification): string {
  let output = `Template Classification:\n`
  output += `Trust Level: ${classification.trust_level.replace(/_/g, " ").toUpperCase()}\n`
  output += `Auto-Approval Eligible: ${classification.auto_approval_eligible ? "Yes" : "No"}\n`
  output += `Confidence Score: ${classification.confidence_score}%\n`
  output += `Reason: ${classification.classification_reason}\n`

  if (classification.matched_template) {
    output += `\nMatched Template:\n`
    output += `- ID: ${classification.matched_template.id}\n`
    output += `- Name: ${classification.matched_template.name}\n`
    output += `- Category: ${classification.matched_template.category}\n`
    output += `- Source: ${classification.matched_template.source.toUpperCase()}\n`
  }

  output += `\nClassified: ${new Date(classification.classified_at).toLocaleString()}\n`

  return output
}
