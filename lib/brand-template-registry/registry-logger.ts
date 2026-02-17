// ============================================
// SYSTEM 4.4 – REGISTRY ACTIVITY LOGGER
// Optional audit trail for template/brand evaluations
// ============================================

import { createServiceClient } from "@/lib/supabase/service"
import type { TemplateClassification } from "./template-classifier"
import type { BrandRequirements } from "./brand-requirements"

/**
 * Log template classification to activities table
 */
export async function logTemplateClassification(
  contentId: string,
  classification: TemplateClassification,
  userId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServiceClient()

    const { error } = await supabase.from("activities").insert({
      entity_type: "content",
      entity_id: contentId,
      activity_type: "template_classified",
      payload: {
        trust_level: classification.trust_level,
        auto_approval_eligible: classification.auto_approval_eligible,
        confidence_score: classification.confidence_score,
        classification_reason: classification.classification_reason,
        matched_template: classification.matched_template,
        classified_at: classification.classified_at,
      },
      user_id: userId,
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error("[v0] Failed to log template classification:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error("[v0] Exception logging template classification:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Log brand requirements evaluation to activities table
 */
export async function logBrandRequirements(
  contentId: string,
  requirements: BrandRequirements,
  userId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServiceClient()

    const { error } = await supabase.from("activities").insert({
      entity_type: "content",
      entity_id: contentId,
      activity_type: "brand_requirements_evaluated",
      payload: {
        required_elements: requirements.required_elements,
        optional_elements: requirements.optional_elements,
        channel_specific_notes: requirements.channel_specific_notes,
        legal_disclaimers: requirements.legal_disclaimers,
        generated_at: requirements.generated_at,
      },
      user_id: userId,
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error("[v0] Failed to log brand requirements:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error("[v0] Exception logging brand requirements:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Log brand compliance validation to activities table
 */
export async function logBrandCompliance(
  contentId: string,
  validation: {
    is_compliant: boolean
    missing_elements: string[]
    warnings: string[]
  },
  userId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServiceClient()

    const { error } = await supabase.from("activities").insert({
      entity_type: "content",
      entity_id: contentId,
      activity_type: "brand_compliance_validated",
      payload: {
        is_compliant: validation.is_compliant,
        missing_elements: validation.missing_elements,
        warnings: validation.warnings,
        validated_at: new Date().toISOString(),
      },
      user_id: userId,
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error("[v0] Failed to log brand compliance:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error("[v0] Exception logging brand compliance:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Batch log template classifications
 */
export async function batchLogTemplateClassifications(
  entries: Array<{
    contentId: string
    classification: TemplateClassification
    userId?: string
  }>
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = []

  for (const entry of entries) {
    const result = await logTemplateClassification(
      entry.contentId,
      entry.classification,
      entry.userId
    )
    if (!result.success && result.error) {
      errors.push(`Content ${entry.contentId}: ${result.error}`)
    }
  }

  return {
    success: errors.length === 0,
    errors,
  }
}

/**
 * Batch log brand requirements
 */
export async function batchLogBrandRequirements(
  entries: Array<{
    contentId: string
    requirements: BrandRequirements
    userId?: string
  }>
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = []

  for (const entry of entries) {
    const result = await logBrandRequirements(
      entry.contentId,
      entry.requirements,
      entry.userId
    )
    if (!result.success && result.error) {
      errors.push(`Content ${entry.contentId}: ${result.error}`)
    }
  }

  return {
    success: errors.length === 0,
    errors,
  }
}

/**
 * Get template classification history for content
 */
export async function getTemplateClassificationHistory(
  contentId: string
): Promise<{ success: boolean; data?: any[]; error?: string }> {
  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("activities")
      .select("*")
      .eq("entity_type", "content")
      .eq("entity_id", contentId)
      .eq("activity_type", "template_classified")
      .order("created_at", { ascending: false })

    if (error) {
      console.error("[v0] Failed to fetch template classification history:", error)
      return { success: false, error: error.message }
    }

    return { success: true, data: data || [] }
  } catch (err) {
    console.error("[v0] Exception fetching template classification history:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Get brand compliance history for content
 */
export async function getBrandComplianceHistory(
  contentId: string
): Promise<{ success: boolean; data?: any[]; error?: string }> {
  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("activities")
      .select("*")
      .eq("entity_type", "content")
      .eq("entity_id", contentId)
      .eq("activity_type", "brand_compliance_validated")
      .order("created_at", { ascending: false })

    if (error) {
      console.error("[v0] Failed to fetch brand compliance history:", error)
      return { success: false, error: error.message }
    }

    return { success: true, data: data || [] }
  } catch (err) {
    console.error("[v0] Exception fetching brand compliance history:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Get brand/template evaluation statistics
 */
export async function getBrandTemplateStatistics(
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
    const supabase = createServiceClient()

    let query = supabase
      .from("activities")
      .select("*")
      .eq("entity_type", "content")
      .in("activity_type", ["template_classified", "brand_compliance_validated"])

    if (dateRange) {
      query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
    }

    const { data, error } = await query

    if (error) {
      console.error("[v0] Failed to fetch brand/template statistics:", error)
      return { success: false, error: error.message }
    }

    // Process statistics
    const classifications = data?.filter((a) => a.activity_type === "template_classified") || []
    const validations = data?.filter((a) => a.activity_type === "brand_compliance_validated") || []

    const stats = {
      total_classifications: classifications.length,
      brokerage_approved_count: classifications.filter(
        (c) => c.payload?.trust_level === "brokerage_approved"
      ).length,
      team_approved_count: classifications.filter(
        (c) => c.payload?.trust_level === "team_approved"
      ).length,
      unapproved_count: classifications.filter((c) => c.payload?.trust_level === "unapproved")
        .length,
      auto_approval_eligible_count: classifications.filter(
        (c) => c.payload?.auto_approval_eligible === true
      ).length,
      average_confidence_score:
        classifications.length > 0
          ? classifications.reduce((sum, c) => sum + (c.payload?.confidence_score || 0), 0) /
            classifications.length
          : 0,
      total_brand_validations: validations.length,
      compliant_count: validations.filter((v) => v.payload?.is_compliant === true).length,
      non_compliant_count: validations.filter((v) => v.payload?.is_compliant === false).length,
    }

    return { success: true, data: stats }
  } catch (err) {
    console.error("[v0] Exception fetching brand/template statistics:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}
