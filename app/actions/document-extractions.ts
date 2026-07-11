"use server"

/**
 * app/actions/document-extractions.ts
 *
 * EXTRACTION VERIFICATION — the human loop on the document kernel's
 * per-field ledger. The TC/agent sees what the AI read out of each deal
 * document and confirms or corrects each fact:
 *
 *   · verify   → verified_by_user_id / verified_at stamped, confidence
 *                lifted to high (a named human is the strongest evidence).
 *   · correct  → the ledger row takes the human's value (the raw scan
 *                blob on documents.extracted_fields is NEVER rewritten —
 *                the AI's original output stays preserved for audit).
 *
 * Verification RE-DERIVES the document's deadlines: the deriver treats a
 * verified field as high confidence, so an amber "propose" from a
 * medium-confidence scan upgrades to a green autonomous insert the
 * moment a human confirms the fact — the assisted→autonomous ladder.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

async function loadActor(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: row } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "No brokerage" }
  return { ok: true, userId: user.id, brokerageId: (row as any).brokerage_id }
}

export interface ExtractionRow {
  id: string
  documentId: string
  fieldKey: string
  value: unknown
  confidence: string
  verified: boolean
  classification: string | null
  documentSummary: string | null
  transactionId: string | null
  createdAt: string
}

/** Recent extracted facts for the actor's brokerage — unverified first. */
export async function listRecentExtractionsAction(input?: {
  limit?: number
}): Promise<{ ok: boolean; rows?: ExtractionRow[]; error?: string }> {
  const actor = await loadActor()
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const { data } = await svc
    .from("document_field_extractions")
    .select("id, document_id, field_key, field_value_json, confidence, verified_at, created_at")
    .eq("brokerage_id", actor.brokerageId)
    .order("created_at", { ascending: false })
    .limit(input?.limit ?? 30)
  const rows = (data ?? []) as any[]
  if (rows.length === 0) return { ok: true, rows: [] }

  const docIds = Array.from(new Set(rows.map((r) => r.document_id)))
  const { data: docs } = await svc
    .from("documents")
    .select("id, classification, summary, transaction_id")
    .in("id", docIds)
  const docById = new Map(((docs ?? []) as any[]).map((d) => [d.id, d]))

  const out: ExtractionRow[] = rows.map((r) => {
    const d = docById.get(r.document_id)
    return {
      id: r.id,
      documentId: r.document_id,
      fieldKey: r.field_key,
      value: r.field_value_json,
      confidence: r.confidence,
      verified: !!r.verified_at,
      classification: (d?.classification as string | null) ?? null,
      documentSummary: (d?.summary as string | null) ?? null,
      transactionId: (d?.transaction_id as string | null) ?? null,
      createdAt: r.created_at,
    }
  })
  // Unverified facts first (the work), then the confirmed trail.
  out.sort((a, b) => Number(a.verified) - Number(b.verified))
  return { ok: true, rows: out }
}

export async function verifyExtractionAction(input: {
  extractionId: string
  /** present = the human corrected the value; absent = confirmed as-is. */
  correctedValue?: string
}): Promise<{ ok: boolean; rederived?: boolean; error?: string }> {
  const actor = await loadActor()
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const { data: row } = await svc
    .from("document_field_extractions")
    .select("id, document_id, field_key, field_value_json, brokerage_id")
    .eq("id", input.extractionId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (!row) return { ok: false, error: "Extraction not found" }

  const corrected = typeof input.correctedValue === "string" && input.correctedValue.trim() !== ""
  const update: Record<string, unknown> = {
    verified_by_user_id: actor.userId,
    verified_at: new Date().toISOString(),
    confidence: "high",
  }
  if (corrected) update.field_value_json = input.correctedValue!.trim()
  const { error } = await svc.from("document_field_extractions").update(update).eq("id", (row as any).id)
  if (error) return { ok: false, error: error.message }

  // Re-derive with the verified fact: the deriver reads the ledger's
  // verified keys, so a medium-confidence amber upgrades to green now.
  let rederived = false
  try {
    const { data: doc } = await svc
      .from("documents")
      .select("id, brokerage_id, transaction_id, classification, classification_confidence, extracted_fields")
      .eq("id", (row as any).document_id)
      .maybeSingle()
    if (doc?.classification) {
      // Effective fields = the raw scan overlaid with every verified ledger
      // value (human corrections included) — the scan blob itself stays as-is.
      const { data: ledger } = await svc
        .from("document_field_extractions")
        .select("field_key, field_value_json")
        .eq("document_id", (doc as any).id)
        .not("verified_at", "is", null)
      const fields: Record<string, unknown> = { ...(((doc as any).extracted_fields ?? {}) as Record<string, unknown>) }
      for (const l of ((ledger ?? []) as any[])) fields[l.field_key] = l.field_value_json

      const { deriveDeadlinesFromDocument } = await import("@/lib/documents/deadline-derivation")
      const run = await deriveDeadlinesFromDocument(svc as any, {
        documentId: (doc as any).id,
        brokerageId: (doc as any).brokerage_id,
        transactionId: ((doc as any).transaction_id as string | null) ?? null,
        classification: (doc as any).classification,
        confidence: ((doc as any).classification_confidence ?? "medium") as "high" | "medium" | "low",
        fields,
      })
      rederived = run.inserted > 0 || run.confirmed > 0
    }
  } catch { /* verification stands even if re-derivation hiccups */ }

  return { ok: true, rederived }
}
