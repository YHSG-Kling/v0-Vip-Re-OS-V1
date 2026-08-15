/**
 * lib/documents/upload-document.ts
 *
 * Universal upload entry point. Every time a file lands in the deal file
 * (seller-signed counter, seller-signed contract, PAL, ID, POF, inspection
 * report, etc.) it goes through this helper so it gets:
 *   - a row in `documents` (linked to whatever entities apply: contact,
 *     offer, listing, transaction)
 *   - a background scan that classifies + summarizes + extracts fields
 *     (via lib/documents/scan-uploaded-document.ts)
 *
 * Per agent direction: "all documents that are uploaded need to be scanned
 * and if it isnt something we need to fill in either the record or
 * contract realatied, should be organized with summary of what it is."
 *
 * The scan runs fire-and-forget. Callers don't block on it — by the time
 * the agent looks at the deal file, the row is there with the classification
 * + summary populated (or scan_error stamped if the AI couldn't classify).
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface UploadDocumentParams {
  brokerageId:   string
  /** Storage URL (Supabase Storage / Vercel Blob / vendor URL). */
  storageUrl:    string
  /** Display name shown to the agent. */
  fileName?:     string
  /** Free-form initial doc-type hint; the scanner refines it into a
   *  classification taxonomy value. Examples: 'uploaded_document',
   *  'counter_pdf', 'pal_upload', 'signed_contract'. */
  documentType?: string
  /** Optional links — populate whichever are known. The scanner uses these
   *  to decide which deal-file bucket the document belongs to. */
  contactId?:     string | null
  offerId?:       string | null
  listingId?:     string | null
  transactionId?: string | null
  /** Optional inline text content (used by the scanner when no PDF OCR is
   *  available yet). */
  content?:       string
  /** Optional metadata blob. */
  metadata?:      Record<string, unknown>
  /** Set to false to skip the scanner (rare — e.g. when the caller already
   *  knows the classification and doesn't want AI cost). Default true. */
  scan?:          boolean
}

export interface UploadDocumentResult {
  success:     boolean
  documentId?: string
  error?:      string
}

export async function uploadDocument(
  params: UploadDocumentParams,
): Promise<UploadDocumentResult> {
  const {
    brokerageId, storageUrl, fileName, documentType, contactId, offerId,
    listingId, transactionId, content, metadata, scan = true,
  } = params

  const supabase = createServiceClient()

  const baseMetadata = {
    file_name:        fileName ?? null,
    upload_source:    "agent_upload",
    linked_offer_id:  offerId ?? null,
    ...(metadata ?? {}),
  }

  const { data: doc, error } = await supabase
    .from("documents")
    .insert({
      brokerage_id:   brokerageId,
      contact_id:     contactId     ?? null,
      listing_id:     listingId     ?? null,
      transaction_id: transactionId ?? null,
      document_type:  documentType  ?? "uploaded_document",
      status:         "complete",      // file is in hand — not draft
      storage_url:    storageUrl,
      content:        content        ?? null,
      metadata:       baseMetadata,
    })
    .select("id")
    .maybeSingle()

  if (error || !doc) {
    return { success: false, error: error?.message ?? "Could not insert document row" }
  }

  // Fire-and-forget scan. Failures are stamped on the doc row's scan_error
  // column so the agent surface can show "couldn't classify — review manually."
  if (scan) {
    const { scanUploadedDocument } = await import("./scan-uploaded-document")
    void scanUploadedDocument({ documentId: doc.id as string }).catch(err => {
      console.error("[upload-document] scan threw:", err?.message ?? err)
    })
  }

  return { success: true, documentId: doc.id as string }
}
