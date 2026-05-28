/**
 * lib/workflow/intelligence/field-audit.ts
 *
 * Records every AI-prefilled field on a document so the FormWizard can later
 * tell which fields the agent overrode vs accepted. Surfaces an audit trail
 * for E&O / compliance.
 *
 * Two write paths:
 *   recordAIFill(documentId, fields[])        — called by form-fill engine
 *                                                immediately after assembling
 *                                                the packet
 *   recordAgentOverride(documentId, field,    — called by FormWizard when the
 *                        newValue, reason?)     agent edits a prefilled field
 *
 * Read path:
 *   getDocumentAudit(documentId)              — returns full audit history,
 *                                                grouped by field, ready to
 *                                                surface in a "review" tab
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { FilledForm } from "../intake/form-fill-engine"

export type FieldConfidence = "high" | "medium" | "low" | "agent_override"

export interface FieldAuditEntry {
  id?:             string
  documentId:      string
  fieldName:       string
  aiValue?:        unknown
  aiSource?:       string                // which intake field provided the value
  aiConfidence?:   FieldConfidence
  agentValue?:     unknown
  agentOverrode?:  boolean
  overrideReason?: string
  editedAt?:       string
  createdAt?:      string
}

/**
 * Record AI-fill for every filled field across every form in the packet.
 * Called by the form-fill engine after fillOfferPacket / fillListingPacket
 * assembles results.
 */
export async function recordAIFill(
  documentId: string,
  forms: FilledForm[]
): Promise<{ recorded: number }> {
  const svc = createServiceClient()
  const rows: Array<{
    document_id:    string
    field_name:     string
    ai_value:       unknown
    ai_source:      string | null
    ai_confidence:  FieldConfidence
    agent_overrode: boolean
  }> = []

  for (const form of forms) {
    for (const filled of form.filledFields) {
      rows.push({
        document_id:    documentId,
        field_name:     `${form.formId}.${filled.fieldName}`,
        ai_value:       filled.value,
        ai_source:      filled.sourceField,
        ai_confidence:  filled.confidence,
        agent_overrode: false,
      })
    }
  }

  if (rows.length === 0) return { recorded: 0 }

  const { error } = await svc.from("document_field_audit").insert(rows)
  if (error) return { recorded: 0 }

  return { recorded: rows.length }
}

/**
 * Record an agent override on a previously-AI-filled field.
 * Called from the FormWizard "save" handler.
 */
export async function recordAgentOverride(input: {
  documentId:     string
  fieldName:      string                  // form-qualified, e.g. "tar_1601.buyer_full_name"
  newValue:       unknown
  overrideReason?: string
}): Promise<{ success: boolean; error?: string }> {
  const svc = createServiceClient()

  // Find the existing audit row (most recent) for this document+field
  const { data: existing } = await svc
    .from("document_field_audit")
    .select("id, ai_value")
    .eq("document_id", input.documentId)
    .eq("field_name", input.fieldName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const overrode =
    existing?.ai_value !== undefined &&
    JSON.stringify(existing.ai_value) !== JSON.stringify(input.newValue)

  if (existing?.id) {
    const { error } = await svc.from("document_field_audit").update({
      agent_value:     input.newValue,
      agent_overrode:  overrode,
      override_reason: input.overrideReason ?? null,
      edited_at:       new Date().toISOString(),
    }).eq("id", existing.id)
    if (error) return { success: false, error: error.message }
    return { success: true }
  }

  // No prior AI-fill row — record as an agent-originated entry
  const { error } = await svc.from("document_field_audit").insert({
    document_id:     input.documentId,
    field_name:      input.fieldName,
    agent_value:     input.newValue,
    agent_overrode:  false,
    ai_confidence:   "agent_override",
    override_reason: input.overrideReason ?? null,
    edited_at:       new Date().toISOString(),
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Read the full audit trail for a document, grouped by field.
 * Surfaces in a "Review" tab so agents (and E&O auditors) can see exactly
 * which values were AI-suggested vs agent-typed vs agent-overridden.
 */
export async function getDocumentAudit(documentId: string): Promise<{
  entries: FieldAuditEntry[]
  summary: {
    totalFields: number
    aiFilled:    number
    agentOverrode: number
    confidenceBreakdown: Record<FieldConfidence, number>
  }
}> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("document_field_audit")
    .select("id, document_id, field_name, ai_value, ai_source, ai_confidence, agent_value, agent_overrode, override_reason, edited_at, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true })

  const entries: FieldAuditEntry[] = (data ?? []).map((r: any) => ({
    id:             r.id,
    documentId:     r.document_id,
    fieldName:      r.field_name,
    aiValue:        r.ai_value,
    aiSource:       r.ai_source,
    aiConfidence:   r.ai_confidence,
    agentValue:     r.agent_value,
    agentOverrode:  r.agent_overrode,
    overrideReason: r.override_reason,
    editedAt:       r.edited_at,
    createdAt:      r.created_at,
  }))

  const confidenceBreakdown: Record<FieldConfidence, number> = {
    high: 0, medium: 0, low: 0, agent_override: 0,
  }
  let aiFilled = 0
  let agentOverrode = 0
  for (const e of entries) {
    if (e.aiConfidence) {
      confidenceBreakdown[e.aiConfidence]++
      if (e.aiConfidence !== "agent_override") aiFilled++
    }
    if (e.agentOverrode) agentOverrode++
  }

  return {
    entries,
    summary: {
      totalFields: entries.length,
      aiFilled,
      agentOverrode,
      confidenceBreakdown,
    },
  }
}
