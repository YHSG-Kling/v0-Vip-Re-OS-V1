import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { extractOfferFromPdf } from "@/lib/offers/offer-extractor"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

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

  // Get public URL for the AI extractor
  const { data: { publicUrl } } = serviceClient.storage
    .from("offer-documents")
    .getPublicUrl(storageData.path)

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
      created_at:           new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .select("id")
    .single()

  if (insertError || !offer) {
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
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
  })
}
