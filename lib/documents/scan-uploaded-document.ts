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
import {
  ALL_DOCUMENT_CLASSIFICATIONS,
  type DocumentClassification,
} from "@/lib/compliance/document-classifications"

/**
 * The taxonomy is NOT declared here. It lives in lib/compliance/document-
 * classifications.ts, which is what the required-document presets and
 * auditListingDocuments are written against. This module used to declare its
 * own 18-value copy that had drifted behind that one — see CLASSIFICATIONS at
 * the foot of the file for what that cost.
 *
 * Re-exported so existing importers of this name keep working.
 */
export type { DocumentClassification }

export interface ScanResult {
  success:        boolean
  documentId:     string
  classification?: DocumentClassification
  classification_confidence?: "high" | "medium" | "low"
  summary?:       string
  extracted_fields?: Record<string, unknown>
  error?:         string
}

// The offered list is GENERATED from the canonical taxonomy. Writing it out by
// hand is what let this prompt fall behind the vocabulary the compliance audit
// requires — it never offered listing_agreement, so the model could not name
// one, so the listing-agreement gate could never be satisfied by an upload.
const SCAN_PROMPT = `You are classifying a document uploaded into a real estate deal file. Return ONLY valid JSON. No markdown, no commentary.

Classify into ONE of:
  ${ALL_DOCUMENT_CLASSIFICATIONS.join(" | ")}

Output schema:
{
  "classification": "<one of above>",
  "confidence":     "high" | "medium" | "low",
  "summary":        "<1-2 sentence plain-English summary the agent reads at a glance>",
  "state_form_id":  "<the specific state form number when recognizable, e.g. 'TREC 20-17' / 'TREC OP-H' / 'CAR RPA-CA' / 'FAR/BAR ASIS-5' / 'CAR RLA' — null if generic>",
  "signature_completeness": {
    "signatures": [ { "signer_role": "agent" | "seller" | "buyer" | "broker" | "other", "signer_name": "<name or null>", "signed": true | false } ],
    "initials":   [ { "signer_role": "agent" | "seller" | "buyer" | "broker" | "other", "all_required_initials_present": true | false } ]
  },
  "extracted_fields": { ... }   // shape depends on classification (see below)
}

signature_completeness rules — a listing or purchase agreement is only EXECUTABLE
when every required party has both signed AND initialed. Report what you can
actually SEE on the document. Mark "signed": false when a signature line exists
but is blank. Do NOT infer a signature from a typed name, and do NOT report a
party you cannot find a signature block for — an unverifiable signature must
read as missing, never as present, because a listing goes live on this answer.
Return an empty array for a document type that carries no signatures.

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
  closing_disclosure    → { closing_date, lender_name, loan_amount, cash_to_close,
                            total_closing_costs, owner_title_premium, lender_title_premium,
                            settlement_fee, transfer_taxes, recording_fees }
                          (dollar figures are the BORROWER-paid amounts as stated on the
                           document — page 2 sections B/C for title/settlement, section E
                           for recording_fees + transfer_taxes, section J for
                           total_closing_costs. Use null for ANY figure not explicitly
                           stated; never estimate or total lines yourself.)
  wire_instructions     → { receiving_institution, account_number_last_4, beneficiary_name }
  agency_disclosure     → { brokerage_name, agent_name, signed_at }
  commission_agreement  → { commission_percentage, commission_payer, expires_at }
  lender_letter         → { lender_name, letter_type, issued_at }
  earnest_money_receipt → { amount, depositor, escrow_holder, received_at }
  listing_agreement     → { property_address, city, state, zip_code, list_price,
                            list_date, expiration_date, commission_rate,
                            seller_name, listing_agent_name, brokerage_name }
                          (the SELLER-side agreement that puts the property on the
                           market. list_price is the agreed list price stated on the
                           agreement; commission_rate is the total listing-side rate
                           as a percentage number, not a string. Use null for any
                           figure not explicitly stated — never estimate.)
  seller_broker_agreement → { seller_name, brokerage_name, commission_rate, effective_date, expires_at }
  preliminary_closing_statement → { closing_date, seller_proceeds, total_seller_costs, title_company }
  insurance_binder      → { carrier, policy_number, coverage_amount, annual_premium,
                            effective_date, expiry, insured_name, property_address }
                          (the BUYER'S hazard / homeowner's policy binder or
                           declarations page — the evidence of coverage a lender
                           requires before funding. NOT a vendor's own certificate
                           of liability insurance, which is a different subject.
                           coverage_amount is the DWELLING coverage as a number,
                           effective_date and expiry are yyyy-mm-dd. Use null for
                           anything not explicitly stated — never estimate a
                           coverage figure or infer an expiry from the effective
                           date.)
  other                 → { document_type_guess }

Now classify this document content:

`

/**
 * TENANCY — AUDITED 2026-08-26, NOT A DEFECT. Recorded so it is not re-flagged.
 *
 * The shape ("tenant taken from a row read on the SERVICE client, keyed by a
 * caller-supplied id") was raised as a possible IDOR. It is not one, for two
 * reasons that must both stay true:
 *
 *   1. This module is `server-only` and takes NO brokerageId. The tenant is
 *      derived from the document's OWN row and is used only to (a) attribute the
 *      AI spend and (b) write back to THAT SAME ROW. It never carries one
 *      tenant's id onto another tenant's data — the direction §4 forbids.
 *   2. Its callers gate FIRST and hand it a document they have already proved
 *      access to. `lib/documents/upload-document.ts` scans the row it just
 *      inserted; the surfaces that reach that uploader
 *      (app/api/listings/[listingId]/upload-document/route.ts,
 *      app/api/offers/[offerId]/upload-document/route.ts) each resolve the parent
 *      on the session, compare `users.brokerage_id` to the parent's brokerage,
 *      403 on a mismatch, and then pass the PARENT ROW'S brokerage_id — never a
 *      body value. That is gate-then-service exactly as §4 prescribes.
 *
 * So: do not add a `brokerageId` parameter here. It would be a second, weaker
 * source of truth for a tenant the row already carries. If a NEW caller ever
 * accepts a documentId straight from a request, the gate belongs at that caller.
 */
export async function scanUploadedDocument(params: {
  documentId: string
  force?:     boolean
}): Promise<ScanResult> {
  const { documentId, force = false } = params
  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from("documents")
    // listing_id is selected because the listing gate below needs to know which
    // listing a signed agreement belongs to. It was omitted, so every consumer
    // downstream had to guess at the link that was sitting in the column.
    .select("id, brokerage_id, contact_id, transaction_id, listing_id, document_type, content, storage_url, classification, scanned_at, metadata")
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
      brokerageId: (doc as { brokerage_id?: string | null }).brokerage_id ?? null,
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

  // The signature verdict is its own fact, not an extracted field — the field
  // extraction ledger below shreds `extracted` into per-field rows, and a nested
  // verification object does not belong in that ledger. A malformed or missing
  // answer stays NULL: downstream, null must read as "not verified", never as signed.
  const signatureCompleteness =
    result.signature_completeness && typeof result.signature_completeness === "object"
      ? result.signature_completeness
      : null

  await supabase
    .from("documents")
    .update({
      classification,
      classification_confidence: confidence,
      summary,
      extracted_fields:          extracted,
      state_form_id:             stateFormId,
      signature_completeness:    signatureCompleteness,
      scanned_at:                new Date().toISOString(),
      scan_error:                null,
    })
    .eq("id", documentId)

  // Post-scan hook 0 — THE LISTING GATE. A fully-executed listing agreement
  // whose file has every required document is what takes a listing on. The gate
  // returns immediately for every other classification, so it is called
  // unconditionally rather than guarded here — one place owns the rule.
  try {
    const { runListingAgreementGate } = await import("./listing-agreement-gate")
    const verdict = await runListingAgreementGate(supabase as any, {
      documentId,
      brokerageId:     doc.brokerage_id as string,
      classification,
      extractedFields: extracted as Record<string, unknown>,
      signatureCompleteness: signatureCompleteness,
      contactId:   (doc as any).contact_id ?? null,
      listingId:   (doc as any).listing_id ?? null,
      // `uploaded_by` is the key the existing upload routes already write.
      agentUserId: ((doc as any).metadata?.uploaded_by as string | undefined) ?? null,
    })
    if (classification === "listing_agreement" && !verdict.passed) {
      // NOT an error — this is the normal state of a listing agreement that is
      // still missing a signature or a required form. It is recorded on the doc
      // so the agent can see exactly what is holding the listing back.
      await supabase
        .from("documents")
        .update({ metadata: { ...(doc.metadata as object ?? {}), listing_gate_blockers: verdict.blockers } })
        .eq("id", documentId)
    }
  } catch (err: any) {
    console.error("[scan] listing-agreement gate failed (non-fatal):", err?.message ?? err)
  }

  // Post-scan hook 0b — THE COMPLIANCE LOOP RE-ENTERS HERE (owner: "…to upload so
  // compliance can run again"). The document gate above records what THIS document
  // still lacks; the listing loop asks the ONE listing gate whether the whole file now
  // passes, walks the listing to COMING_SOON_PREP on a pass, and re-notifies the TC /
  // compliance officer / agent only if the blocker set CHANGED. Any upload on a listing
  // re-enters — the uploader does not have to know which document was the last one.
  if ((doc as any).listing_id) {
    try {
      const { runListingComplianceLoop } = await import("@/lib/listings/listing-compliance-loop")
      await runListingComplianceLoop(supabase as any, {
        brokerageId: doc.brokerage_id as string,
        listingId:   (doc as any).listing_id as string,
        trigger:     "document_uploaded",
        actorUserId: ((doc as any).metadata?.uploaded_by as string | undefined) ?? null,
      })
    } catch (err: any) {
      console.error("[scan] listing compliance loop failed (non-fatal):", err?.message ?? err)
    }
  }

  // Post-scan hook 0c — THE OFFER COMPLIANCE LOOP RE-ENTERS HERE (owner, 2026-09-06:
  // "…looped for offers turning into active transactions after pass and if fail,
  // same as the listing autonomous loop"). A document uploaded against an offer
  // (metadata.linked_offer_id — the same link the participant populator below
  // reads) re-asks the ONE offer gate; on a pass the transaction is created under
  // contract, on a fail the blockers are re-recorded and the roles are paged only
  // if the set changed. Idle for an offer that is not yet fully executed.
  const linkedOfferId = ((doc as any).metadata?.linked_offer_id as string | undefined) ?? null
  if (linkedOfferId) {
    try {
      const { runOfferComplianceLoop } = await import("@/lib/transactions/offer-compliance-loop")
      await runOfferComplianceLoop(supabase as any, {
        brokerageId: doc.brokerage_id as string,
        offerId:     linkedOfferId,
        trigger:     "document_uploaded",
        actorUserId: ((doc as any).metadata?.uploaded_by as string | undefined) ?? null,
      })
    } catch (err: any) {
      console.error("[scan] offer compliance loop failed (non-fatal):", err?.message ?? err)
    }
  }

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

  // Post-scan hook 5 — CLOSING-COST ACCURACY FLYWHEEL: a Closing Disclosure just
  // got scanned. If the deal is already CLOSED, grade the regional closing-cost
  // estimate against the CD's provenance-checked extracted figures (one
  // observation per deal; the recorder itself refuses non-closed deals, missing
  // states, and unmappable figures — honest at every exit). The stage-progression
  // CLOSED branch covers the deal-closes-after-scan ordering.
  if (classification === "closing_disclosure" && (doc as any).transaction_id) {
    try {
      const { recordClosingCostAccuracy } = await import("@/lib/offers/closing-cost-accuracy")
      await recordClosingCostAccuracy(supabase as any, {
        transactionId: (doc as any).transaction_id as string,
        brokerageId: doc.brokerage_id as string,
      })
    } catch (err: any) {
      console.error("[scan] closing-cost accuracy hook failed (non-fatal):", err?.message ?? err)
    }
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

/**
 * THE ONE LIST — imported, never re-typed.
 *
 * This array used to be hand-written here, 18 values, and it did NOT include
 * listing_agreement. Anything the model returned that was not in it was coerced
 * to "other" (see the classification fold above), so a signed listing agreement
 * could not be named by this scanner even when the model recognised it.
 *
 * ALL_DOCUMENT_CLASSIFICATIONS is derived from the label record in
 * lib/compliance/document-classifications.ts, which is the same vocabulary the
 * required-document presets and the compliance audit are written against. A
 * value added there is offered by the prompt and accepted by the fold with no
 * edit here — which is the point, because a hand-maintained copy next to a
 * consumer that has grown past it is how this drift got in.
 */
const CLASSIFICATIONS: DocumentClassification[] = ALL_DOCUMENT_CLASSIFICATIONS
