// lib/documents/auto-filer.ts
import { createServiceClient } from "@/lib/supabase/service"
import { triggerMilestoneFromDocument } from "@/lib/transactions/milestone-auto-trigger"

/**
 * autoFileDocument
 * Classifies and routes an uploaded document based on keyword matching against
 * document_classifications rules. If a match is found and no review is required,
 * triggers milestone completion via triggerMilestoneFromDocument.
 */
export async function autoFileDocument(
  transactionDocId: string,
  brokerageId: string
) {
  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from("transaction_documents")
    .select(
      "id, transaction_id, doc_label, doc_type, extracted_data, classification_confidence, status, uploaded_by"
    )
    .eq("id", transactionDocId)
    .single()

  if (!doc) throw new Error("Document not found")

  const rawText = JSON.stringify(doc.extracted_data ?? {}).toLowerCase()

  const { data: rules } = await supabase
    .from("document_classifications")
    .select("*")
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)

  let bestMatch: any = null
  let bestScore = 0

  for (const rule of rules ?? []) {
    const keywords: string[] = rule.keywords ?? []
    const score = keywords.reduce(
      (acc, k) => acc + (rawText.includes(String(k).toLowerCase()) ? 1 : 0),
      0
    )
    if (score > bestScore) {
      bestScore = score
      bestMatch = rule
    }
  }

  if (bestMatch && bestScore > 0) {
    await supabase
      .from("transaction_documents")
      .update({
        doc_type: bestMatch.doc_type,
        status: bestMatch.requires_review ? "under_review" : "approved",
      })
      .eq("id", transactionDocId)

    if (!bestMatch.requires_review && doc.uploaded_by) {
      await triggerMilestoneFromDocument({
        transactionId: doc.transaction_id,
        brokerageId,
        docType: bestMatch.doc_type,
        uploadedBy: doc.uploaded_by,
      })
    }

    return { success: true, routed: true, docType: bestMatch.doc_type }
  }

  await supabase
    .from("transaction_documents")
    .update({ status: "under_review" })
    .eq("id", transactionDocId)

  return { success: true, routed: false }
}

/**
 * checkMissingDocuments
 * Compares required docs for a given stage against uploaded documents.
 * Creates a proactive_interventions row if any are missing.
 */
export async function checkMissingDocuments(params: {
  transactionId: string
  brokerageId: string
  stage: string
}) {
  const REQUIRED_DOCS: Record<string, string[]> = {
    UNDER_CONTRACT: ["purchase_contract", "earnest_money_receipt"],
    INSPECTION: ["inspection_report"],
    APPRAISAL: ["appraisal_report"],
    FINANCING_PENDING: ["lender_approval_letter", "clear_to_close_letter"],
    CLOSING_PREP: ["closing_disclosure", "title_commitment"],
    CLOSED: ["recorded_deed", "final_settlement_statement"],
  }

  const supabase = createServiceClient()
  const needed = REQUIRED_DOCS[params.stage] ?? []
  if (!needed.length) return { missing: [] }

  const { data } = await supabase
    .from("transaction_documents")
    .select("doc_type, status")
    .eq("transaction_id", params.transactionId)

  const present = new Set(
    (data ?? [])
      .filter((d: any) =>
        ["approved", "under_review", "uploaded"].includes(d.status)
      )
      .map((d: any) => d.doc_type)
  )

  const missing = needed.filter((docType) => !present.has(docType))

  if (missing.length) {
    await supabase.from("proactive_interventions").insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      issue_detected: `Missing required documents for ${params.stage}: ${missing.join(", ")}`,
      severity: params.stage === "CLOSING_PREP" ? "high" : "medium",
      client_impacted: false,
    })
  }

  return { missing }
}
