import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { DocumentsClient } from "./DocumentsClient"

export default async function DocumentsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Get contact for brokerage_id
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", contactId)
    .single()

  if (!contact) {
    redirect("/portal?error=contact_not_found")
  }

  // STEP 1 — Resolve transaction IDs (never use Supabase subquery in .in())
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)

  const transactionIds = transactions?.map(t => t.id) ?? []

  // STEP 2 — Fetch client documents
  const { data: clientDocs } = await supabase
    .from("client_documents")
    .select(`id, document_name, document_url, document_type, doc_category,
             is_financial_verification, verification_amount, verification_lender,
             expiration_date, verified_by, verified_at, uploaded_by, created_at`)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // STEP 3 — Fetch transaction documents with inline analysis data
  const { data: txDocs } = transactionIds.length > 0
    ? await supabase
        .from("transaction_documents")
        .select(`id, transaction_id, doc_type, doc_label, status, storage_url,
                 uploaded_at, extracted_data, classification_confidence,
                 rejection_reason, notes`)
        .in("transaction_id", transactionIds)
        .order("uploaded_at", { ascending: false })
    : { data: [] }

  // STEP 4 — Fetch extraction log for all transaction docs with completed analysis
  const txDocIds = txDocs?.map(d => d.id) ?? []
  const { data: extractionLogs } = txDocIds.length > 0
    ? await supabase
        .from("document_extraction_log")
        .select(`id, transaction_doc_id, extraction_method, extracted_fields,
                 confidence_score, processing_status, processed_at, error_message`)
        .in("transaction_doc_id", txDocIds)
        .eq("processing_status", "completed")
        .order("processed_at", { ascending: false })
    : { data: [] }

  // STEP 5 — Fetch document checklist
  const { data: checklist } = transactionIds.length > 0
    ? await supabase
        .from("document_checklist")
        .select(`id, transaction_id, required_documents, verified_count,
                 total_count, status`)
        .in("transaction_id", transactionIds)
    : { data: [] }

  // STEP 6 — Fetch document classifications for routing metadata
  const { data: classifications } = await supabase
    .from("document_classifications")
    .select("doc_type, filing_folder, requires_review, auto_route")
    .eq("brokerage_id", contact.brokerage_id)

  // STEP 6b — Fetch pending e-sign envelopes the contact needs to sign
  // (contract_signatures are scoped by brokerage_id; contact match via agent ownership is handled by RLS)
  const { data: pendingSignatures } = await supabase
    .from("contract_signatures")
    .select("id, contract_type, provider_name, document_url, sent_at, esign_status")
    .eq("brokerage_id", contact.brokerage_id)
    .in("esign_status", ["sent", "pending", "out_for_signature"])
    .order("sent_at", { ascending: false })
    .limit(20)

  // STEP 7 — Fetch state compliance requirements for doc types present
  const uniqueDocTypes = [...new Set([
    ...(txDocs?.map(d => d.doc_type).filter(Boolean) ?? []),
    ...(clientDocs?.map(d => d.document_type).filter(Boolean) ?? []),
  ])]

  const { data: stateRequirements } = uniqueDocTypes.length > 0
    ? await supabase
        .from("state_compliance_requirements")
        .select("state, document_type, requirement_name, description, is_mandatory, timeline_days")
        .in("document_type", uniqueDocTypes)
    : { data: [] }

  return (
    <DocumentsClient
      contactId={contactId}
      clientDocs={clientDocs ?? []}
      txDocs={txDocs ?? []}
      extractionLogs={extractionLogs ?? []}
      checklist={checklist ?? []}
      classifications={classifications ?? []}
      stateRequirements={stateRequirements ?? []}
      pendingSignatures={pendingSignatures ?? []}
    />
  )
}
