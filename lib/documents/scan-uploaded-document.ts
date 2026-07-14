/**
 * lib/documents/scan-uploaded-document.ts
 *
 * Universal document scanner. Called for every uploaded document so the deal
 * file stays organized.
 *
 * Per agent direction: "all documents that are uploaded need to be scanned
 * and if it isnt something we need to fill in either the record or contract
 * realatied, should be organized with summary of what it is."
 *
 * The scanner:
 *   1. Classifies the document into the canonical taxonomy (PAL, POF, ID,
 *      signed contract, counter, disclosure, addendum, inspection/appraisal
 *      report, title report, HOA docs, CD, wire instructions, agency
 *      disclosure, commission agreement, lender letter, or 'other').
 *   2. Generates a 1-2 sentence summary the agent can read at a glance.
 *   3. Extracts the structured fields appropriate to the classification:
 *      - PAL                → { lender_name, loan_type, max_amount, expires_at }
 *      - proof_of_funds     → { institution, account_holder, available_funds, statement_date }
 *      - signed_contract /
 *        counter_offer      → { property_address, all_signers_signed, signed_dates[], price }
 *      - disclosure /
 *        addendum           → { disclosure_type, signed_parties[] }
 *      - inspection_report  → { inspector, inspection_date, key_issues[] }
 *      - appraisal_report   → { appraiser, appraised_value, appraisal_date }
 *      - other              → free-form summary only
 *
 * Result is written back to documents (classification, summary,
 * extracted_fields, classification_confidence, scanned_at).
 *
 * The scanner is idempotent: re-running on a scanned doc skips it unless
 * `force=true`. Failures stamp `scan_error` and leave classification null
 * so the agent can hand-classify.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted }   from "@/lib/ai/models"

export type DocumentClassification =
  | "pre_approval_letter"
  | "proof_of_funds"
  | "id_document"
  | "signed_contract"
  | "counter_offer"
  | "addendum"
  | "disclosure"
  | "inspection_report"
  | "appraisal_report"
  | "title_report"
  | "hoa_documents"
  | "closing_disclosure"
  | "wire_instructions"
  | "agency_disclosure"
  | "commission_agreement"
  | "lender_letter"
  | "earnest_money_receipt"
  | "other"

export interface ScanResult {
  success:        boolean
  documentId:     string
  classification?: DocumentClassification
  classification_confidence?: "high" | "medium" | "low"
  summary?:       string
  extracted_fields?: Record<string, unknown>
  error?:         string
}

const SCAN_PROMPT = `You are classifying a document uploaded into a real estate deal file. Return ONLY valid JSON. No markdown, no commentary.

Classify into ONE of:
  pre_approval_letter | proof_of_funds | id_document | signed_contract |
  counter_offer | addendum | disclosure | inspection_report |
  appraisal_report | title_report | hoa_documents | closing_disclosure |
  wire_instructions | agency_disclosure | commission_agreement |
  lender_letter | earnest_money_receipt | other

Output schema:
{
  "classification": "<one of above>",
  "confidence":     "high" | "medium" | "low",
  "summary":        "<1-2 sentence plain-English summary the agent reads at a glance>",
  "state_form_id":  "<the specific state form number when recognizable, e.g. 'TREC 20-17' / 'TREC OP-H' / 'CAR RPA-CA' / 'FAR/BAR ASIS-5' / 'CAR RLA' — null if generic>",
  "extracted_fields": { ... }   // shape depends on classification (see below)
}

Per-classification extracted_fields shape:
  pre_approval_letter   → { lender_name, loan_type, max_loan_amount, issued_at, expires_at, borrower_name }
  proof_of_funds        → { institution, account_holder, available_funds, statement_date }
  id_document           → { document_type, full_name, expiration_date }
  signed_contract       → { property_address, parties_signed[], signed_dates[], price, title_company, earnest_money_amount, earnest_money_due_days, contract_effective_date }
  counter_offer         → { property_address, counter_price, counter_terms, seller_signed_at, round_label, earnest_money_due_days }
  addendum              → { addendum_type, signed_parties[] }
  disclosure            → { disclosure_type, signed_parties[] }
  inspection_report     → { inspector_name, inspection_date, key_issues[] }
  appraisal_report      → { appraiser_name, appraised_value, appraisal_date }
  title_report          → { title_company, report_date, key_exceptions[] }
  hoa_documents         → { hoa_name, dues_amount, dues_frequency }
  closing_disclosure    → { closing_date, lender_name, loan_amount, cash_to_close }
  wire_instructions     → { receiving_institution, account_number_last_4, beneficiary_name }
  agency_disclosure     → { brokerage_name, agent_name, signed_at }
  commission_agreement  → { commission_percentage, commission_payer, expires_at }
  lender_letter         → { lender_name, letter_type, issued_at }
  earnest_money_receipt → { amount, depositor, escrow_holder, received_at }
  other                 → { document_type_guess }

Now classify this document content:

`

export async function scanUploadedDocument(params: {
  documentId: string
  force?:     boolean
}): Promise<ScanResult> {
  const { documentId, force = false } = params
  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from("documents")
    .select("id, brokerage_id, contact_id, transaction_id, document_type, content, storage_url, classification, scanned_at, metadata")
    .eq("id", documentId)
    .maybeSingle()

  if (!doc) return { success: false, documentId, error: "Document not found" }
  if (!force && doc.scanned_at) {
    return {
      success: true, documentId,
      classification: doc.classification as DocumentClassification | undefined,
      summary: undefined,  // already on disk
    }
  }

  // Source text for the classifier:
  //   1. Prefer documents.content (JSON or text) when present.
  //   2. Otherwise OCR the PDF/image at storage_url (pdf-parse → vision fallback).
  let sourceText = ""
  if (doc.content) {
    sourceText = typeof doc.content === "string"
      ? doc.content.slice(0, 8000)
      : JSON.stringify(doc.content).slice(0, 8000)
  } else if (doc.storage_url) {
    try {
      const { ocrDocumentFromUrl } = await import("./ocr-pdf")
      const ocr = await ocrDocumentFromUrl({
        storageUrl:   doc.storage_url as string,
        brokerageId:  (doc as any).brokerage_id ?? null,
      })
      if (ocr.success && ocr.text) {
        sourceText = ocr.text
      } else {
        sourceText = `Document type hint: ${doc.document_type}\nStorage URL: ${doc.storage_url}\n(OCR failed: ${ocr.error ?? "unknown"} — classifier will use the hint only.)`
      }
    } catch (err: any) {
      sourceText = `Document type hint: ${doc.document_type}\nStorage URL: ${doc.storage_url}\n(OCR threw: ${err?.message ?? err})`
    }
  } else {
    sourceText = `Document type hint: ${doc.document_type}\n(No content provided.)`
  }

  let result: any
  try {
    const { text } = await generateTextRouted({
      feature:    "document_classification",
      system:     "You are a strict JSON classifier for real estate documents. Output JSON only — no prose.",
      prompt:     SCAN_PROMPT + sourceText,
      temperature: 0,
      maxTokens:  800,
    })
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    result = JSON.parse(cleaned)
  } catch (err: any) {
    await supabase
      .from("documents")
      .update({ scan_error: err?.message ?? "scan failed", scanned_at: new Date().toISOString() })
      .eq("id", documentId)
    return { success: false, documentId, error: err?.message ?? "scan failed" }
  }

  const classification: DocumentClassification =
    (CLASSIFICATIONS.includes(result.classification) ? result.classification : "other") as DocumentClassification
  const confidence = (["high","medium","low"].includes(result.confidence) ? result.confidence : "low") as "high" | "medium" | "low"
  const summary = String(result.summary ?? "")
  const extracted = (result.extracted_fields && typeof result.extracted_fields === "object")
    ? result.extracted_fields
    : {}

  const stateFormId = (typeof result.state_form_id === "string" && result.state_form_id.trim())
    ? result.state_form_id.trim() : null

  await supabase
    .from("documents")
    .update({
      classification,
      classification_confidence: confidence,
      summary,
      extracted_fields:          extracted,
      state_form_id:             stateFormId,
      scanned_at:                new Date().toISOString(),
      scan_error:                null,
    })
    .eq("id", documentId)

  // Post-scan hook: when the classification yields participant info (PAL →
  // lender; signed_contract → title_company), wire the extracted fields
  // straight into transaction_participants if a transaction already exists.
  // No-op when there's no tx yet — the tx-creation participant populator
  // will read the PAL / signed_contract for the contact at that time.
  try {
    const { autoPopulateFromScannedDocument } = await import("./auto-populate-participants")
    await autoPopulateFromScannedDocument(supabase as any, {
      documentId,
      classification,
      extractedFields: extracted,
      brokerageId:    (doc.brokerage_id as string),
      contactId:      (doc as any).contact_id ?? null,
      offerId:        ((doc as any).metadata?.linked_offer_id as string | undefined) ?? null,
      transactionId:  (doc as any).transaction_id ?? null,
    })
  } catch (err: any) {
    console.error("[scan] auto-populate hook failed (non-fatal):", err?.message ?? err)
  }

  // Post-scan hook 2 — THE DOCUMENT KERNEL (Phase A): break the extraction
  // blob into the per-field ledger (each fact individually auditable and
  // verifiable), then derive deadline dates onto the existing
  // transaction_deadlines rail through the green/amber/red policy gate
  // (additive inserts only; conflicts become gated review proposals).
  try {
    const { recordFieldExtractions } = await import("./field-extraction-ledger")
    await recordFieldExtractions(supabase as any, {
      documentId,
      brokerageId: doc.brokerage_id as string,
      fields: extracted as Record<string, unknown>,
      confidence,
      extractionModel: "router:document_classification",
    })
    const { deriveDeadlinesFromDocument } = await import("./deadline-derivation")
    await deriveDeadlinesFromDocument(supabase as any, {
      documentId,
      brokerageId: doc.brokerage_id as string,
      transactionId: ((doc as any).transaction_id as string | null) ?? null,
      classification,
      confidence,
      fields: extracted as Record<string, unknown>,
    })
    // Phase B: does this document's arrival mean the deal has MOVED? The
    // kernel proposes a stage advance (real engine gates consulted first);
    // a human approves on the feed — the kernel never moves a stage itself.
    const { proposeStageCandidateFromDocument } = await import("./stage-candidates")
    await proposeStageCandidateFromDocument(supabase as any, {
      documentId,
      brokerageId: doc.brokerage_id as string,
      transactionId: ((doc as any).transaction_id as string | null) ?? null,
    })
    // Hook 4 — SCANNED DATA → THE CONTACT: verified/high-confidence contract
    // parties fill the deal contacts' EMPTY legal names (additive-only,
    // provenance-stamped; a recorded legal name is never overwritten).
    const { writebackLegalNames } = await import("./contact-legal-writeback")
    await writebackLegalNames(supabase as any, {
      documentId,
      brokerageId: doc.brokerage_id as string,
      transactionId: ((doc as any).transaction_id as string | null) ?? null,
    })
  } catch (err: any) {
    console.error("[scan] document-kernel hook failed (non-fatal):", err?.message ?? err)
  }

  return {
    success: true,
    documentId,
    classification,
    classification_confidence: confidence,
    summary,
    extracted_fields: extracted,
  }
}

const CLASSIFICATIONS: DocumentClassification[] = [
  "pre_approval_letter","proof_of_funds","id_document","signed_contract",
  "counter_offer","addendum","disclosure","inspection_report",
  "appraisal_report","title_report","hoa_documents","closing_disclosure",
  "wire_instructions","agency_disclosure","commission_agreement",
  "lender_letter","earnest_money_receipt","other",
]
