/**
 * Inbound email webhook — provider-aware.
 *
 * Detects which email provider (Postmark / SendGrid / Mailgun / Resend) is
 * hitting the webhook by inspecting the signature header, verifies with that
 * provider's stored secret, and parses the body using the provider-specific
 * adapter in lib/inbound-mail/providers.ts.
 *
 * Whichever provider the brokerage configured in Settings → Integrations for
 * outbound email is also what they point inbound at. We don't assume a
 * specific provider.
 *
 * Required env vars (set the one matching your provider; unknown signatures
 * are rejected 401):
 *   POSTMARK_INBOUND_WEBHOOK_SECRET       (HMAC-SHA256 base64)
 *   SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY   (PEM-encoded ECDSA public key)
 *   MAILGUN_WEBHOOK_SIGNING_KEY           (HMAC-SHA256 hex)
 *   RESEND_WEBHOOK_SECRET                 (Svix-style 'whsec_...')
 */

import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { detectInboundProvider, parseInbound, verifyInbound } from "@/lib/inbound-mail/providers"

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const supabase = createServiceClient()

  // 1) Detect the provider from headers
  const provider = detectInboundProvider(request.headers)
  if (!provider) {
    return NextResponse.json({ error: "No recognized inbound-email provider signature header present" }, { status: 401 })
  }

  // 2) Verify the provider's signature with the matching env-var secret
  if (!verifyInbound(provider, rawBody, request.headers)) {
    return NextResponse.json({ error: `Invalid ${provider} signature` }, { status: 401 })
  }

  // 3) Parse the provider-specific body shape into our normalized email
  const parsed = parseInbound(provider, rawBody)
  if (!parsed) {
    return NextResponse.json({ error: `Could not parse ${provider} body` }, { status: 400 })
  }
  if (parsed.attachments.length === 0) {
    return NextResponse.json({ ok: true, provider, action: "ignored", reason: "no attachments" })
  }

  // 4) Identify the brokerage + buyer contact. Strategy:
  //    a) FROM matches a contacts row → use their brokerage_id
  //    b) Otherwise FROM matches a users (agent) row → use their brokerage_id
  //       + try to resolve the contact via TO
  let contactId:   string | null = null
  let brokerageId: string | null = null
  let offerId:     string | null = null

  if (parsed.fromEmail) {
    const { data: c } = await supabase
      .from("contacts")
      .select("id, brokerage_id")
      .eq("email", parsed.fromEmail)
      .maybeSingle()
    if (c) {
      contactId   = c.id as string
      brokerageId = c.brokerage_id as string
    }
  }
  if (!contactId && parsed.fromEmail) {
    const { data: agentUser } = await supabase
      .from("users")
      .select("id, brokerage_id")
      .eq("email", parsed.fromEmail)
      .maybeSingle()
    if (agentUser) {
      brokerageId = agentUser.brokerage_id as string
      if (parsed.toEmail) {
        const { data: c } = await supabase
          .from("contacts")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("email", parsed.toEmail)
          .maybeSingle()
        if (c) contactId = c.id as string
      }
    }
  }
  if (!contactId || !brokerageId) {
    return NextResponse.json({
      ok: true, provider, action: "ignored", reason: "no contact match",
      fromEmail: parsed.fromEmail, toEmail: parsed.toEmail,
    })
  }

  // 5) Pre-link to the contact's most-recent open offer when no ref:offer
  //    in the subject. Lets the scanner's post-scan hooks populate
  //    participants + EM due fields correctly.
  const subjMatch = parsed.subject.match(/ref:offer:([0-9a-f-]{36})/i)
  if (subjMatch) {
    offerId = subjMatch[1]
  } else {
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

  // 6) Upload each attachment through the universal helper. Scanner classifies
  //    each automatically (counter_offer / signed_contract / pre_approval_letter /
  //    disclosure / earnest_money_receipt / etc.) — provider-agnostic from here on.
  const { uploadDocument } = await import("@/lib/documents/upload-document")
  let uploaded = 0
  const uploadedDocIds: string[] = []

  for (const att of parsed.attachments) {
    if (!att.contentB64) continue
    const buf = Buffer.from(att.contentB64, "base64")
    const safe = att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    const path = `${brokerageId}/${contactId}/${Date.now()}_${safe}`
    const { data: up, error: upErr } = await supabase.storage
      .from("documents")
      .upload(path, buf, { contentType: att.mime, upsert: false })
    let storageUrl: string | null = null
    if (!upErr && up) {
      const { data: pub } = supabase.storage.from("documents").getPublicUrl(up.path)
      storageUrl = pub.publicUrl ?? null
    }
    if (!storageUrl) {
      console.warn("[inbound-mail] storage upload failed:", upErr?.message)
      continue
    }

    const r = await uploadDocument({
      brokerageId,
      storageUrl,
      fileName:     att.fileName,
      documentType: "uploaded_document",
      contactId,
      offerId,
      metadata: {
        source:      "inbound_email",
        provider,
        from_email:  parsed.fromEmail,
        to_email:    parsed.toEmail,
        subject:     parsed.subject,
        mime:        att.mime,
      },
    })
    if (r.success) {
      uploaded++
      if (r.documentId) uploadedDocIds.push(r.documentId)
    }
  }

  return NextResponse.json({
    ok: true,
    provider,
    contact_id:           contactId,
    brokerage_id:         brokerageId,
    offer_id:             offerId,
    attachments_uploaded: uploaded,
    document_ids:         uploadedDocIds,
  })
}
