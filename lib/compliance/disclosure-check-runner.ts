// lib/compliance/disclosure-check-runner.ts
//
// THE ONE DISCLOSURE-CHECK IMPLEMENTATION (§6 — one vocabulary per function).
// Extracted out of app/actions/ai-transaction-documents.ts::checkTransactionDisclosures
// so the SAME logic can run from two places without becoming two spellings of the
// same verdict:
//   1. the manual "use server" action (checkTransactionDisclosures) — a human
//      pressing a button on the transaction detail page, tenancy-gated through
//      resolveWriteContextForTenant / the act-as seam.
//   2. the AUTONOMOUS path (lib/kernel/event-reactor.ts) — this OS runs
//      autonomous loops (owner ruling, CLAUDE.md lane rules), so a disclosure
//      check must not wait for someone to open the transaction and click a
//      button. The reactor calls this runner directly on
//      KernelEvent.DOCUMENT_UPLOADED / DOCUMENT_RECEIVED for a transaction
//      document, under the compliance_officer manager.
//
// This module takes an already-authorized service client and an already-
// verified brokerageId — it does NO gating of its own (§4: gate first, THEN
// call this). Callers are responsible for tenancy.
//
// compliance_checklists is UNIQUE on (transaction_id, checklist_type)
// (compliance_checklists_transaction_id_checklist_type_key, the survivor of
// m370's duplicate-constraint drop) — exactly one 'disclosures' row per deal,
// upserted with onConflict naming that arbiter so a re-run UPDATES it instead
// of re-raising the duplicate-key (23505) a bare insert would hit on run two.
import { generateTextRouted as generateText } from "@/lib/ai/models"

type Svc = { from: (table: string) => any }

export interface DisclosureCheckParams {
  transactionId: string
  brokerageId: string
  /** Ignored by the model call itself, but stamped on ai_tool_usage so autonomous
   *  runs are billed to the same brokerage ledger as manual ones (§5 — a wrong
   *  number there is a wrong invoice). null for a fully autonomous run with no
   *  human actor in the loop. */
  userId?: string | null
  state: string
}

export interface DisclosureCheckResult {
  success: boolean
  complianceScore?: number
  missingDisclosures?: string[]
  issues?: string[]
  recommendations?: string[]
  stateSpecificRequirements?: string[]
  aiReasoning?: string
  error?: string
}

/**
 * Run the disclosure compliance check against transaction_documents and upsert
 * the compliance_checklists('disclosures') row for the transaction. Caller
 * supplies an already-tenant-scoped client (service client under a verified
 * write context, or the act-as seam's `wc.db`).
 */
export async function runDisclosureComplianceCheck(
  svc: Svc,
  params: DisclosureCheckParams,
): Promise<DisclosureCheckResult> {
  const { data: docs, error: docsError } = await svc
    .from("transaction_documents")
    .select("doc_type, doc_label, status")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  // A refused read resolves rather than throwing (supabase-js). Left
  // undestructured, `docs` would be null and the model would be asked to grade
  // a deal it was told has no documents at all — a confidently wrong 0% score.
  if (docsError) {
    return { success: false, error: `Could not read transaction documents: ${docsError.message}` }
  }

  const { text } = await generateText({
    brokerageId: params.brokerageId,
    userId: params.userId ?? null,
    model: "openai/gpt-4o-mini",
    system:
      "You are a real estate compliance officer specializing in state disclosure requirements. Always respond with valid JSON only.",
    messages: [
      {
        role: "user",
        content: `Check disclosure compliance for a real estate transaction in ${params.state}.

Documents present:
${JSON.stringify(docs ?? [])}

Return JSON:
{
  "complianceScore": number 0-100,
  "requiredDisclosures": [{"name": string, "present": boolean, "status": "complete"|"missing"|"incomplete"}],
  "missingDisclosures": [string],
  "issues": [string],
  "recommendations": [string],
  "stateSpecificRequirements": [string],
  "stateNotes": string
}`,
      },
    ],
  })

  let result: Record<string, unknown>
  try {
    const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim()
    result = JSON.parse(cleaned)
  } catch {
    return { success: false, error: "AI returned unparseable compliance data" }
  }

  const { error: checklistError } = await svc.from("compliance_checklists").upsert(
    {
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      checklist_type: "disclosures",
      items: result.requiredDisclosures ?? [],
      compliance_score: Math.max(0, Math.min(100, Math.round(Number(result.complianceScore ?? 0)))),
      ai_recommendations: result.recommendations ?? [],
      updated_at: new Date().toISOString(),
    },
    { onConflict: "transaction_id,checklist_type" },
  )

  if (checklistError) {
    return { success: false, error: `Disclosure check could not be recorded: ${checklistError.message}` }
  }

  return {
    success: true,
    complianceScore: result.complianceScore as number,
    missingDisclosures: result.missingDisclosures as string[],
    issues: result.issues as string[],
    recommendations: result.recommendations as string[],
    stateSpecificRequirements: (result.stateSpecificRequirements as string[]) ?? [],
    aiReasoning: typeof result.stateNotes === "string" ? result.stateNotes : undefined,
  }
}
