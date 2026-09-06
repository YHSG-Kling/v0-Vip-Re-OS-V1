"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { gatewayChat } from "@/lib/ai/gateway-chat"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"
import { VENDOR_CATEGORY_OTHER } from "@/lib/kernel/vendor-categories"

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
  /** explicit routing override; omitted = auto-classified from title/company
   *  (an inspector's card → VENDOR book; a fellow agent's card → RECRUITING
   *  pipeline — agents are platform users, never CRM contacts). */
  target?: "contact" | "vendor" | "recruit"
}): Promise<{ scanId: string; contactId: string | null; vendorId: string | null; recruitId: string | null; target: "contact" | "vendor" | "recruit"; viable: boolean }> {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  // NOT `?? auth.userId` (m361) — business_card_scans.agent_id FKs agents.
  const agentId = auth.agentId
  if (!agentId) throw new Error("No agent profile for this user yet — finish account setup.")

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
  // Claude Vision OCR via the Vercel AI Gateway (image passed as a data URL).
  const response = await gatewayChat({
    model: "anthropic/claude-sonnet-4-20250514",
    maxTokens: 300,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${params.mimeType};base64,${params.imageBase64}` } },
          { type: "text", text: "Return ONLY a JSON object with keys: first_name,last_name,email,phone,company,title,address,website. No other text." },
        ],
      },
    ],
  })

  let extracted: Record<string, string> = {}
  try {
    const text = response.content ?? "{}"
    const match = text.match(/\{[\s\S]*\}/)
    extracted = JSON.parse(match ? match[0] : "{}") as Record<string, string>
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

    return { scanId: scan!.id, contactId: null, vendorId: null, recruitId: null, target: "contact", viable: false }
  }

  // 6) Route the card: an explicit override wins, else the pure classifier
  // (an inspector/stager/lender card is a VENDOR; a co-op agent stays a contact).
  const { classifyCardTarget } = await import("@/lib/contacts/card-classifier")
  const cls = classifyCardTarget({ title: extracted.title ?? null, company: extracted.company ?? null })
  const target = params.target ?? cls.target

  if (target === "vendor") {
    const fullName = [extracted.first_name, extracted.last_name].filter(Boolean).join(" ").trim()
    // vendors.category/status CHECK vocabularies verified live; a scanned
    // vendor lands PENDING — the vendor verification rail vets it before use.
    const { data: vendor, error: vendorError } = await supabase.from("vendors").insert({
      brokerage_id: brokerageId,
      name: (extracted.company ?? "").trim() || fullName || "Scanned vendor",
      category: cls.category ?? VENDOR_CATEGORY_OTHER,
      email: extracted.email ?? null,
      phone: extracted.phone ?? null,
      website: extracted.website ?? null,
      status: "pending",
      notes: [
        `Scanned from a business card.`,
        fullName ? `Contact person: ${fullName}${extracted.title ? ` (${extracted.title})` : ""}.` : null,
        extracted.address ? `Address on card: ${extracted.address}.` : null,
      ].filter(Boolean).join(" "),
    }).select("id").single()
    if (vendorError || !vendor) throw new Error(`Vendor create failed: ${vendorError?.message ?? "no data"}`)

    await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, routed_to: "vendor", vendor_id: vendor.id },
    }).eq("id", scan!.id)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId,
      entity_type: "vendor",
      entity_id: vendor.id,
      event_type: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scan!.id, routed_to: "vendor", category: cls.category ?? VENDOR_CATEGORY_OTHER },
    })

    return { scanId: scan!.id, contactId: null, vendorId: vendor.id, recruitId: null, target: "vendor", viable: true }
  }

  if (target === "recruit") {
    // A fellow agent's card = a RECRUITING prospect (agents are platform
    // users, owner rule). recruits.status CHECK vocabulary verified live.
    const { data: recruit, error: recruitError } = await supabase.from("recruits").insert({
      brokerage_id: brokerageId,
      recruiter_agent_id: agentId,
      first_name: extracted.first_name ?? null,
      last_name: extracted.last_name ?? null,
      email: extracted.email ?? null,
      phone: extracted.phone ?? null,
      current_brokerage: extracted.company ?? null,
      status: "prospect",
      referral_source: "business_card",
      notes: [
        `Scanned from a business card.`,
        extracted.title ? `Title on card: ${extracted.title}.` : null,
        extracted.website ? `Website: ${extracted.website}` : null,
      ].filter(Boolean).join(" "),
    }).select("id").single()
    if (recruitError || !recruit) throw new Error(`Recruit create failed: ${recruitError?.message ?? "no data"}`)

    await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, routed_to: "recruit", recruit_id: recruit.id },
    }).eq("id", scan!.id)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId,
      entity_type: "recruit",
      entity_id: recruit.id,
      event_type: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scan!.id, routed_to: "recruit" },
    })

    return { scanId: scan!.id, contactId: null, vendorId: null, recruitId: recruit.id, target: "recruit", viable: true }
  }

  // Viable contact → captureContact (tcpa_consent=false always for business cards).
  // Owner agent resolves via brokerage assignment rules — the scanner doesn't
  // own the contact just because they scanned it. Company/title/website from
  // the card ride the notes (previously extracted then DROPPED).
  const { contactId } = await captureContact({
    brokerageId: brokerageId,
    ownerAgentId: null,
    source: "business_card",
    first_name: extracted.first_name ?? null,
    last_name: extracted.last_name ?? null,
    email: extracted.email ?? null,
    phone: extracted.phone ?? null,
    notes: [
      extracted.title || extracted.company
        ? `From their card: ${[extracted.title, extracted.company].filter(Boolean).join(" @ ")}.`
        : null,
      extracted.website ? `Website: ${extracted.website}` : null,
    ].filter(Boolean).join("\n") || undefined,
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

  return { scanId: scan!.id, contactId, vendorId: null, recruitId: null, target: "contact", viable: true }
}

/**
 * WHO REVIEWED THE SCAN — nobody, and the row says so honestly.
 *
 * `business_card_scans.reviewed_by` FKs users(id) (scripts/schema-fk-map.ts),
 * and its ONLY writer is uploadBusinessCard above, which stamps a LITERAL
 * `null` beside `reviewed_at: now` (verified 2026-09-02: no other
 * `.from("business_card_scans")` insert/update in app/ or lib/ names the
 * column). There is no human review lane: `review_status` is the VIABILITY
 * GATE's verdict (name + a contact method present), and `reviewed_at` is the
 * moment that gate ran. A name resolver for a column no code path ever sets
 * would resolve nothing forever and read as a working feature — so none is
 * built. Both columns are read and returned so the surface can render
 * "auto-gated, not reviewed by a person" instead of implying a reviewer. If a
 * writer is ever added, the value arrives here non-null and the page's text
 * changes on its own — that is the moment to build the resolver, not before.
 */
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
  /** Always null today — see the note above this function. */
  reviewed_by: string | null
  /** When the viability gate ran (not a human review timestamp). */
  reviewed_at: string | null
}[]> {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  // Scope to caller's session — only their own scans within their brokerage
  let query = supabase
    .from("business_card_scans")
    .select("id, created_at, extracted_data, confidence_score, review_status, contact_id, raw_image_url, reviewed_by, reviewed_at")
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

  return ((data ?? []) as any[]).map((s) => ({
    id: s.id as string,
    created_at: s.created_at as string,
    extracted_data: (s.extracted_data ?? {}) as Record<string, string>,
    confidence_score: Number(s.confidence_score ?? 0),
    review_status: s.review_status as "approved" | "rejected",
    contact_id: (s.contact_id as string | null) ?? null,
    raw_image_url: s.raw_image_url as string,
    reviewed_by: (s.reviewed_by as string | null) ?? null,
    reviewed_at: (s.reviewed_at as string | null) ?? null,
  }))
}
