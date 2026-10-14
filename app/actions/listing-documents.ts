"use server"
/**
 * app/actions/listing-documents.ts
 *
 * What is actually in this listing's file, and what is still missing.
 *
 * The upload itself goes through POST /api/listings/[listingId]/upload-document
 * (multipart — a server action would have to base64 the whole PDF). This module
 * is the READ side the panel renders: the documents on file with what the
 * scanner made of each one, plus the same required-document audit the listing
 * gate runs, so the agent sees the identical verdict the gate will reach rather
 * than a second opinion computed a different way.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { documentClassificationLabel } from "@/lib/compliance/document-classifications"

export interface ListingDocumentRow {
  id: string
  fileName: string
  classification: string | null
  classificationLabel: string
  confidence: string | null
  summary: string | null
  storageUrl: string | null
  scannedAt: string | null
  scanError: string | null
  /** Per-role signature/initial completeness — null means NOT VERIFIED, not signed. */
  signatureCompleteness: unknown
  /** Why this document has not satisfied the listing gate, when it is an agreement. */
  gateBlockers: string[]
  createdAt: string | null
}

export interface ListingDocumentsView {
  success: boolean
  error?: string
  documents: ListingDocumentRow[]
  /** Required seller-side documents still missing, as human labels. */
  missingBlocking: string[]
  missingWarning: string[]
  presentCount: number
  requiredTotal: number
}

const EMPTY: ListingDocumentsView = {
  success: false, documents: [], missingBlocking: [], missingWarning: [],
  presentCount: 0, requiredTotal: 0,
}

export async function getListingDocumentsAction(listingId: string): Promise<ListingDocumentsView> {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return { ...EMPTY, error: "Unauthorized" }

  const supabase = createServiceClient()

  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, seller_contact_id, state")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { ...EMPTY, error: "Listing not found" }

  const { data: actor } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!actor?.brokerage_id || actor.brokerage_id !== listing.brokerage_id) {
    return { ...EMPTY, error: "Not authorized for this listing" }
  }

  // Documents filed against the listing, or against its seller. Both, because
  // a seller-side form can legitimately arrive on either anchor and the audit
  // counts both — showing only one would tell the agent something is missing
  // when the gate can already see it.
  const { data: rows, error: rowsErr } = await supabase
    .from("documents")
    .select("id, metadata, classification, classification_confidence, summary, storage_url, scanned_at, scan_error, signature_completeness, created_at, listing_id, contact_id")
    .eq("brokerage_id", listing.brokerage_id)
    .or(
      listing.seller_contact_id
        ? `listing_id.eq.${listingId},contact_id.eq.${listing.seller_contact_id}`
        : `listing_id.eq.${listingId}`,
    )
    .order("created_at", { ascending: false })

  if (rowsErr) return { ...EMPTY, error: rowsErr.message }

  const documents: ListingDocumentRow[] = (rows ?? []).map((d: any) => ({
    id: d.id,
    fileName: (d.metadata?.file_name as string | null) ?? "Document",
    classification: d.classification ?? null,
    classificationLabel: documentClassificationLabel(d.classification),
    confidence: d.classification_confidence ?? null,
    summary: d.summary ?? null,
    storageUrl: d.storage_url ?? null,
    scannedAt: d.scanned_at ?? null,
    scanError: d.scan_error ?? null,
    signatureCompleteness: d.signature_completeness ?? null,
    gateBlockers: Array.isArray(d.metadata?.listing_gate_blockers)
      ? (d.metadata.listing_gate_blockers as string[])
      : [],
    createdAt: d.created_at ?? null,
  }))

  // The SAME audit the gate runs — one verdict, not two.
  const { auditListingDocuments } = await import("@/lib/compliance/required-documents")
  const audit = await auditListingDocuments(supabase as any, {
    brokerageId:     listing.brokerage_id,
    sellerContactId: listing.seller_contact_id,
    listingId,
    stateCode:       (listing.state as string | null) ?? null,
  })

  return {
    success: true,
    documents,
    missingBlocking: audit.missing_blocking.map(documentClassificationLabel),
    missingWarning:  audit.missing_warning.map(documentClassificationLabel),
    presentCount:    audit.present.length,
    requiredTotal:   audit.required_total,
  }
}
