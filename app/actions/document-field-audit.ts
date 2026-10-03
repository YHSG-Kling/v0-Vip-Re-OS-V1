"use server"

/**
 * app/actions/document-field-audit.ts
 *
 * THE READ DOOR for `document_field_audit` — the per-field AI-fill / agent-override
 * ledger written by lib/workflow/intelligence/field-audit.ts.
 *
 * WHY THIS FILE EXISTS. That ledger had a complete write loop and NO reader:
 *   · recordAIFill      — app/actions/voice-assistant/draft-offer-from-voice.ts,
 *                         app/actions/voice-assistant/draft-listing-from-voice.ts
 *                         (the two HTTP doors that also called it,
 *                         /api/workflow/intake/offer and /api/workflow/intake/listing,
 *                         were retired onto those two actions — same pipeline, no
 *                         caller, session-only so not an external door either)
 *   · recordAgentOverride — app/api/workflow/intake/approve-packet/route.ts:55
 *   · getDocumentAudit  — called by NOTHING.
 * So every AI-staged packet wrote one row per prefilled field, the FormWizard
 * approve step flipped `agent_overrode` on the ones the agent changed, and the
 * resulting E&O trail — which values were AI-suggested, at what confidence, and
 * which a licensed human overrode — was never shown to anyone. A write-only audit
 * ledger is not an audit trail; it is storage.
 *
 * `getDocumentAudit` is `server-only` and reads through the SERVICE client, which
 * bypasses RLS, so it cannot be handed to a client component as-is. This action is
 * the gate: the caller must be signed in, and the document must belong to the
 * caller's brokerage. `documents.brokerage_id` is the authority on that — never a
 * brokerage id supplied by the caller.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import type { FieldAuditEntry, FieldConfidence } from "@/lib/workflow/intelligence/field-audit"

export interface DocumentFieldAuditResult {
  entries: FieldAuditEntry[]
  summary: {
    totalFields: number
    aiFilled: number
    agentOverrode: number
    confidenceBreakdown: Record<FieldConfidence, number>
  }
}

export async function getDocumentFieldAuditAction(
  documentId: string,
): Promise<{ ok: true; audit: DocumentFieldAuditResult } | { ok: false; error: string }> {
  if (!isValidUUID(documentId)) return { ok: false, error: "Invalid document id" }

  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  // Both reads destructure `error`: supabase-js RESOLVES a refused query, so
  // `const { data }` alone renders "RLS refused" and "no such row" identically —
  // and this is a gate, so a refusal must fail closed and say so rather than be
  // reported as "not found".
  const { data: profile, error: profileError } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: "Could not verify the caller" }
  if (!profile?.brokerage_id) return { ok: false, error: "Brokerage not configured" }

  const svc = createServiceClient()
  const { data: doc, error: docError } = await svc
    .from("documents")
    .select("id, brokerage_id")
    .eq("id", documentId)
    .maybeSingle()
  if (docError) return { ok: false, error: "Could not read the document" }
  if (!doc) return { ok: false, error: "Document not found" }
  if (doc.brokerage_id !== profile.brokerage_id) return { ok: false, error: "Forbidden" }

  const { getDocumentAudit } = await import("@/lib/workflow/intelligence/field-audit")
  const audit = await getDocumentAudit(documentId)
  // A refused ledger read is reported as a refusal, not as an empty audit trail.
  if (audit.error) return { ok: false, error: `Could not read the field audit: ${audit.error}` }
  return { ok: true, audit }
}
