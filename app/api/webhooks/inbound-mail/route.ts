/**
 * Inbound email webhook — Postmark + SendGrid compatible.
 *
 * Real-world flow:
 *   - External listing agent emails your buyer's agent the seller-signed
 *     counter PDF (or signed contract, or lender clear-to-close letter).
 *   - The agent's email forwards to a brokerage-routing address that's
 *     configured at Postmark / SendGrid to POST inbound mail to this
 *     webhook with the raw email + attachments base64'd.
 *   - We verify the provider's signature, extract attachments + sender
 *     address, identify the buyer contact in our system (by sender email),
 *     and route every attachment through uploadDocument — which fires the
 *     universal scanner to classify + summarize + extract fields.
 *
 * Provider signature schemes:
 *   - Postmark: X-Postmark-Webhook-Signature: <base64 of HMAC-SHA256(body, secret)>
 *   - SendGrid: X-Twilio-Email-Event-Webhook-Signature: ECDSA pubkey verify
 *   We start with Postmark's HMAC pattern; SendGrid path is a stub that
 *   activates when SENDGRID_INBOUND_WEBHOOK_SECRET is set.
 *
 * Returns 200 with a structured result; non-fatal failures don't bounce the
 * inbound message (postmark would retry forever).
 */

import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"

function verifyPostmarkSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.POSTMARK_INBOUND_WEBHOOK_SECRET
  if (!secret) return false
  if (!signatureHeader) return false
  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("base64")
  try {
    const a = Buffer.from(computed)
    const b = Buffer.from(signatureHeader)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const supabase = createServiceClient()

  // Try Postmark first. Add SendGrid later when SENDGRID_INBOUND_WEBHOOK_SECRET ships.
  const postmarkSig = request.headers.get("x-postmark-webhook-signature")
  if (postmarkSig) {
    if (!verifyPostmarkSignature(rawBody, postmarkSig)) {
      return NextResponse.json({ error: "Invalid Postmark signature" }, { status: 401 })
    }
  } else {
    // No signature at all — refuse. (In dev, set the env vars.)
    return NextResponse.json({ error: "Missing signature header" }, { status: 401 })
  }

  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Postmark fields. SendGrid fields differ; map them when needed.
  const fromEmail   = (body.FromFull?.Email ?? body.From ?? "").toString().toLowerCase().trim()
  const toEmail     = (body.ToFull?.[0]?.Email ?? body.To ?? "").toString().toLowerCase().trim()
  const subject     = (body.Subject ?? "").toString().trim()
  const attachments = Array.isArray(body.Attachments) ? body.Attachments : []
  if (attachments.length === 0) {
    return NextResponse.json({ ok: true, action: "ignored", reason: "no attachments" })
  }

  // Identify the contact this email is FROM (or TO when buyer forwards in).
  // Strategy: match sender against contacts.email or users.email (when an
  // agent forwards an inbound).
  let contactId: string | null = null
  let brokerageId: string | null = null
  let offerId:   string | null = null

  // Match by FROM = contact email
  if (fromEmail) {
    const { data: c } = await supabase
      .from("contacts")
      .select("id, brokerage_id")
      .eq("email", fromEmail)
      .maybeSingle()
    if (c) {
      contactId = c.id as string
      brokerageId = c.brokerage_id as string
    }
  }

  // If sender is an agent (forwarded inbound), try TO = contact email or
  // resolve the contact via the matching open offer + agent.
  if (!contactId) {
    const { data: agentUser } = await supabase
      .from("users")
      .select("id, brokerage_id")
      .eq("email", fromEmail)
      .maybeSingle()
    if (agentUser) {
      brokerageId = agentUser.brokerage_id as string
      // Try TO = contact email
      if (toEmail) {
        const { data: c } = await supabase
          .from("contacts")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("email", toEmail)
          .maybeSingle()
        if (c) contactId = c.id as string
      }
    }
  }

  if (!contactId || !brokerageId) {
    return NextResponse.json({ ok: true, action: "ignored", reason: "no contact match", fromEmail, toEmail })
  }

  // When the subject mentions an offer id (e.g. ref:offer:UUID) or property
  // address that matches an open offer, pre-link to that offer so the
  // scanner's post-scan hook can populate participants correctly.
  const subjMatch = subject.match(/ref:offer:([0-9a-f-]{36})/i)
  if (subjMatch) offerId = subjMatch[1]
  if (!offerId) {
    // Find this contact's most-recent open offer
    const { data: openOffer } = await supabase
      .from("offers")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", contactId)
      .in("status", ["submitted","accepted","countered"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    offerId = (openOffer?.id as string | null) ?? null
  }

  // Upload each attachment via the universal helper. The scanner classifies
  // each automatically (counter_offer / signed_contract / pre_approval_letter /
  // disclosure / earnest_money_receipt / etc.).
  const { uploadDocument } = await import("@/lib/documents/upload-document")
  let uploaded = 0
  const uploadedDocIds: string[] = []

  for (const att of attachments) {
    const name        = (att.Name        ?? "attachment.pdf").toString()
    const contentB64  = (att.Content     ?? "").toString()
    const contentType = (att.ContentType ?? "application/pdf").toString()
    if (!contentB64) continue

    // Postmark attachments are base64-inline; we need to store the bytes
    // in Supabase storage and pass the public URL to uploadDocument. Use a
    // dedicated bucket 'inbound-mail-attachments' that the broker can
    // browse via Supabase studio.
    const buf = Buffer.from(contentB64, "base64")
    const path = `${brokerageId}/${contactId}/${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`
    const { data: uploadRes, error: uploadErr } = await supabase.storage
      .from("documents")
      .upload(path, buf, { contentType, upsert: false })

    let storageUrl: string | null = null
    if (!uploadErr && uploadRes) {
      const { data: pub } = supabase.storage.from("documents").getPublicUrl(uploadRes.path)
      storageUrl = pub.publicUrl ?? null
    }
    if (!storageUrl) {
      console.warn("[inbound-mail] storage upload failed:", uploadErr?.message)
      continue
    }

    const r = await uploadDocument({
      brokerageId,
      storageUrl,
      fileName:     name,
      documentType: "uploaded_document",
      contactId,
      offerId,
      metadata: {
        source:        "inbound_email",
        from_email:    fromEmail,
        to_email:      toEmail,
        subject,
        mime:          contentType,
      },
    })
    if (r.success) {
      uploaded++
      if (r.documentId) uploadedDocIds.push(r.documentId)
    }
  }

  return NextResponse.json({
    ok: true,
    contact_id: contactId,
    brokerage_id: brokerageId,
    offer_id: offerId,
    attachments_uploaded: uploaded,
    document_ids: uploadedDocIds,
  })
}
