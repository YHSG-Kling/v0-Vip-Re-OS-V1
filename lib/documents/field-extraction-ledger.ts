/**
 * lib/documents/field-extraction-ledger.ts
 *
 * THE EXTRACTION LEDGER — document kernel Phase A. The universal scanner
 * already writes extracted_fields as one jsonb blob on documents; this
 * ledger breaks that blob into one auditable row PER FIELD so each fact
 * carries its own confidence + provenance and can be individually
 * verified later (verified_by_user_id / verified_at, Phase B review UI).
 *
 * Direction matters: document_field_audit audits the FILL direction (the
 * form-fill engine writing values INTO a generated packet, FormWizard
 * overrides). THIS ledger is the SCAN direction — facts extracted FROM an
 * uploaded document, feeding deadline derivation and participant wiring.
 * The raw scan blob on documents.extracted_fields is never rewritten by
 * verification, so the original AI output is always preserved.
 *
 * Idempotent: upserts on (document_id, field_key); a re-scan refreshes
 * unverified rows but NEVER overwrites a row a human already verified.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** Skip null/empty values — an empty extraction is not a fact. */
const usable = (v: unknown): boolean => {
  if (v === null || v === undefined) return false
  if (typeof v === "string" && v.trim() === "") return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

export async function recordFieldExtractions(
  svc: Svc,
  input: {
    documentId: string
    brokerageId: string
    fields: Record<string, unknown>
    confidence: "high" | "medium" | "low"
    /** provenance of the extractor, e.g. "router:document_classification". */
    extractionModel: string
  },
): Promise<{ recorded: number; preservedVerified: number }> {
  const keys = Object.keys(input.fields ?? {}).filter((k) => usable(input.fields[k]))
  if (keys.length === 0) return { recorded: 0, preservedVerified: 0 }

  // Never clobber human-verified rows on re-scan.
  const { data: verified } = await svc
    .from("document_field_extractions")
    .select("field_key")
    .eq("document_id", input.documentId)
    .not("verified_at", "is", null)
    .in("field_key", keys)
  const keep = new Set(((verified ?? []) as Array<{ field_key: string }>).map((r) => r.field_key))

  const rows = keys
    .filter((k) => !keep.has(k))
    .map((k) => ({
      document_id: input.documentId,
      brokerage_id: input.brokerageId,
      field_key: k,
      field_value_json: input.fields[k] as any,
      confidence: input.confidence,
      extraction_model: input.extractionModel,
    }))
  if (rows.length === 0) return { recorded: 0, preservedVerified: keep.size }

  const { error } = await svc
    .from("document_field_extractions")
    .upsert(rows, { onConflict: "document_id,field_key" })
  return { recorded: error ? 0 : rows.length, preservedVerified: keep.size }
}
