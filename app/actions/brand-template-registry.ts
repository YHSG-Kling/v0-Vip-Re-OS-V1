"use server"

// ============================================
// SYSTEM 4.4 – BRAND & TEMPLATE REGISTRY
// Server Actions (Public API)
// ============================================

import { isValidUUID } from "@/lib/validations"
import {
  classifyTemplate,
  batchClassifyTemplates,
  isAutoApprovalEligible,
  formatTemplateClassification,
  getBrandRequirements,
  batchGetBrandRequirements,
  validateBrandCompliance,
  formatBrandRequirements,
  getBrandElementDescription,
  logTemplateClassification,
  logBrandRequirements,
  logBrandCompliance,
  getTemplateClassificationHistory,
  getBrandComplianceHistory,
  getBrandTemplateStatistics,
  type TemplateMetadata,
  type TemplateClassification,
  type BrandContext,
  type BrandRequirements,
  type RequiredBrandElement,
} from "@/lib/brand-template-registry"

/** Upper bound on one batch — these are synchronous CPU loops on caller input. */
const BATCH_MAX = 500

/**
 * Session gate. NOT EXPORTED — this module is `"use server"`, so exporting it
 * would mint another public endpoint.
 *
 * The two batch actions below are pure computation with no database access, so
 * there is no tenant scope to enforce and none is claimed here. What they DID
 * expose was an unauthenticated, unbounded synchronous loop over a caller-supplied
 * array: `batchClassifyTemplates` / `batchGetBrandRequirements` run in-process
 * with no yield, so one request with a large enough array occupies a server
 * worker for as long as it takes. Requiring a session and capping the array is
 * the whole fix; the single-item siblings in this file are naturally bounded and
 * are left as they are.
 */
async function requireSession(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  return ctx.isAuthenticated ? { ok: true } : { ok: false, error: "Not authenticated" }
}

// ============================================
// TEMPLATE CLASSIFICATION ACTIONS
// ============================================

/**
 * Classify a single template
 * Determines trust level and auto-approval eligibility
 */
export async function classifyTemplateAction(
  metadata: TemplateMetadata,
  options?: {
    contentId?: string
    userId?: string
    logActivity?: boolean
  }
): Promise<{
  success: boolean
  data?: TemplateClassification
  error?: string
}> {
  try {
    // Validate inputs
    if (!metadata.content_type) {
      return { success: false, error: "content_type is required" }
    }

    if (!metadata.channel_intent) {
      return { success: false, error: "channel_intent is required" }
    }

    if (options?.contentId && !isValidUUID(options.contentId)) {
      return { success: false, error: "Invalid content_id format" }
    }

    // Classify template
    const classification = classifyTemplate(metadata)

    // Optional: Log to activities table
    if (options?.logActivity && options.contentId) {
      await logTemplateClassification(options.contentId, classification, options.userId)
    }

    return { success: true, data: classification }
  } catch (err) {
    console.error("[v0] Template classification error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Template classification failed",
    }
  }
}

/**
 * Batch classify multiple templates
 */
export async function batchClassifyTemplatesAction(
  metadataList: TemplateMetadata[]
): Promise<{
  success: boolean
  data?: TemplateClassification[]
  error?: string
}> {
  try {
    const gate = await requireSession()
    if (!gate.ok) return { success: false, error: gate.error }

    if (!Array.isArray(metadataList) || metadataList.length === 0) {
      return { success: false, error: "metadataList must be a non-empty array" }
    }
    if (metadataList.length > BATCH_MAX) {
      return { success: false, error: `Classify at most ${BATCH_MAX} templates per call` }
    }

    const classifications = batchClassifyTemplates(metadataList)

    return { success: true, data: classifications }
  } catch (err) {
    console.error("[v0] Batch template classification error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Batch classification failed",
    }
  }
}

/**
 * Check if template classification is eligible for auto-approval
 */
export async function checkAutoApprovalEligibilityAction(
  classification: TemplateClassification
): Promise<{
  success: boolean
  data?: { eligible: boolean; reason: string }
  error?: string
}> {
  try {
    const eligible = isAutoApprovalEligible(classification)

    const reason = eligible
      ? "Template meets auto-approval criteria (trust level + confidence threshold)"
      : `Auto-approval not eligible: ${
          classification.confidence_score < 80
            ? "confidence too low"
            : classification.trust_level === "unapproved"
            ? "unapproved template"
            : "does not meet auto-approval criteria"
        }`

    return {
      success: true,
      data: { eligible, reason },
    }
  } catch (err) {
    console.error("[v0] Auto-approval eligibility check error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Eligibility check failed",
    }
  }
}

// ============================================
// BRAND REQUIREMENTS ACTIONS
// ============================================

/**
 * Get brand requirements for content context
 * Returns required and optional brand elements
 */
export async function getBrandRequirementsAction(
  context: BrandContext,
  options?: {
    contentId?: string
    userId?: string
    logActivity?: boolean
  }
): Promise<{
  success: boolean
  data?: BrandRequirements
  error?: string
}> {
  try {
    // Validate inputs
    if (!context.content_type) {
      return { success: false, error: "content_type is required" }
    }

    if (!context.channel_intent) {
      return { success: false, error: "channel_intent is required" }
    }

    if (!context.audience_scope) {
      return { success: false, error: "audience_scope is required" }
    }

    if (options?.contentId && !isValidUUID(options.contentId)) {
      return { success: false, error: "Invalid content_id format" }
    }

    // Get brand requirements
    const requirements = getBrandRequirements(context)

    // Optional: Log to activities table
    if (options?.logActivity && options.contentId) {
      await logBrandRequirements(options.contentId, requirements, options.userId)
    }

    return { success: true, data: requirements }
  } catch (err) {
    console.error("[v0] Brand requirements error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Brand requirements failed",
    }
  }
}

/**
 * Batch get brand requirements for multiple contexts
 */
export async function batchGetBrandRequirementsAction(
  contexts: BrandContext[]
): Promise<{
  success: boolean
  data?: BrandRequirements[]
  error?: string
}> {
  try {
    const gate = await requireSession()
    if (!gate.ok) return { success: false, error: gate.error }

    if (!Array.isArray(contexts) || contexts.length === 0) {
      return { success: false, error: "contexts must be a non-empty array" }
    }
    if (contexts.length > BATCH_MAX) {
      return { success: false, error: `Resolve at most ${BATCH_MAX} contexts per call` }
    }

    const requirements = batchGetBrandRequirements(contexts)

    return { success: true, data: requirements }
  } catch (err) {
    console.error("[v0] Batch brand requirements error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Batch requirements failed",
    }
  }
}

/**
 * Validate if content meets brand requirements
 */
export async function validateBrandComplianceAction(
  content: {
    raw_content: string
    metadata?: Record<string, any>
  },
  requirements: BrandRequirements,
  options?: {
    contentId?: string
    userId?: string
    logActivity?: boolean
  }
): Promise<{
  success: boolean
  data?: {
    is_compliant: boolean
    missing_elements: RequiredBrandElement[]
    warnings: string[]
  }
  error?: string
}> {
  try {
    // Validate inputs
    if (!content.raw_content || typeof content.raw_content !== "string") {
      return { success: false, error: "raw_content is required and must be a string" }
    }

    if (!requirements || !Array.isArray(requirements.required_elements)) {
      return { success: false, error: "Invalid requirements object" }
    }

    if (options?.contentId && !isValidUUID(options.contentId)) {
      return { success: false, error: "Invalid content_id format" }
    }

    // Validate compliance
    const validation = validateBrandCompliance(content, requirements)

    // Optional: Log to activities table
    if (options?.logActivity && options.contentId) {
      await logBrandCompliance(options.contentId, validation, options.userId)
    }

    return { success: true, data: validation }
  } catch (err) {
    console.error("[v0] Brand compliance validation error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Validation failed",
    }
  }
}

/**
 * Get description of a brand element
 */
export async function getBrandElementDescriptionAction(
  element: RequiredBrandElement
): Promise<{
  success: boolean
  data?: string
  error?: string
}> {
  try {
    const description = getBrandElementDescription(element)
    return { success: true, data: description }
  } catch (err) {
    console.error("[v0] Brand element description error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Description fetch failed",
    }
  }
}

// ============================================
// HISTORY & STATISTICS ACTIONS
// ============================================

/**
 * Get template classification history for content
 */
export async function getTemplateClassificationHistoryAction(
  contentId: string
): Promise<{
  success: boolean
  data?: any[]
  error?: string
}> {
  try {
    if (!isValidUUID(contentId)) {
      return { success: false, error: "Invalid content_id format" }
    }

    const result = await getTemplateClassificationHistory(contentId)
    return result
  } catch (err) {
    console.error("[v0] Template classification history error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "History fetch failed",
    }
  }
}

/**
 * Get brand compliance history for content
 */
export async function getBrandComplianceHistoryAction(
  contentId: string
): Promise<{
  success: boolean
  data?: any[]
  error?: string
}> {
  try {
    if (!isValidUUID(contentId)) {
      return { success: false, error: "Invalid content_id format" }
    }

    const result = await getBrandComplianceHistory(contentId)
    return result
  } catch (err) {
    console.error("[v0] Brand compliance history error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "History fetch failed",
    }
  }
}

/**
 * Get brand/template evaluation statistics
 */
export async function getBrandTemplateStatisticsAction(
  dateRange?: { start: string; end: string }
): Promise<{
  success: boolean
  data?: {
    total_classifications: number
    brokerage_approved_count: number
    team_approved_count: number
    unapproved_count: number
    auto_approval_eligible_count: number
    average_confidence_score: number
    total_brand_validations: number
    compliant_count: number
    non_compliant_count: number
  }
  error?: string
}> {
  try {
    const result = await getBrandTemplateStatistics(dateRange)
    return result
  } catch (err) {
    console.error("[v0] Brand/template statistics error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Statistics fetch failed",
    }
  }
}

// ============================================
// UTILITY ACTIONS
// ============================================

/**
 * Format template classification for display
 */
export async function formatTemplateClassificationAction(
  classification: TemplateClassification
): Promise<{
  success: boolean
  data?: string
  error?: string
}> {
  try {
    const formatted = formatTemplateClassification(classification)
    return { success: true, data: formatted }
  } catch (err) {
    console.error("[v0] Template classification formatting error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Formatting failed",
    }
  }
}

/**
 * Format brand requirements for display
 */
export async function formatBrandRequirementsAction(
  requirements: BrandRequirements
): Promise<{
  success: boolean
  data?: string
  error?: string
}> {
  try {
    const formatted = formatBrandRequirements(requirements)
    return { success: true, data: formatted }
  } catch (err) {
    console.error("[v0] Brand requirements formatting error:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Formatting failed",
    }
  }
}
