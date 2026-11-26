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
    /**
     * Wave 152 (lane 152D): a reader that grades each fact on its own evidence (the receipt reader — a total found
     * verbatim on its page is high, a merchant it could not locate is low) passes the per-field grade here; a key not
     * named falls back to `confidence`. The scanner passes nothing and is unchanged.
     */
    confidenceByField?: Record<string, "high" | "medium" | "low">
    /** provenance of the extractor, e.g. "router:document_classification". */
    extractionModel: string
  },
): Promise<{ recorded: number; preservedVerified: number; error?: string }> {
  const keys = Object.keys(input.fields ?? {}).filter((k) => usable(input.fields[k]))
  if (keys.length === 0) return { recorded: 0, preservedVerified: 0 }

  // Never clobber human-verified rows on re-scan. A REFUSED read is not "nothing verified" (CLAUDE.md §3): writing on
  // a refused read would overwrite a human's verified value, so the write is skipped and the refusal returned.
  const { data: verified, error: verifiedErr } = await svc
    .from("document_field_extractions")
    .select("field_key")
    .eq("document_id", input.documentId)
    .not("verified_at", "is", null)
    .in("field_key", keys)
  if (verifiedErr) return { recorded: 0, preservedVerified: 0, error: `verified-row read refused: ${verifiedErr.message}` }
  const keep = new Set(((verified ?? []) as Array<{ field_key: string }>).map((r) => r.field_key))

  const rows = keys
    .filter((k) => !keep.has(k))
    .map((k) => ({
      document_id: input.documentId,
      brokerage_id: input.brokerageId,
      field_key: k,
      field_value_json: input.fields[k] as any,
      confidence: input.confidenceByField?.[k] ?? input.confidence,
      extraction_model: input.extractionModel,
    }))
  if (rows.length === 0) return { recorded: 0, preservedVerified: keep.size }

  const { error } = await svc
    .from("document_field_extractions")
    .upsert(rows, { onConflict: "document_id,field_key" })
  return error
    ? { recorded: 0, preservedVerified: keep.size, error: error.message }
    : { recorded: rows.length, preservedVerified: keep.size }
}

/**
 * THE EXTRACTION READER (wave 152, lane 152D) — one tenant-pinned read of the ledger for a set of documents, each row
 * returned with its VALUE unwrapped and its EVIDENCE beside it, whichever shape the writer stored:
 *   · the evidence envelope `{ v: 1, value, page, excerpt, … }` (the receipt reader, lib/documents/receipt-rules.ts);
 *   · the `{ value, page }` / `page_number` shapes lib/offers/governing-terms-rule.ts already reads defensively;
 *   · a bare scalar (the universal scanner's contract fields) — value as stored, evidence null (the scanner records
 *     no page for those; that is a stated blind spot, not an inferred page).
 * A refused read is an error, never "no facts". Lane 152E's term comparison reads extractions through this.
 */
export async function readDocumentExtractions(
  svc: Svc,
  input: { brokerageId: string; documentIds: string[]; keyPrefix?: string },
): Promise<{ ok: true; rows: DocumentExtraction[] } | { ok: false; error: string }> {
  if (input.documentIds.length === 0) return { ok: true, rows: [] }
  const { data, error } = await svc
    .from("document_field_extractions")
    .select("id, document_id, field_key, field_value_json, confidence, extraction_model, verified_at, verified_by_user_id, created_at")
    .eq("brokerage_id", input.brokerageId)
    .in("document_id", input.documentIds)
  if (error) return { ok: false, error: `extraction ledger could not be read: ${error.message}` }
  const rows = ((data ?? []) as Array<Record<string, any>>)
    .filter((r) => !input.keyPrefix || String(r.field_key).startsWith(input.keyPrefix))
    .map((r): DocumentExtraction => {
      const raw = r.field_value_json
      const isObj = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      const envelope = isObj && (raw as any).v === 1 && "value" in raw
      const legacyPaged = isObj && !envelope && "value" in raw
      const page = isObj ? Number((raw as any).page ?? (raw as any).page_number) : NaN
      return {
        id: String(r.id),
        documentId: String(r.document_id),
        fieldKey: String(r.field_key),
        value: envelope || legacyPaged ? (raw as any).value : raw,
        evidence: envelope || legacyPaged
          ? {
              page: Number.isInteger(page) && page > 0 ? page : null,
              excerpt: typeof (raw as any).excerpt === "string" ? (raw as any).excerpt : null,
              evidenceLocated: (raw as any).evidence_located === true,
              uncertainty: typeof (raw as any).uncertainty === "string" ? (raw as any).uncertainty : null,
            }
          : null,
        envelope: envelope ? (raw as Record<string, unknown>) : null,
        confidence: (r.confidence as string | null) ?? null,
        extractionModel: (r.extraction_model as string | null) ?? null,
        verifiedAt: (r.verified_at as string | null) ?? null,
        verifiedByUserId: (r.verified_by_user_id as string | null) ?? null,
      }
    })
  return { ok: true, rows }
}

export interface DocumentExtraction {
  id: string
  documentId: string
  fieldKey: string
  value: unknown
  evidence: { page: number | null; excerpt: string | null; evidenceLocated: boolean; uncertainty: string | null } | null
  envelope: Record<string, unknown> | null
  confidence: string | null
  extractionModel: string | null
  verifiedAt: string | null
  verifiedByUserId: string | null
}
