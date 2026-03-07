"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"

export async function uploadBusinessCard(params: {
  imageBase64: string
  mimeType: "image/jpeg" | "image/png" | "image/webp"
  agentId: string
  brokerageId: string
}): Promise<{ scanId: string; contactId: string | null; viable: boolean }> {
  const supabase = createServiceClient()
  const scanId = crypto.randomUUID()
  const now = new Date().toISOString()

  // 1) Upload image to Supabase storage
  const buffer = Buffer.from(params.imageBase64, "base64")
  const path = `${params.brokerageId}/${scanId}.jpg`
  await supabase.storage
    .from("business-cards")
    .upload(path, buffer, { contentType: params.mimeType, upsert: true })
  const { data: pub } = supabase.storage.from("business-cards").getPublicUrl(path)
  const raw_image_url = pub.publicUrl

  // 2) Call Claude Vision — JSON extraction only
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: params.mimeType,
                data: params.imageBase64,
              },
            },
            {
              type: "text",
              text: "Return ONLY a JSON object with keys: first_name,last_name,email,phone,company,title,address,website. No other text.",
            },
          ],
        },
      ],
    }),
  })

  const aiData = await response.json() as {
    content?: Array<{ text?: string }>
  }

  let extracted: Record<string, string> = {}
  try {
    extracted = JSON.parse(aiData.content?.[0]?.text ?? "{}") as Record<string, string>
  } catch {
    extracted = {}
  }

  // 3) Confidence score = filled fields / 8
  const keys = ["first_name", "last_name", "email", "phone", "company", "title", "address", "website"]
  const filled = keys.filter((k) => (extracted[k] ?? "").toString().trim()).length
  const confidence_score = filled / 8

  // 4) Viability gate
  const hasName = !!((extracted.first_name ?? "").trim() || (extracted.last_name ?? "").trim())
  const hasContact = !!((extracted.email ?? "").trim() || (extracted.phone ?? "").trim())
  const viable = hasName && hasContact

  // 5) Always insert scan row (audit trail regardless of viability)
  const { data: scan } = await supabase
    .from("business_card_scans")
    .insert({
      id: scanId,
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      raw_image_url,
      extracted_data: extracted,
      confidence_score,
      review_status: viable ? "approved" : "rejected",
      reviewed_by: null,
      reviewed_at: now,
    })
    .select("id")
    .single()

  await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "business_card",
    entity_id: scan!.id,
    event_type: KernelEvent.BUSINESS_CARD_UPLOADED,
    metadata: { confidence: confidence_score, viable },
  })

  if (!viable) {
    // Notify agent of failed extraction
    const { data: agentRow } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", params.agentId)
      .single()

    if (agentRow?.user_id) {
      await supabase.from("notifications").insert({
        user_id: agentRow.user_id,
        brokerage_id: params.brokerageId,
        type: "business_card_scan",
        title: "Business card scan could not extract contact info",
        body: "Missing name or contact method. Try a clearer photo.",
        entity_type: "business_card",
        entity_id: scan!.id,
        priority: "low",
        channel: "in_app",
        is_read: false,
      })
    }

    return { scanId: scan!.id, contactId: null, viable: false }
  }

  // 6) Viable → captureContact (tcpa_consent=false always for business cards)
  const { contactId } = await captureContact({
    brokerageId: params.brokerageId,
    agentUserId: null,
    source: "business_card",
    first_name: extracted.first_name ?? null,
    last_name: extracted.last_name ?? null,
    email: extracted.email ?? null,
    phone: extracted.phone ?? null,
    tcpa_consent: false,
    tcpa_consent_date: null,
  })

  // 7) Link scan to contact
  await supabase
    .from("business_card_scans")
    .update({ contact_id: contactId })
    .eq("id", scan!.id)

  await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "contact",
    entity_id: contactId,
    event_type: KernelEvent.BUSINESS_CARD_APPROVED,
    metadata: { scanId: scan!.id, autoApproved: true },
  })

  await processKernelEvent({
    event: KernelEvent.BUSINESS_CARD_APPROVED,
    brokerageId: params.brokerageId,
    entityType: "contact",
    entityId: contactId,
  })

  return { scanId: scan!.id, contactId, viable: true }
}

export async function getRecentScans(params: {
  agentId: string
  brokerageId: string
  limit?: number
}): Promise<{
  id: string
  created_at: string
  extracted_data: Record<string, string>
  confidence_score: number
  review_status: "approved" | "rejected"
  contact_id: string | null
  raw_image_url: string
}[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("business_card_scans")
    .select("id, created_at, extracted_data, confidence_score, review_status, contact_id, raw_image_url")
    .eq("agent_id", params.agentId)
    .eq("brokerage_id", params.brokerageId)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 20)

  if (error) throw new Error(`Failed to load scans: ${error.message}`)

  return (data ?? []) as {
    id: string
    created_at: string
    extracted_data: Record<string, string>
    confidence_score: number
    review_status: "approved" | "rejected"
    contact_id: string | null
    raw_image_url: string
  }[]
}
