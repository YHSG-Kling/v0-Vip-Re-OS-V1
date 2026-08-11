import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { extractOfferFromPdf } from "@/lib/offers/offer-extractor"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { uploadDocument } from "@/lib/documents/upload-document"
import { INBOUND_CONTRACT_DOCUMENT_TYPE } from "@/lib/inbound-mail/offer-detect"
import { linkInboundDocumentsToOffer } from "@/lib/inbound-mail/offer-intake"

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  // Auth check
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Resolve agent ID from auth user
  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 403 })
  }

  // Get brokerage_id for the authenticated agent
  const { data: agentRow } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .single()

  const brokerageId = agentRow?.brokerage_id
  if (!brokerageId) {
    return NextResponse.json({ error: "Agent brokerage not found" }, { status: 400 })
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  const listingId = formData.get("listing_id") as string | null
  const contactId = formData.get("contact_id") as string | null

  if (!file || !listingId || !contactId) {
    return NextResponse.json(
      { error: "file, listing_id, and contact_id are required" },
      { status: 400 }
    )
  }

  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 415 })
  }

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File exceeds 20 MB limit" }, { status: 413 })
  }

  // ── 1. Upload to Supabase Storage ─────────────────────────────────────────
  const serviceClient = createServiceClient()
  const fileName = `${brokerageId}/${listingId}/${Date.now()}-${file.name.replace(/\s+/g, "_")}`
  const fileBuffer = await file.arrayBuffer()

  const { data: storageData, error: storageError } = await serviceClient.storage
    .from("offer-documents")
    .upload(fileName, fileBuffer, {
      contentType: "application/pdf",
      upsert: false,
    })

  if (storageError) {
    return NextResponse.json({ error: storageError.message }, { status: 500 })
  }

  // Signed URL for the AI extractor — offer-documents is a PRIVATE bucket, so a
  // public URL would 403 and the extraction would silently fail (m278).
  const { signedDocUrl } = await import("@/lib/storage/signed-doc-url")
  const publicUrl = await signedDocUrl(serviceClient, "offer-documents", storageData.path)

  // ── 2. INSERT offers row with ai_extraction_status='pending' ──────────────
  const { data: offer, error: insertError } = await supabase
    .from("offers")
    .insert({
      listing_id:           listingId,
      contact_id:           contactId,
      brokerage_id:         brokerageId,
      agent_id:             agentId,
      uploaded_by:          agentId,
      offer_price:          0,               // placeholder until extraction completes
      offer_document_url:   publicUrl,
      offer_document_name:  file.name,
      ai_extraction_status: "pending",
      offer_type:           "standard",
      current_round:        1,
      status:               "submitted",
      submitted_at:         new Date().toISOString(),
      // THE ORIGIN, RECORDED. Same column and same literal the email-intake lane
      // writes. `manual` already means "paperwork our engine did not produce"
      // (live CHECK: portal_upload|dotloop|docusign|skyslope|authentisign|
      // in_app|manual), so this needs no new column — it was simply left NULL
      // here, which made an outside offer indistinguishable from one of ours.
      form_source:          "manual",
      created_at:           new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .select("id")
    .single()

  if (insertError || !offer) {
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
  }

  // ── 2b. FILE THE CONTRACT IN THE DOCUMENT LEDGER ─────────────────────────
  //
  // This route stored the PDF and set `offers.offer_document_url` and stopped —
  // it created NO `documents` row. `auditOfferDocuments` counts ONLY `documents`
  // keyed by `metadata.linked_offer_id`, so the executed contract an agent had
  // just uploaded by hand could not be read or counted toward the transaction
  // paperwork, which is the owner's obligation 4 stated directly. It is also a
  // precondition of the buyer-signature attestation, which refuses without a
  // document on file — so without this, attesting an outside offer uploaded here
  // was impossible.
  //
  // The SAME two helpers the email-intake lane uses, deliberately: one filing
  // convention, not a second one that drifts. NOT `document_type:'offer'` —
  // that is the staged-packet key the completeness scanner searches, and an
  // inbound PDF has no `filledPacket`, so filing it there would make the scan
  // FAULT and refuse every offer that came in this way.
  const filed = await uploadDocument({
    brokerageId,
    storageUrl:   publicUrl,
    fileName:     file.name,
    documentType: INBOUND_CONTRACT_DOCUMENT_TYPE,
    contactId,
    offerId:      offer.id,
    listingId,
    metadata: { upload_source: "agent_upload_outside_offer", linked_offer_id: offer.id },
  })
  if (!filed.success) {
    // Not fatal to the upload — the offer and its PDF exist — but it must not be
    // silent: an unfiled contract cannot be counted, and the agent would later
    // hit an attestation refusal with no way to understand why.
    console.error(`[offers/upload] offer ${offer.id}: PDF stored but NOT filed in the document ledger:`, filed.error)
  }

  // ── 2c. COMPLETE THE INBOUND LINK ────────────────────────────────────────
  //
  // THIS is the surface the `offer_intake_review` notification asks for: "an
  // email that looks like an offer for <address> arrived, N documents are
  // already filed to the listing's deal file — confirm the buyer to create the
  // offer." Confirming the buyer means exactly this route. The documents that
  // email filed carry `metadata.awaiting_offer_link` and a `listing_id` because
  // no offer row existed yet, and NOTHING ever finished the link, so they
  // counted toward the listing forever and never toward the offer whose
  // compliance gate needs them.
  //
  // The uploaded file name is passed as the hint because the agent is uploading
  // the very PDF that arrived by email; when several outside agents are waiting
  // on the same listing that is what tells their paperwork apart. If nothing
  // can tell them apart, NOTHING is linked — a mis-link counts another deal's
  // paperwork toward this one and passes a gate with it.
  const inboundLink = await linkInboundDocumentsToOffer({
    brokerageId,
    listingId,
    offerId:   offer.id,
    contactId,
    fileName:  file.name,
  })
  if (inboundLink.errors.length > 0) {
    console.error(`[offers/upload] offer ${offer.id}: inbound link errors:`, inboundLink.errors.join(" | "))
  }
  // An ambiguity is not an error and must not be silent either: the emailed
  // paperwork is still sitting on the listing, and the agent is the only one
  // who can say whose it is. Told on the same notification rail the intake used
  // to open the loop, and it NAMES what to do.
  if (inboundLink.plan.ambiguous) {
    await serviceClient.from("notifications").insert({
      user_id:      user.id,
      brokerage_id: brokerageId,
      type:         "offer_intake_review",
      title:        "Emailed offer documents were NOT attached to this offer",
      body:         `${inboundLink.plan.senders.length} different senders (${inboundLink.plan.senders.join(", ")}) have offer paperwork emailed for this listing and still waiting for an offer, so none of it was attached — attaching the wrong sender's contract would count another buyer's paperwork toward this deal. `
                  + `Upload the PDF that came from this buyer's agent (same file name as the email attachment) and it will be matched, or file their documents from the deal file.`,
      entity_type:  "offer",
      entity_id:    offer.id,
      priority:     "high",
      is_read:      false,
    })
  }

  // lifecycle_events + OFFER_UPLOADED kernel event (non-blocking)
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "offer",
    entity_id:     offer.id,
    event_type:    KernelEvent.OFFER_UPLOADED,
    actor_user_id: user.id,
    metadata: {
      listing_id:        listingId,
      offer_document_url: publicUrl,
    },
  })

  await processKernelEvent({
    event:      KernelEvent.OFFER_UPLOADED,
    brokerageId,
    entityType: "offer",
    entityId:   offer.id,
  }).catch(() => {})

  // ── 3. Kick off AI extraction (fire-and-forget — client polls status) ─────
  extractOfferFromPdf({
    offerId:    offer.id,
    brokerageId,
    pdfUrl:     publicUrl,
    listingId,
  }).catch(console.error)

  return NextResponse.json({
    success: true,
    offer_id: offer.id,
    document_url: publicUrl,
    extraction_status: "pending",
    // What became of the paperwork that arrived by email for this listing.
    inbound_documents_linked: inboundLink.linkedDocumentIds.length,
    inbound_link_reason:      inboundLink.plan.reason,
    inbound_link_ambiguous:   inboundLink.plan.ambiguous,
    inbound_link_senders:     inboundLink.plan.senders,
  })
}
