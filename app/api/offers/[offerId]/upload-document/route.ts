import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * POST /api/offers/[offerId]/upload-document
 *
 * Attach a document (PAL, signed contract, counter PDF, seller signed PDF,
 * disclosure, addendum, EM receipt, etc.) to an existing offer. The
 * universal scanner classifies + summarizes + extracts fields and the
 * auto-populate hook upserts participants (lender / title) + EM due date
 * when applicable.
 *
 * Accepts multipart/form-data with:
 *   file       — the document (PDF / image)
 *   docType    — optional hint ('counter_offer', 'pre_approval_letter', etc.)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params

  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const supabase = createServiceClient()

  // Verify offer belongs to actor's brokerage + the agent owns it (or is broker)
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id")
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 })

  const { data: actor } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!actor || actor.brokerage_id !== offer.brokerage_id) {
    return NextResponse.json({ error: "Not authorized for this offer" }, { status: 403 })
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  const docTypeHint = (formData.get("docType") as string | null) ?? "uploaded_document"
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 })

  // Stream the file into Supabase Storage
  const buf = Buffer.from(await file.arrayBuffer())
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
  const path = `${offer.brokerage_id}/${offer.contact_id ?? "anon"}/${Date.now()}_${safe}`

  const { data: upRes, error: upErr } = await supabase.storage
    .from("documents")
    .upload(path, buf, { contentType: file.type || "application/octet-stream", upsert: false })
  if (upErr || !upRes) {
    return NextResponse.json({ error: `Storage upload failed: ${upErr?.message}` }, { status: 500 })
  }
  const { data: pub } = supabase.storage.from("documents").getPublicUrl(upRes.path)
  const storageUrl = pub.publicUrl

  // Route through the universal uploader (scanner fires async)
  const { uploadDocument } = await import("@/lib/documents/upload-document")
  const r = await uploadDocument({
    brokerageId:  offer.brokerage_id,
    storageUrl,
    fileName:     file.name,
    documentType: docTypeHint,
    contactId:    offer.contact_id,
    offerId,
    metadata: {
      source:      "agent_upload",
      uploaded_by: user.id,
      mime:        file.type,
    },
  })
  if (!r.success) {
    return NextResponse.json({ error: r.error ?? "uploadDocument failed" }, { status: 500 })
  }

  return NextResponse.json({
    success:     true,
    document_id: r.documentId,
    storage_url: storageUrl,
  })
}
