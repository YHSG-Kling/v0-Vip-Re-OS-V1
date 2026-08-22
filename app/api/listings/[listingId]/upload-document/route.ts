import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { issueBucketObjectUrl } from "@/lib/storage/document-buckets"
import { removeOrRecordOrphan } from "@/lib/storage/put-and-sign"

/**
 * POST /api/listings/[listingId]/upload-document
 *
 * THE AGENT'S DOOR FOR A COMPLETED DOCUMENT.
 *
 * A listing opens as a draft and is taken on only once the listing agreement is
 * signed and compliance has reviewed every required document, initial and
 * signature. That gate runs off documents the scanner has classified — so
 * somebody has to be able to put the signed paperwork IN.
 *
 * Until now nobody could. The only upload surface in the product was the client
 * portal's dialog, which writes `client_documents` and is rendered for the
 * SELLER — while the audit that gates the listing reads `documents`. The agent
 * who runs the listing appointment and walks out holding the signed agreement
 * had nowhere to file it, so the draft could sit forever.
 *
 * This is the listing-scoped sibling of /api/offers/[offerId]/upload-document —
 * same storage bucket, same universal uploader, same scanner. The only
 * difference is what the document is filed against: the listing, and the seller
 * on it, which is exactly what auditListingDocuments matches on.
 *
 * Accepts multipart/form-data with:
 *   file    — the document (PDF / image)
 *   docType — optional hint ('listing_agreement', 'disclosure', …). The scanner
 *             classifies for real; the hint only helps when OCR comes back thin.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ listingId: string }> },
) {
  const { listingId } = await params

  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const supabase = createServiceClient()

  // The listing must belong to the caller's brokerage BEFORE anything is stored
  // against it — this endpoint files legal paperwork onto a deal.
  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, seller_contact_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 })

  const { data: actor } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!actor?.brokerage_id || actor.brokerage_id !== listing.brokerage_id) {
    return NextResponse.json({ error: "Not authorized for this listing" }, { status: 403 })
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  const docTypeHint = (formData.get("docType") as string | null) ?? "uploaded_document"
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 })

  const buf = Buffer.from(await file.arrayBuffer())
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
  const path = `${listing.brokerage_id}/listings/${listingId}/${Date.now()}_${safe}`

  const { data: upRes, error: upErr } = await supabase.storage
    .from("documents")
    .upload(path, buf, { contentType: file.type || "application/octet-stream", upsert: false })
  if (upErr || !upRes) {
    return NextResponse.json({ error: `Storage upload failed: ${upErr?.message}` }, { status: 500 })
  }
  // A signed listing agreement and its disclosures — the legal transaction
  // record. getPublicUrl handed back a permanent, unauthenticated,
  // never-expiring link and this route PERSISTS it. One issuer, fail closed.
  // NOTE: this changes only the URL STRING stored on the row. What the document
  // is filed against, how the scanner classifies it, and the listing/compliance
  // gate that reads those rows are untouched.
  const issued = await issueBucketObjectUrl(supabase as never, { bucket: "documents", objectPath: upRes.path })
  if (!issued.ok) {
    await removeOrRecordOrphan(supabase as never, {
      bucket: "documents", objectPath: upRes.path,
      reason: "listing_document_sign_failed", detail: issued.reason,
      brokerageId: listing.brokerage_id,
    })
    return NextResponse.json({ error: issued.reason }, { status: 502 })
  }

  // Route through the universal uploader — the scanner fires async, classifies
  // against the canonical taxonomy, records per-role signature completeness and
  // runs the listing gate. Filing against BOTH the listing and its seller is
  // what lets auditListingDocuments see this document from either direction.
  const { uploadDocument } = await import("@/lib/documents/upload-document")
  const r = await uploadDocument({
    brokerageId:  listing.brokerage_id,
    storageUrl:   issued.url,
    fileName:     file.name,
    documentType: docTypeHint,
    listingId,
    contactId:    listing.seller_contact_id,
    metadata: {
      source:      "agent_upload",
      uploaded_by: user.id,
      mime:        file.type,
    },
  })
  if (!r.success) {
    return NextResponse.json({ error: r.error ?? "uploadDocument failed" }, { status: 500 })
  }

  return NextResponse.json({ success: true, documentId: r.documentId })
}
