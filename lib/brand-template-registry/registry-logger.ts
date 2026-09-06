// ============================================
// SYSTEM 4.4 – REGISTRY ACTIVITY LOGGER
// Optional audit trail for template/brand evaluations
// ============================================

import { createServiceClient } from "@/lib/supabase/service"
import { resolveBrandTemplateBrokerageId, type TenantReadClient } from "@/lib/activities/activity-tenant"
import type { TemplateClassification } from "./template-classifier"
import type { BrandRequirements } from "./brand-requirements"

// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT ON EVERY ROW THIS MODULE WRITES — AND WHY THE TRIGGER NEVER SET IT.
//
// `activities` carries `activities_set_brokerage` (BEFORE INSERT), so every
// census bucketed this table as trigger-covered and stopped looking. The net has
// no `content` branch. These rows carry `entity_type: "content"` and their ONLY
// other possible anchor was `agent_user_id: userId` — and `userId` is an OPTIONAL
// parameter that the single live caller does not pass:
//
//     app/dashboard/admin/brand/brand-client.tsx:302,310,363
//       → classifyTemplateAction(…, { contentId: template.id, logActivity: true })
//       → app/actions/brand-template-registry.ts:93 → logTemplateClassification(contentId, …, options.userId)
//
// `options.userId` is `undefined` at every one of those call sites, so
// `agent_user_id` was absent, no branch matched, and `brokerage_id` stayed NULL.
// It is NOT NULL in the schema, so nothing was hidden — the insert was **refused,
// 23502**, every time. The brand compliance history panel at
// `app/dashboard/admin/brand/page.tsx:47` has been rendering an empty list not
// because no template was ever validated but because no row was ever written.
//
// THE RESOLUTION IS THE RECORD: `contentId` is a `brand_templates.id` at every
// live call site, `brand_templates.brokerage_id` is NOT NULL, and it is exactly
// the value `page.tsx:47` compares (`context.brokerageId`, the caller's own
// brokerage) whenever the template belongs to the caller — which the brand page's
// own `.eq("brokerage_id", brokerageId)` template query guarantees.
//
// Resolved ONCE PER CALL, before the write, on the service client this module
// already builds. Where the content id names no `brand_templates` row, NOTHING IS
// WRITTEN and the reason is returned — a guess would file another tenant's audit
// trail under this one.
// ─────────────────────────────────────────────────────────────────────────────

/** One resolver for all three writers below. Returns the row's tenant or the reason there is none. */
async function tenantForContent(
  supabase: TenantReadClient,
  contentId: string,
  label: string,
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const tenant = await resolveBrandTemplateBrokerageId(supabase, contentId)
  if (!tenant.ok) {
    // A REFUSED read is not "no such template". supabase-js resolves both.
    const error = `${label} NOT logged: ${tenant.reason}`
    console.error(`[v0] ${error}`)
    return { ok: false, error }
  }
  if (!tenant.brokerageId) {
    const error = `${label} NOT logged: content ${contentId} is not a brand_templates row, so its tenant cannot be resolved — activities.brokerage_id is NOT NULL and a guessed tenant would file this audit trail under the wrong brokerage`
    console.error(`[v0] ${error}`)
    return { ok: false, error }
  }
  return { ok: true, brokerageId: tenant.brokerageId }
}

// Agent task (correct location, no changes) — activity_type: template_classified, brand_requirements_evaluated, brand_compliance_validated
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

    const tenant = await tenantForContent(supabase, contentId, "Template classification")
    if (!tenant.ok) return { success: false, error: tenant.error }

    const { error } = await supabase.from("activities").insert({
      // TENANT: the brand template this classification is about. See header.
      brokerage_id: tenant.brokerageId,
      entity_type: "content",
      entity_id: contentId,
      activity_type: "template_classified",
      metadata: {
        trust_level: classification.trust_level,
        auto_approval_eligible: classification.auto_approval_eligible,
        confidence_score: classification.confidence_score,
        classification_reason: classification.classification_reason,
        matched_template: classification.matched_template,
        classified_at: classification.classified_at,
      },
      agent_user_id: userId,
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

    const tenant = await tenantForContent(supabase, contentId, "Brand requirements evaluation")
    if (!tenant.ok) return { success: false, error: tenant.error }

    const { error } = await supabase.from("activities").insert({
      // TENANT: the brand template these requirements are about. See header.
      brokerage_id: tenant.brokerageId,
      entity_type: "content",
      entity_id: contentId,
      activity_type: "brand_requirements_evaluated",
      metadata: {
        required_elements: requirements.required_elements,
        optional_elements: requirements.optional_elements,
        channel_specific_notes: requirements.channel_specific_notes,
        legal_disclaimers: requirements.legal_disclaimers,
        generated_at: requirements.generated_at,
      },
      agent_user_id: userId,
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

    const tenant = await tenantForContent(supabase, contentId, "Brand compliance validation")
    if (!tenant.ok) return { success: false, error: tenant.error }

    const { error } = await supabase.from("activities").insert({
      // TENANT: the brand template this validation is about. See header.
      brokerage_id: tenant.brokerageId,
      entity_type: "content",
      entity_id: contentId,
      activity_type: "brand_compliance_validated",
      metadata: {
        is_compliant: validation.is_compliant,
        missing_elements: validation.missing_elements,
        warnings: validation.warnings,
        validated_at: new Date().toISOString(),
      },
      agent_user_id: userId,
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
