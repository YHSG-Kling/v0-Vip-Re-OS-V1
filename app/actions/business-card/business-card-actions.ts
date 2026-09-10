"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { gatewayChat } from "@/lib/ai/gateway-chat"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { VENDOR_CATEGORY_OTHER } from "@/lib/kernel/vendor-categories"
import { requireCallerWithAgent as requireCaller } from "@/lib/auth/require-caller"
import type { CardSubjectType } from "@/lib/contacts/card-classifier"

// Was trusting caller-supplied agentId + brokerageId. Caller could
// upload business cards attributed to any agent in any brokerage
// (creating fraudulent contacts + burning Claude Vision API budget).
// Now: identity resolved from session, agent_id verified to belong to
// caller's brokerage.
// TOMBSTONE: local requireCaller merged onto lib/auth/require-caller.ts:185
// requireCallerWithAgent (imported above as `requireCaller`) — §1/§6 SAME BODY
// census round 3, 2026-09-09.

export async function uploadBusinessCard(params: {
  imageBase64: string
  mimeType: "image/jpeg" | "image/png" | "image/webp"
  agentId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
  /** Free-text notes the scanning agent types on the card review surface —
   *  priority-2 determination source (lib/contacts/card-classifier.ts). */
  notes?: string | null
  /** Explicit picker on the card-review surface — wins outright over both the
   *  reader and the notes (owner ruling 2026-09-10). Omitted = auto-classified. */
  subjectType?: CardSubjectType
  /** @deprecated pre-wave-48 3-way override, kept for source compatibility with
   *  any stale caller — mapped onto subjectType ('recruit' → 'agent') when
   *  `subjectType` itself is not passed. TOMBSTONE: the 3-way CardTarget this
   *  mirrored was merged onto CardSubjectType, lib/contacts/card-classifier.ts:38. */
  target?: "contact" | "vendor" | "recruit"
}): Promise<{
  scanId: string
  contactId: string | null
  vendorId: string | null
  recruitId: string | null
  /** back-compat 3-way projection of cardSubjectType (sphere/potential_contact/
   *  unknown all report "contact" here — no contacts row is implied by it; read
   *  cardSubjectType for the real classification). */
  target: "contact" | "vendor" | "recruit"
  cardSubjectType: CardSubjectType
  subjectUserId: string | null
  viable: boolean
}> {
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

  // BUSINESS_CARD_UPLOADED — was a direct lifecycle_events insert (audit-only,
  // no reactor fan-out: notification_rules' live business_card_uploaded row
  // never fired). Real moment: right after the scan row lands, tenant/entity
  // read off it. void/catch so a fan-out hiccup never fails the upload.
  void emitKernelEvent({
    event:       KernelEvent.BUSINESS_CARD_UPLOADED,
    brokerageId,
    entityType:  "business_card",
    entityId:    scan!.id,
    agentId,
    metadata:    { confidence: confidence_score, viable },
  }).catch((err) => console.error("[businessCardUpload] BUSINESS_CARD_UPLOADED emit failed:", err))

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

    return { scanId: scan!.id, contactId: null, vendorId: null, recruitId: null, target: "contact", cardSubjectType: "unknown", subjectUserId: null, viable: false }
  }

  // 6) CLASSIFY the card's subject (owner ruling 2026-09-10 — never assume
  // 'contact'). Priority 1 (reader fields) and 2 (notes) are the PURE
  // classifier; priority 3 (an existing-user/contact/vendor match by
  // email/phone) is database-backed and lives here; an explicit picker on the
  // review surface (params.subjectType) always wins outright over all three.
  const { classifyCardSubject } = await import("@/lib/contacts/card-classifier")
  const detected = classifyCardSubject({
    title: extracted.title ?? null,
    company: extracted.company ?? null,
    notes: params.notes ?? null,
  })

  // Pre-wave-48 callers may still pass the old 3-way `target` override —
  // honored only when the new `subjectType` override is absent.
  const legacyOverride: CardSubjectType | null =
    params.target === "recruit" ? "agent" : params.target === "vendor" ? "vendor" : params.target === "contact" ? "contact" : null

  // Priority 3 — an existing platform user / contact / vendor matched by
  // email or phone. The ONLY tier that can attach a real subject_user_id
  // (owner ruling: "should be a userid user type"), and it can upgrade an
  // otherwise-UNKNOWN card — never overrides a signal the reader or the
  // notes already gave.
  let subjectUserId: string | null = null
  // The owner's own words: "should be a userid user type" — the card carries a
  // USER ID *and* USER TYPE. A matched `users` row is resolved with its real
  // user_type so the classification below is decided from that (vendor-typed
  // user → vendor, contact-typed user → contact) instead of assuming every
  // matched platform user is a fellow agent. Carried into the routing metadata
  // (processKernelEvent/lifecycle_events below) for the receiving manager.
  let subjectUserType: string | null = null
  let matchedContactId: string | null = null
  let matchedVendorId: string | null = null
  const cardEmail = (extracted.email ?? "").trim().toLowerCase()
  const cardPhone = (extracted.phone ?? "").trim()
  if (cardEmail || cardPhone) {
    const userQuery = supabase.from("users").select("id, user_type").eq("brokerage_id", brokerageId)
    const { data: matchedUser } = await (cardEmail ? userQuery.eq("email", cardEmail) : userQuery.eq("phone", cardPhone)).maybeSingle()
    if (matchedUser) {
      const mu = matchedUser as { id: string; user_type: string | null }
      subjectUserId = mu.id
      subjectUserType = mu.user_type ?? null
    } else {
      const contactQuery = supabase.from("contacts").select("id").eq("brokerage_id", brokerageId)
      const { data: matchedContact } = await (cardEmail ? contactQuery.eq("email", cardEmail) : contactQuery.eq("phone", cardPhone)).maybeSingle()
      if (matchedContact) {
        matchedContactId = (matchedContact as { id: string }).id
      } else {
        const vendorQuery = supabase.from("vendors").select("id").eq("brokerage_id", brokerageId)
        const { data: matchedVendor } = await (cardEmail ? vendorQuery.eq("email", cardEmail) : vendorQuery.eq("phone", cardPhone)).maybeSingle()
        if (matchedVendor) matchedVendorId = (matchedVendor as { id: string }).id
      }
    }
  }

  let cardSubjectType: CardSubjectType = detected.subjectType
  let classifiedBy: "picker" | "reader" | "notes" | "match" | "default" = detected.source
  if (cardSubjectType === "unknown") {
    if (subjectUserId) {
      // Decided from the REAL users.user_type (owner ruling 2026-09-10), not an
      // assumption that any matched platform user is a fellow agent — a
      // vendor-seated user (users.user_type='vendor', CLAUDE.md §4) or a
      // contact-seated portal user routes as such; every other seat (agent,
      // broker/broker_admin/broker_owner/team_lead/admin/compliance_officer,
      // isa/tc/support/system/superadmin) is the platform-staff/professional
      // bucket this tier has always meant by 'agent'.
      cardSubjectType = subjectUserType === "vendor" ? "vendor" : subjectUserType === "contact" ? "contact" : "agent"
      classifiedBy = "match"
    }
    else if (matchedVendorId) { cardSubjectType = "vendor"; classifiedBy = "match" }
    else if (matchedContactId) { cardSubjectType = "contact"; classifiedBy = "match" }
    else if (legacyOverride) { cardSubjectType = legacyOverride; classifiedBy = "picker" }
  }
  // Priority 4 — the explicit review-surface picker wins outright.
  if (params.subjectType) { cardSubjectType = params.subjectType; classifiedBy = "picker" }

  const category = cardSubjectType === "vendor" ? (detected.category ?? VENDOR_CATEGORY_OTHER) : null

  if (cardSubjectType === "vendor") {
    const fullName = [extracted.first_name, extracted.last_name].filter(Boolean).join(" ").trim()
    // vendors.category/status CHECK vocabularies verified live; a scanned
    // vendor lands PENDING — the vendor verification rail vets it before use.
    const { data: vendor, error: vendorError } = await supabase.from("vendors").insert({
      brokerage_id: brokerageId,
      name: (extracted.company ?? "").trim() || fullName || "Scanned vendor",
      category,
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

    // Classification rides the typed m617 columns (card_subject_type/
    // subject_user_id/subject_notes/classified_by) now that the migration is
    // APPLIED live — extracted_data keeps only the raw card fields plus the
    // routed_to/vendor_id keys no typed column exists for yet.
    const { error: scanUpdateVendorError } = await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, routed_to: "vendor", vendor_id: vendor.id },
      card_subject_type: cardSubjectType,
      subject_user_id: subjectUserId,
      subject_notes: params.notes ?? null,
      classified_by: classifiedBy,
    }).eq("id", scan!.id)
    if (scanUpdateVendorError) console.error("[businessCardUpload] scan classification update (vendor) failed:", scanUpdateVendorError)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId,
      entity_type: "vendor",
      entity_id: vendor.id,
      event_type: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scan!.id, routed_to: "vendor", category: category ?? VENDOR_CATEGORY_OTHER, card_subject_type: cardSubjectType },
    })

    await processKernelEvent({
      event: KernelEvent.BUSINESS_CARD_APPROVED,
      brokerageId,
      entityType: "vendor",
      entityId: vendor.id,
      // subject_user_type rides the routing metadata (owner ruling 2026-09-10:
      // "should be a userid user type") — event-reactor.ts's BUSINESS_CARD_APPROVED
      // block forwards this whole object as the manager signal payload.
      metadata: { scanId: scan!.id, routed_to: "vendor", category, card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy },
    })

    return { scanId: scan!.id, contactId: null, vendorId: vendor.id, recruitId: null, target: "vendor", cardSubjectType, subjectUserId, viable: true }
  }

  if (cardSubjectType === "agent") {
    // A fellow agent's card = a RECRUITING prospect (agents are platform
    // users, owner rule) — NEVER a CRM contact. recruits.status CHECK
    // vocabulary verified live.
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
        params.notes ? `Agent notes: ${params.notes}` : null,
      ].filter(Boolean).join(" "),
    }).select("id").single()
    if (recruitError || !recruit) throw new Error(`Recruit create failed: ${recruitError?.message ?? "no data"}`)

    const { error: scanUpdateAgentError } = await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, routed_to: "recruit", recruit_id: recruit.id },
      card_subject_type: cardSubjectType,
      subject_user_id: subjectUserId,
      subject_notes: params.notes ?? null,
      classified_by: classifiedBy,
    }).eq("id", scan!.id)
    if (scanUpdateAgentError) console.error("[businessCardUpload] scan classification update (agent) failed:", scanUpdateAgentError)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId,
      entity_type: "recruit",
      entity_id: recruit.id,
      event_type: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scan!.id, routed_to: "recruit", card_subject_type: cardSubjectType },
    })

    await processKernelEvent({
      event: KernelEvent.BUSINESS_CARD_APPROVED,
      brokerageId,
      entityType: "recruit",
      entityId: recruit.id,
      metadata: { scanId: scan!.id, routed_to: "recruit", card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy },
    })

    return { scanId: scan!.id, contactId: null, vendorId: null, recruitId: recruit.id, target: "recruit", cardSubjectType, subjectUserId, viable: true }
  }

  if (cardSubjectType === "sphere" || cardSubjectType === "unknown") {
    // NEVER auto-create a contact for sphere/unknown — the owner ruling's
    // whole point. The card stays a business_card_scans row; the warm-intro
    // (sphere) / classify-me (unknown) handler reads it directly off the scan.
    const { error: scanUpdateSphereError } = await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted },
      card_subject_type: cardSubjectType,
      subject_user_id: subjectUserId,
      subject_notes: params.notes ?? null,
      classified_by: classifiedBy,
    }).eq("id", scan!.id)
    if (scanUpdateSphereError) console.error("[businessCardUpload] scan classification update (sphere/unknown) failed:", scanUpdateSphereError)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId,
      entity_type: "business_card",
      entity_id: scan!.id,
      event_type: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scan!.id, card_subject_type: cardSubjectType },
    })

    await processKernelEvent({
      event: KernelEvent.BUSINESS_CARD_APPROVED,
      brokerageId,
      entityType: "business_card",
      entityId: scan!.id,
      metadata: { scanId: scan!.id, card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy },
    })

    return { scanId: scan!.id, contactId: null, vendorId: null, recruitId: null, target: "contact", cardSubjectType, subjectUserId, viable: true }
  }

  // cardSubjectType is 'contact' or 'potential_contact' — the only two classes
  // the owner ruling permits to auto-create a contacts row. tcpa_consent=false
  // always (a physical card is not TCPA digital consent). Owner agent resolves
  // via brokerage assignment rules — the scanner doesn't own the contact just
  // because they scanned it. Company/title/website from the card ride the
  // notes (previously extracted then DROPPED).
  const { contactId } = await captureContact({
    brokerageId: brokerageId,
    ownerAgentId: null,
    source: "business_card",
    first_name: extracted.first_name ?? null,
    last_name: extracted.last_name ?? null,
    email: extracted.email ?? null,
    phone: extracted.phone ?? null,
    // 'prospect' is the live contacts.contact_type CHECK value for a not-yet-
    // qualified potential client (scripts/check-vocabularies.ts:538) — leaving
    // it unset for 'contact' keeps captureContact's own default.
    contact_type: cardSubjectType === "potential_contact" ? "prospect" : undefined,
    notes: [
      extracted.title || extracted.company
        ? `From their card: ${[extracted.title, extracted.company].filter(Boolean).join(" @ ")}.`
        : null,
      extracted.website ? `Website: ${extracted.website}` : null,
      params.notes ? `Agent notes: ${params.notes}` : null,
    ].filter(Boolean).join("\n") || undefined,
    tcpa_consent: false,
    tcpa_consent_date: null,
  })

  // 7) Link scan to contact
  const { error: scanUpdateContactError } = await supabase
    .from("business_card_scans")
    .update({
      contact_id: contactId,
      extracted_data: { ...extracted },
      card_subject_type: cardSubjectType,
      subject_user_id: subjectUserId,
      subject_notes: params.notes ?? null,
      classified_by: classifiedBy,
    })
    .eq("id", scan!.id)
  if (scanUpdateContactError) console.error("[businessCardUpload] scan classification update (contact) failed:", scanUpdateContactError)

  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "contact",
    entity_id: contactId,
    event_type: KernelEvent.BUSINESS_CARD_APPROVED,
    metadata: { scanId: scan!.id, autoApproved: true, card_subject_type: cardSubjectType },
  })

  await processKernelEvent({
    event: KernelEvent.BUSINESS_CARD_APPROVED,
    brokerageId: brokerageId,
    entityType: "contact",
    entityId: contactId,
    metadata: { scanId: scan!.id, autoApproved: true, card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy },
  })

  return { scanId: scan!.id, contactId, vendorId: null, recruitId: null, target: "contact", cardSubjectType, subjectUserId, viable: true }
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
  /** Read off the typed m617 column business_card_scans.card_subject_type
   *  (lib/contacts/card-classifier.ts CardSubjectType — one vocabulary, §6,
   *  asserted against scripts/check-vocabularies.ts's CHECK by
   *  scripts/business-card-classification-simulator.ts). Null for scans made
   *  before wave 48 / before the migration backfill. */
  cardSubjectType: CardSubjectType | null
  subjectUserId: string | null
  /** business_card_scans.subject_notes — the scanning agent's free-text note,
   *  rendered on the review surface beside class + classifiedBy. */
  subjectNotes: string | null
  classifiedBy: "picker" | "reader" | "notes" | "match" | "default" | null
}[]> {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  // Scope to caller's session — only their own scans within their brokerage
  let query = supabase
    .from("business_card_scans")
    .select("id, created_at, extracted_data, confidence_score, review_status, contact_id, raw_image_url, reviewed_by, reviewed_at, card_subject_type, subject_user_id, subject_notes, classified_by")
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

  return ((data ?? []) as any[]).map((s) => {
    const ed = (s.extracted_data ?? {}) as Record<string, unknown>
    return {
      id: s.id as string,
      created_at: s.created_at as string,
      extracted_data: ed as Record<string, string>,
      confidence_score: Number(s.confidence_score ?? 0),
      review_status: s.review_status as "approved" | "rejected",
      contact_id: (s.contact_id as string | null) ?? null,
      raw_image_url: s.raw_image_url as string,
      reviewed_by: (s.reviewed_by as string | null) ?? null,
      reviewed_at: (s.reviewed_at as string | null) ?? null,
      cardSubjectType: (s.card_subject_type as CardSubjectType | null | undefined) ?? null,
      subjectUserId: (s.subject_user_id as string | null | undefined) ?? null,
      subjectNotes: (s.subject_notes as string | null | undefined) ?? null,
      classifiedBy: (s.classified_by as "picker" | "reader" | "notes" | "match" | "default" | null | undefined) ?? null,
    }
  })
}
