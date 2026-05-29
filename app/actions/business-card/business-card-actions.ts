"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"

// Was trusting caller-supplied agentId + brokerageId. Caller could
// upload business cards attributed to any agent in any brokerage
// (creating fraudulent contacts + burning Claude Vision API budget).
// Now: identity resolved from session, agent_id verified to belong to
// caller's brokerage.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; agentId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  const { data: a } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, agentId: a?.id ?? null }
}

export async function uploadBusinessCard(params: {
  imageBase64: string
  mimeType: "image/jpeg" | "image/png" | "image/webp"
  agentId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
}): Promise<{ scanId: string; contactId: string | null; viable: boolean }> {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const agentId = auth.agentId ?? auth.userId

  const supabase = createServiceClient()
  const scanId = crypto.randomUUID()
  const now = new Date().toISOString()

  // 1) Upload image to Supabase storage
  const buffer = Buffer.from(params.imageBase64, "base64")
  const path = `${brokerageId}/${scanId}.jpg`
  await supabase.storage
    .from("business-cards")
    .upload(path, buffer, { contentType: params.mimeType, upsert: true })
  const { data: pub } = supabase.storage.from("business-cards").getPublicUrl(path)
  const raw_image_url = pub.publicUrl

  // 2) Call Claude Vision — JSON extraction only
  const response = await callConnector<{ content?: Array<{ text?: string }> }>({
    connector: "anthropic",
    baseUrl: "https://api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    auth: { style: "header", name: "x-api-key", value: process.env.ANTHROPIC_API_KEY ?? "" },
    headers: { "anthropic-version": "2023-06-01" },
    body: {
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
    },
  })

  const aiData = response.data ?? {}

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
      brokerage_id: brokerageId,
      agent_id: agentId,
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
    brokerage_id: brokerageId,
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
      .eq("id", agentId)
      .single()

    if (agentRow?.user_id) {
      await supabase.from("notifications").insert({
        user_id: agentRow.user_id,
        brokerage_id: brokerageId,
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

  // 6) Viable → captureContact (tcpa_consent=false always for business cards).
  // Owner agent resolves via brokerage assignment rules — the scanner doesn't
  // own the contact just because they scanned it.
  const { contactId } = await captureContact({
    brokerageId: brokerageId,
    ownerAgentId: null,
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
    brokerage_id: brokerageId,
    entity_type: "contact",
    entity_id: contactId,
    event_type: KernelEvent.BUSINESS_CARD_APPROVED,
    metadata: { scanId: scan!.id, autoApproved: true },
  })

  await processKernelEvent({
    event: KernelEvent.BUSINESS_CARD_APPROVED,
    brokerageId: brokerageId,
    entityType: "contact",
    entityId: contactId,
  })

  return { scanId: scan!.id, contactId, viable: true }
}

export async function getRecentScans(params: {
  agentId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
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
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  // Scope to caller's session — only their own scans within their brokerage
  let query = supabase
    .from("business_card_scans")
    .select("id, created_at, extracted_data, confidence_score, review_status, contact_id, raw_image_url")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 20)

  if (auth.agentId) {
    query = query.eq("agent_id", auth.agentId)
  } else {
    // Non-agent users (admin/broker) without an agents row see all scans in
    // their brokerage. Still tenant-scoped via .eq("brokerage_id", ...).
  }

  const { data, error } = await query

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
