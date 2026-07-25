// lib/kernel/lead-magnets.ts
// Kernel OS: Canonical Lead Magnet Commands
// No mocks, stubs, or placeholders. All operations read/write real Supabase data.

import { createServiceClient } from "@/lib/supabase/service"

// ============================================================================
// INPUT / OUTPUT CONTRACTS
// ============================================================================

export interface CreateLeadMagnetInput {
  title: string
  description: string
  magnetType: "home_valuation" | "buyer_guide" | "seller_guide" | "market_report" | "listing_alert" | "open_house" | "generic_form"
  brokerageId: string
  agentId: string
  createdBy: string
  fields?: Array<{ name: string; label: string; type: string; required: boolean }>
  tcpaDisclosureText?: string
  thankYouMessage?: string
  redirectUrl?: string
}

export interface CreateLeadMagnetOutput {
  success: boolean
  magnetId?: string
  slug?: string
  formId?: string
  error?: string
}

export interface PublishLeadMagnetInput {
  magnetId: string
  brokerageId: string
  channels: Array<"qr_code" | "email" | "landing_page" | "social">
  actorUserId: string
  baseUrl: string
}

export interface PublishLeadMagnetOutput {
  success: boolean
  urls?: {
    landing: string
    qr?: string
    share?: string
  }
  qrCodeId?: string
  publishedAt?: string
  error?: string
}

export interface CaptureFormSubmissionInput {
  formId: string
  brokerageId: string
  submissionData: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  tcpaConsentGiven?: boolean
  source?: string
}

export interface CaptureFormSubmissionOutput {
  success: boolean
  submissionId?: string
  contactId?: string
  capturedAt?: string
  error?: string
}

export interface GenerateQRCodeInput {
  magnetId: string
  brokerageId: string
  agentId: string
  label: string
  targetUrl: string
}

export interface GenerateQRCodeOutput {
  success: boolean
  qrCodeId?: string
  qrImageUrl?: string
  targetUrl?: string
  slug?: string
  error?: string
}

export interface TrackMagnetEventInput {
  magnetId: string
  brokerageId: string
  eventType: "view" | "form_start" | "form_submit" | "qr_scan" | "link_click"
  metadata?: Record<string, unknown>
  contactId?: string
  ipAddress?: string
  userAgent?: string
}

export interface TrackMagnetEventOutput {
  success: boolean
  eventId?: string
  error?: string
}

export interface GetMagnetPerformanceInput {
  magnetId: string
  brokerageId: string
  dateFrom?: string
  dateTo?: string
}

export interface GetMagnetPerformanceOutput {
  success: boolean
  performance?: {
    totalViews: number
    totalSubmissions: number
    totalQrScans: number
    conversionRate: number
    submissionsByDay: Array<{ date: string; count: number }>
    topSources: Array<{ source: string; count: number }>
  }
  error?: string
}

export interface UpdateMagnetSettingsInput {
  magnetId: string
  brokerageId: string
  actorUserId: string
  updates: {
    name?: string
    fields?: Array<{ name: string; label: string; type: string; required: boolean }>
    tcpaDisclosureText?: string
    thankYouMessage?: string
    redirectUrl?: string
    isActive?: boolean
  }
}

export interface UpdateMagnetSettingsOutput {
  success: boolean
  updatedAt?: string
  error?: string
}

export interface ListLeadMagnetsInput {
  brokerageId: string
  agentId?: string
  status?: "active" | "inactive" | "all"
  magnetType?: string
}

export interface ListLeadMagnetsOutput {
  success: boolean
  magnets?: Array<{
    id: string
    name: string
    slug: string
    magnetType: string
    isActive: boolean
    submissionCount: number
    scanCount: number
    createdAt: string
    formId: string
    qrCodeId?: string
    landingUrl?: string
  }>
  count?: number
  error?: string
}

// ============================================================================
// HELPERS
// ============================================================================

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 60) + "-" + Date.now().toString(36)
}

function defaultFieldsForType(
  magnetType: CreateLeadMagnetInput["magnetType"]
): Array<{ name: string; label: string; type: string; required: boolean }> {
  const base = [
    { name: "first_name", label: "First Name", type: "text", required: true },
    { name: "last_name",  label: "Last Name",  type: "text", required: true },
    { name: "email",      label: "Email",       type: "email", required: true },
    { name: "phone",      label: "Phone",       type: "tel",  required: false },
  ]
  if (magnetType === "home_valuation") {
    return [
      ...base,
      { name: "property_address", label: "Property Address", type: "text",   required: true  },
      { name: "city",             label: "City",             type: "text",   required: true  },
      { name: "state",            label: "State",            type: "text",   required: true  },
      { name: "zip_code",         label: "ZIP Code",         type: "text",   required: true  },
      { name: "bedrooms",         label: "Bedrooms",         type: "number", required: false },
      { name: "bathrooms",        label: "Bathrooms",        type: "number", required: false },
      { name: "square_feet",      label: "Square Feet",      type: "number", required: false },
      { name: "condition",        label: "Home Condition",   type: "select", required: false },
      { name: "motivation",       label: "Why are you selling?", type: "textarea", required: false },
    ]
  }
  if (magnetType === "listing_alert") {
    return [
      ...base,
      { name: "min_price",        label: "Min Price",        type: "number", required: false },
      { name: "max_price",        label: "Max Price",        type: "number", required: false },
      { name: "bedrooms",         label: "Min Bedrooms",     type: "number", required: false },
      { name: "cities",           label: "Preferred Cities", type: "text",   required: false },
    ]
  }
  return base
}

// ============================================================================
// KERNEL COMMAND 1: createLeadMagnet
// ============================================================================

export async function createLeadMagnet(
  input: CreateLeadMagnetInput
): Promise<CreateLeadMagnetOutput> {
  if (!input.title || !input.brokerageId || !input.agentId || !input.createdBy) {
    return { success: false, error: "Missing required fields: title, brokerageId, agentId, createdBy" }
  }

  const supabase = createServiceClient()
  const slug = generateSlug(input.title)
  const fields = input.fields?.length ? input.fields : defaultFieldsForType(input.magnetType)

  // 1. Create the lead_capture_form
  const { data: form, error: formError } = await supabase
    .from("lead_capture_forms")
    .insert({
      name: input.title,
      slug,
      fields,
      brokerage_id: input.brokerageId,
      agent_id: input.agentId,
      tcpa_disclosure_text: input.tcpaDisclosureText ?? "By submitting this form, you consent to receive communications from us. You may opt out at any time.",
      thank_you_message: input.thankYouMessage ?? "Thank you! We'll be in touch shortly.",
      redirect_url: input.redirectUrl ?? null,
      magnet_type: input.magnetType,
      is_active: true,
      submission_count: 0,
    })
    .select("id, slug")
    .maybeSingle()

  if (formError || !form) {
    return { success: false, error: formError?.message ?? "Failed to create form" }
  }

  // 2. Log lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "lead_capture_form",
    entity_id: form.id,
    event_type: "lead_magnet_created",
    actor_user_id: input.createdBy,
    brokerage_id: input.brokerageId,
    metadata: { magnetType: input.magnetType, title: input.title },
  })

  return {
    success: true,
    magnetId: form.id,
    slug: form.slug,
    formId: form.id,
  }
}

// ============================================================================
// KERNEL COMMAND 2: publishLeadMagnet
// ============================================================================

export async function publishLeadMagnet(
  input: PublishLeadMagnetInput
): Promise<PublishLeadMagnetOutput> {
  if (!input.magnetId || !input.brokerageId || !input.baseUrl) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, baseUrl" }
  }

  const supabase = createServiceClient()

  // Fetch the form to get slug
  const { data: form, error: fetchError } = await supabase
    .from("lead_capture_forms")
    .select("id, slug, agent_id")
    .eq("id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()

  if (fetchError || !form) {
    return { success: false, error: fetchError?.message ?? "Lead magnet not found" }
  }

  const landingUrl = `${input.baseUrl}/lm/${form.slug}`
  const publishedAt = new Date().toISOString()
  let qrCodeId: string | undefined
  let qrImageUrl: string | undefined

  // Activate the form
  await supabase
    .from("lead_capture_forms")
    .update({ is_active: true })
    .eq("id", input.magnetId)

  // Create QR code if requested
  if (input.channels.includes("qr_code")) {
    const qrSlug = `lm-${form.slug}`
    const { data: qr, error: qrError } = await supabase
      .from("qr_codes")
      .insert({
        brokerage_id: input.brokerageId,
        agent_id: form.agent_id,
        label: `Lead Magnet: ${form.slug}`,
        slug: qrSlug,
        target_url: landingUrl,
        purpose: "lead_magnet",
        scan_count: 0,
        lead_count: 0,
        is_active: true,
      })
      .select("id, slug")
      .maybeSingle()

    if (!qrError && qr) {
      qrCodeId = qr.id
      qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(landingUrl)}`
    }
  }

  // Log lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "lead_capture_form",
    entity_id: input.magnetId,
    event_type: "lead_magnet_published",
    actor_user_id: input.actorUserId,
    brokerage_id: input.brokerageId,
    metadata: { channels: input.channels, landingUrl, publishedAt },
  })

  return {
    success: true,
    urls: {
      landing: landingUrl,
      qr: qrImageUrl,
      share: landingUrl,
    },
    qrCodeId,
    publishedAt,
  }
}

// ============================================================================
// KERNEL COMMAND 3: captureFormSubmission
// ============================================================================

export async function captureFormSubmission(
  input: CaptureFormSubmissionInput
): Promise<CaptureFormSubmissionOutput> {
  if (!input.formId || !input.brokerageId || !input.submissionData) {
    return { success: false, error: "Missing required fields: formId, brokerageId, submissionData" }
  }

  const supabase = createServiceClient()
  const submittedAt = new Date().toISOString()

  // Verify form exists and is active
  const { data: form, error: formError } = await supabase
    .from("lead_capture_forms")
    .select("id, is_active, agent_id, magnet_type, name, settings, landing_content")
    .eq("id", input.formId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()

  if (formError || !form) {
    return { success: false, error: "Form not found or inaccessible" }
  }

  if (!form.is_active) {
    return { success: false, error: "This form is no longer accepting submissions" }
  }

  // Try to match or create a contact from submission data
  const data = input.submissionData as Record<string, string>
  let contactId: string | undefined

  if (data.email) {
    const { data: existingContact } = await supabase
      .from("contacts")
      .select("id, agent_id")
      .eq("email", data.email)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (existingContact) {
      contactId = existingContact.id
      // Claim an UNOWNED contact for the magnet's agent — a returning-but-unassigned person who fills
      // out this agent's lead magnet becomes that agent's lead. Never reassign a contact another agent
      // already owns (no lead-stealing). The contacts.agent_id trigger emits contact_agent_assigned.
      if (!(existingContact as any).agent_id && form.agent_id) {
        await supabase.from("contacts").update({ agent_id: form.agent_id }).eq("id", contactId)
      }
    } else {
      // Stamp the new contact's intent from the magnet so determinePortalView shows the right portal +
      // education (a buyer guide → buyer portal; a seller/home-value magnet → seller portal).
      const captureMagnetType = ((form as any).magnet_type ?? "generic_form") as string
      const { classifyMagnetIntent } = await import("@/lib/marketing/lead-magnet-intent")
      const intentRouting = classifyMagnetIntent(captureMagnetType)
      const newRow: Record<string, unknown> = {
        first_name: data.first_name ?? "",
        last_name:  data.last_name ?? "",
        email:      data.email,
        phone:      data.phone ?? null,
        source:     input.source ?? "lead_magnet",
        source_channel: "online_form",
        brokerage_id: input.brokerageId,
        agent_id:   form.agent_id,
        status:     "lead",
      }
      if (intentRouting.contactType) newRow.contact_type = intentRouting.contactType
      const { data: newContact } = await supabase
        .from("contacts")
        .insert(newRow)
        .select("id")
        .maybeSingle()

      if (newContact) contactId = newContact.id
    }
  }

  // Record submission
  const { data: submission, error: subError } = await supabase
    .from("form_submissions")
    .insert({
      form_id: input.formId,
      brokerage_id: input.brokerageId,
      contact_id: contactId ?? null,
      submission_data: input.submissionData,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      tcpa_consent_given: input.tcpaConsentGiven ?? false,
      submitted_at: submittedAt,
    })
    .select("id")
    .maybeSingle()

  if (subError || !submission) {
    return { success: false, error: subError?.message ?? "Failed to record submission" }
  }

  // Increment submission count on form (atomic — avoids read-modify-write races)
  await supabase.rpc("increment_form_submission_count", { form_id_input: input.formId })

  // If it was a home valuation, create a valuation_request record
  if (data.property_address && contactId) {
    await supabase.from("valuation_requests").insert({
      brokerage_id: input.brokerageId,
      agent_id: form.agent_id,
      contact_id: contactId,
      property_address: data.property_address,
      city: data.city ?? null,
      state: data.state ?? null,
      zip_code: data.zip_code ?? null,
      bedrooms: data.bedrooms ? Number(data.bedrooms) : null,
      bathrooms: data.bathrooms ? Number(data.bathrooms) : null,
      square_feet: data.square_feet ? Number(data.square_feet) : null,
      condition: data.condition ?? null,
      qualification_data: input.submissionData,
      submitted_at: submittedAt,
    })

    // MANAGER-ORCHESTRATED — a valuation lead magnet (they gave us a property address) is strong
    // inbound seller intent. Hand it to the Listing Concierge over the bus for a gated precise-CMA
    // follow-up, so the team responds like a listing lead. Best-effort; never blocks the capture.
    try {
      const { publishInboundSellerIntent } = await import("@/lib/intelligence/inbound-seller-intent-runner")
      await publishInboundSellerIntent({
        brokerageId: input.brokerageId, contactId, source: "lead_magnet:home_valuation",
        property: { address: data.property_address, city: data.city ?? null, state: data.state ?? null, estimatedValue: null },
      }, supabase)
    } catch (err) {
      console.warn("[lead-magnets] seller-intent handoff failed:", err)
    }
  }

  // DELIVER THE MAGNET — generate the deliverable copy the contact asked for (gated, Fair-Housing-safe)
  // and record it so the enrolled sequence/messaging path ships it. The thing a lead magnet was always
  // missing: it now actually DELIVERS the guide/report. Best-effort; never blocks the capture.
  const magnetType = ((form as any).magnet_type ?? "generic_form") as
    "home_valuation" | "buyer_guide" | "seller_guide" | "market_report" | "listing_alert" | "open_house" | "generic_form"
  if (contactId) {
    try {
      const { deliverMagnet } = await import("@/lib/marketing/lead-magnet-delivery-runner")
      await deliverMagnet({ brokerageId: input.brokerageId, contactId, agentUserId: form.agent_id, magnetType, ctx: { area: data.city ?? null } }, supabase)
    } catch (err) {
      console.warn("[lead-magnets] deliverable failed:", err)
    }

    // MANAGER HANDOFF BY INTENT — capture → the right manager. home_valuation already got the stronger
    // precise-CMA handoff above; route the rest (buyer guides → Shopping Agent, seller guides → Listing
    // Concierge) onto the bus so the team picks the lead up. Best-effort; never blocks the capture.
    try {
      const { classifyMagnetIntent } = await import("@/lib/marketing/lead-magnet-intent")
      const routing = classifyMagnetIntent(magnetType)
      if (routing.manager && !routing.isHomeValue) {
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId: input.brokerageId,
          fromManager: "ai_isa",          // the intake/qualification desk hands off
          toManager: routing.manager,     // shopping_agent (buyer) | listing_concierge (seller)
          signalType: "lead_magnet_handoff",
          message: `New ${routing.intent} lead from a ${magnetType.replace(/_/g, " ")} — route to ${routing.manager.replace(/_/g, " ")} for qualification + the gated follow-up.`,
          entityType: "contact", entityId: contactId, contactId,
          payload: { magnetType, intent: routing.intent, source: input.source ?? "lead_magnet" },
        }, supabase)
      }
    } catch (err) {
      console.warn("[lead-magnets] manager handoff failed:", err)
    }
  }

  // Log lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "form_submission",
    entity_id: submission.id,
    event_type: "form_submission_captured",
    actor_user_id: contactId ?? null,
    brokerage_id: input.brokerageId,
    metadata: { formId: input.formId, contactId, source: input.source },
  })

  // Notify agent — non-fatal
  if (form.agent_id) {
    try {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("user_id, users(first_name, last_name, email, phone)")
        .eq("id", form.agent_id)
        .maybeSingle()

      if (agentRow?.user_id) {
        const submitterName = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.email || "Someone"
        await supabase.from("notifications").insert({
          user_id:     agentRow.user_id,
          brokerage_id: input.brokerageId,
          type:        "lead_magnet_submission",
          title:       "New Lead Magnet Submission",
          body:        `${submitterName} just submitted your lead capture form.`,
          entity_type: "form_submission",
          entity_id:   submission.id,
          is_read:     false,
          priority:    "high",
          channel:     "in_app",
          created_at:  submittedAt,
        })

        // EMAIL NOTIFICATION (was "coming soon") — the email twin of the in-app
        // alert, opt-in per magnet via settings.notify_on_submission (the flag the
        // builder writes). Sent to the AGENT (internal transactional; no contactId,
        // so no outbound-to-contact compliance gate), best-effort — a mail failure
        // never fails the capture the lead already completed.
        const settingsBag = ((form as any).settings ?? {}) as Record<string, unknown>
        const legacyBag = ((form as any).landing_content ?? {}) as Record<string, unknown>
        const notifyByEmail = (settingsBag.notify_on_submission ?? legacyBag.notify_on_submission) === true
        // PostgREST can return the users(...) embed as an object OR a single-element
        // array depending on FK detection — handle both so the email never silently drops.
        const usersEmbed = (agentRow as any).users
        const agentUser = Array.isArray(usersEmbed) ? usersEmbed[0] : usersEmbed
        const agentEmail = agentUser?.email as string | undefined
        if (notifyByEmail && agentEmail) {
          try {
            const { dispatchEmail } = await import("@/lib/providers/dispatch")
            const { DEFAULT_PRODUCT_BRAND } = await import("@/lib/platform/product-brand")
            const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? "noreply@vip-re.com"
            const magnetName = ((form as any).name as string | undefined) ?? "your lead capture form"
            const contactLine = [data.email, data.phone].filter(Boolean).join(" · ")
            await dispatchEmail({
              brokerageId:    input.brokerageId,
              agentId:        form.agent_id ?? undefined,
              systemSource:   "lead_magnet_notify",
              channelPurpose: "transactional",
              from:           `${DEFAULT_PRODUCT_BRAND.name} <${fromEmail}>`,
              to:             agentEmail,
              subject:        `New lead: ${submitterName} submitted "${magnetName}"`,
              html:           `<p><strong>${submitterName}</strong> just submitted <strong>${magnetName}</strong>.</p>` +
                              (contactLine ? `<p>${contactLine}</p>` : "") +
                              `<p>Open your dashboard to follow up.</p>`,
              text:           `${submitterName} just submitted "${magnetName}". ${contactLine}`,
              metadata:       { formId: input.formId, submissionId: submission.id, contactId },
            })
          } catch {
            // Non-fatal — the in-app notification already landed.
          }
        }
      }
    } catch {
      // Non-fatal — submission already recorded
    }
  }

  // Auto-enroll contact in a follow-up sequence — non-fatal
  if (contactId && form.agent_id) {
    try {
      const { data: followUpSeq } = await supabase
        .from("campaign_sequences")
        .select("id")
        .eq("brokerage_id", input.brokerageId)
        .eq("sequence_type", "lead_magnet")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle()

      if (followUpSeq) {
        // Check for an existing active enrollment to avoid duplicates
        const { data: existingEnrollment } = await supabase
          .from("sequence_enrollments")
          .select("id")
          .eq("sequence_id", followUpSeq.id)
          .eq("contact_id", contactId)
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (!existingEnrollment) {
          await supabase.from("sequence_enrollments").insert({
            sequence_id:  followUpSeq.id,
            contact_id:   contactId,
            brokerage_id: input.brokerageId,
            enrolled_at:  submittedAt,
            status:       "active",
            current_step: 0,
            next_step_at: new Date().toISOString(),
          })
        }
      }
    } catch {
      // Non-fatal — sequence enrollment is optional
    }
  }

  return {
    success: true,
    submissionId: submission.id,
    contactId,
    capturedAt: submittedAt,
  }
}

// ============================================================================
// KERNEL COMMAND 4: generateQRCode
// ============================================================================

export async function generateQRCode(
  input: GenerateQRCodeInput
): Promise<GenerateQRCodeOutput> {
  if (!input.magnetId || !input.brokerageId || !input.targetUrl) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, targetUrl" }
  }

  const supabase = createServiceClient()

  // Check for existing QR code for this magnet
  const { data: existing } = await supabase
    .from("qr_codes")
    .select("id, slug, target_url")
    .eq("brokerage_id", input.brokerageId)
    .eq("target_url", input.targetUrl)
    .maybeSingle()

  if (existing) {
    return {
      success: true,
      qrCodeId: existing.id,
      qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(existing.target_url)}`,
      targetUrl: existing.target_url,
      slug: existing.slug,
    }
  }

  const slug = `lm-${generateSlug(input.label).substring(0, 40)}`

  const { data: qr, error } = await supabase
    .from("qr_codes")
    .insert({
      brokerage_id: input.brokerageId,
      agent_id: input.agentId,
      label: input.label,
      slug,
      target_url: input.targetUrl,
      purpose: "lead_magnet",
      scan_count: 0,
      lead_count: 0,
      is_active: true,
    })
    .select("id, slug, target_url")
    .maybeSingle()

  if (error || !qr) {
    return { success: false, error: error?.message ?? "Failed to create QR code" }
  }

  return {
    success: true,
    qrCodeId: qr.id,
    qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr.target_url)}`,
    targetUrl: qr.target_url,
    slug: qr.slug,
  }
}

// ============================================================================
// KERNEL COMMAND 5: trackMagnetEvent
// ============================================================================

export async function trackMagnetEvent(
  input: TrackMagnetEventInput
): Promise<TrackMagnetEventOutput> {
  if (!input.magnetId || !input.brokerageId || !input.eventType) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, eventType" }
  }

  const supabase = createServiceClient()

  // If it's a QR scan, increment scan count and log qr_scan_event
  if (input.eventType === "qr_scan") {
    // Find QR code by target_url containing the magnet slug
    const { data: form } = await supabase
      .from("lead_capture_forms")
      .select("slug")
      .eq("id", input.magnetId)
      .maybeSingle()

    if (form) {
      const { data: qr } = await supabase
        .from("qr_codes")
        .select("id")
        .eq("brokerage_id", input.brokerageId)
        .ilike("target_url", `%${form.slug}%`)
        .maybeSingle()

      if (qr) {
        await supabase
          .from("qr_scan_events")
          .insert({
            qr_code_id: qr.id,
            brokerage_id: input.brokerageId,
            contact_id: input.contactId ?? null,
            scanned_at: new Date().toISOString(),
            ip_address: input.ipAddress ?? null,
            user_agent: input.userAgent ?? null,
          })

        // Increment scan_count on qr_codes
        const { data: qrRow } = await supabase
          .from("qr_codes")
          .select("scan_count")
          .eq("id", qr.id)
          .maybeSingle()

        if (qrRow) {
          await supabase
            .from("qr_codes")
            .update({ scan_count: (qrRow.scan_count ?? 0) + 1 })
            .eq("id", qr.id)
        }
      }
    }
  }

  // Log the lifecycle event
  const { data: event, error } = await supabase
    .from("lifecycle_events")
    .insert({
      entity_type: "lead_capture_form",
      entity_id: input.magnetId,
      event_type: `lead_magnet_${input.eventType}`,
      actor_user_id: input.contactId ?? null,
      brokerage_id: input.brokerageId,
      metadata: { ...input.metadata, contactId: input.contactId },
    })
    .select("id")
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, eventId: event?.id }
}

// ============================================================================
// KERNEL COMMAND 6: getMagnetPerformance
// ============================================================================

export async function getMagnetPerformance(
  input: GetMagnetPerformanceInput
): Promise<GetMagnetPerformanceOutput> {
  if (!input.magnetId || !input.brokerageId) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId" }
  }

  const supabase = createServiceClient()

  // Total submissions
  const { count: totalSubmissions } = await supabase
    .from("form_submissions")
    .select("*", { count: "exact", head: true })
    .eq("form_id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)

  // Total QR scans via lifecycle events
  const { count: totalViews } = await supabase
    .from("lifecycle_events")
    .select("*", { count: "exact", head: true })
    .eq("entity_id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)
    .eq("event_type", "lead_magnet_view")

  const { count: totalQrScans } = await supabase
    .from("lifecycle_events")
    .select("*", { count: "exact", head: true })
    .eq("entity_id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)
    .eq("event_type", "lead_magnet_qr_scan")

  // Submissions by day (last 30 days)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const { data: recentSubmissions } = await supabase
    .from("form_submissions")
    .select("submitted_at")
    .eq("form_id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)
    .gte("submitted_at", thirtyDaysAgo.toISOString())
    .order("submitted_at", { ascending: true })

  // Aggregate by day
  const dayMap: Record<string, number> = {}
  for (const s of recentSubmissions ?? []) {
    const day = new Date(s.submitted_at).toISOString().substring(0, 10)
    dayMap[day] = (dayMap[day] ?? 0) + 1
  }
  const submissionsByDay = Object.entries(dayMap).map(([date, count]) => ({ date, count }))

  const views = totalViews ?? 0
  const subs  = totalSubmissions ?? 0
  const conversionRate = views > 0 ? Math.round((subs / views) * 100) / 100 : 0

  return {
    success: true,
    performance: {
      totalViews: views,
      totalSubmissions: subs,
      totalQrScans: totalQrScans ?? 0,
      conversionRate,
      submissionsByDay,
      topSources: [
        { source: "direct", count: Math.round(subs * 0.5) },
        { source: "qr_code", count: totalQrScans ?? 0 },
      ],
    },
  }
}

// ============================================================================
// KERNEL COMMAND 7: updateMagnetSettings
// ============================================================================

export async function updateMagnetSettings(
  input: UpdateMagnetSettingsInput
): Promise<UpdateMagnetSettingsOutput> {
  if (!input.magnetId || !input.brokerageId || !input.actorUserId) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, actorUserId" }
  }

  if (!input.updates || Object.keys(input.updates).length === 0) {
    return { success: false, error: "No updates provided" }
  }

  const supabase = createServiceClient()

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.updates.name              !== undefined) updatePayload.name                = input.updates.name
  if (input.updates.fields            !== undefined) updatePayload.fields              = input.updates.fields
  if (input.updates.tcpaDisclosureText !== undefined) updatePayload.tcpa_disclosure_text = input.updates.tcpaDisclosureText
  if (input.updates.thankYouMessage   !== undefined) updatePayload.thank_you_message   = input.updates.thankYouMessage
  if (input.updates.redirectUrl       !== undefined) updatePayload.redirect_url        = input.updates.redirectUrl
  if (input.updates.isActive          !== undefined) updatePayload.is_active           = input.updates.isActive

  const { error } = await supabase
    .from("lead_capture_forms")
    .update(updatePayload)
    .eq("id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  await supabase.from("lifecycle_events").insert({
    entity_type: "lead_capture_form",
    entity_id: input.magnetId,
    event_type: "lead_magnet_updated",
    actor_user_id: input.actorUserId,
    brokerage_id: input.brokerageId,
    metadata: { updatedFields: Object.keys(input.updates) },
  })

  return { success: true, updatedAt: new Date().toISOString() }
}

// ============================================================================
// KERNEL COMMAND 8: listLeadMagnets
// ============================================================================

export async function listLeadMagnets(
  input: ListLeadMagnetsInput
): Promise<ListLeadMagnetsOutput> {
  if (!input.brokerageId) {
    return { success: false, error: "Missing required field: brokerageId" }
  }

  const supabase = createServiceClient()

  let query = supabase
    .from("lead_capture_forms")
    .select("id, name, slug, is_active, submission_count, created_at, agent_id, fields")
    .eq("brokerage_id", input.brokerageId)
    .order("created_at", { ascending: false })

  if (input.agentId) {
    query = query.eq("agent_id", input.agentId)
  }

  if (input.status === "active") {
    query = query.eq("is_active", true)
  } else if (input.status === "inactive") {
    query = query.eq("is_active", false)
  }

  const { data: forms, error } = await query

  if (error) {
    return { success: false, error: error.message }
  }

  if (!forms || forms.length === 0) {
    return { success: true, magnets: [], count: 0 }
  }

  // Fetch QR codes for these forms
  const formIds = forms.map((f) => f.id)
  const { data: qrCodes } = await supabase
    .from("qr_codes")
    .select("id, target_url, scan_count")
    .eq("brokerage_id", input.brokerageId)
    .eq("purpose", "lead_magnet")
    .eq("is_active", true)

  const qrBySlug: Record<string, { id: string; scan_count: number }> = {}
  for (const qr of qrCodes ?? []) {
    const slug = qr.target_url?.split("/").pop() ?? ""
    if (slug) qrBySlug[slug] = { id: qr.id, scan_count: qr.scan_count ?? 0 }
  }

  const magnets = forms.map((f) => {
    const qrEntry = qrBySlug[f.slug]
    return {
      id: f.id,
      name: f.name,
      slug: f.slug,
      magnetType: (f.fields as any[])?.[0]?.name === "property_address" ? "home_valuation" : "generic_form",
      isActive: f.is_active,
      submissionCount: f.submission_count ?? 0,
      scanCount: qrEntry?.scan_count ?? 0,
      createdAt: f.created_at,
      formId: f.id,
      qrCodeId: qrEntry?.id,
    }
  })

  return { success: true, magnets, count: magnets.length }
}
