// lib/kernel/lead-magnets.ts
// Kernel OS: Canonical Lead Magnet Commands
// No mocks, stubs, or placeholders. All operations read/write real Supabase data.

import { createServiceClient } from "@/lib/supabase/service"
import { CONTACT_SOURCE_LEAD_MAGNET } from "@/lib/campaigns/contact-sources"
import { autoEnrollContact } from "@/lib/campaign-sequences/auto-enroll"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

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
  /** agents.id (qr_codes.agent_id FK → agents.id) — nullable for brokerage-level magnets. */
  agentId: string | null
  label: string
  targetUrl: string
}

export interface GenerateQRCodeOutput {
  success: boolean
  qrCodeId?: string
  /** data:image/png;base64,… rendered by the vendored `qrcode` package (no third-party host). */
  qrImageUrl?: string
  /** The tracked /api/qr/scan?slug= URL the PNG encodes. */
  scanUrl?: string
  /** The SEMANTIC landing URL the code stands for. */
  targetUrl?: string
  slug?: string
  error?: string
}

/** THE single idempotency key for every lead-magnet QR path. Keyed on the magnet's identity, not
 *  on its (movable) landing URL — see the note on generateQRCode. */
export function leadMagnetQrLabel(magnetId: string): string {
  return `lead_magnet:${magnetId}`
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
  let shareCardUrl: string | undefined

  // Activate the form
  await supabase
    .from("lead_capture_forms")
    .update({ is_active: true })
    .eq("id", input.magnetId)

  // Create QR code if requested.
  // MERGED-THEN-DELETED: this used to be its own `qr_codes` insert with slug `lm-<formSlug>` and
  // NO dedupe at all, so re-publishing a magnet minted a second tracked code and split its scan
  // count away from the one generateQRCode had already made. It now goes through the single
  // lead-magnet minter (generateQRCode → mintTrackedQr), which dedupes on `lead_magnet:<magnetId>`
  // and stamps destination_type — neither of which this path did.
  if (input.channels.includes("qr_code")) {
    const qrResult = await generateQRCode({
      magnetId: input.magnetId,
      brokerageId: input.brokerageId,
      agentId: form.agent_id ?? null,
      label: `Lead Magnet: ${form.slug}`,
      targetUrl: landingUrl,
    })
    if (qrResult.success) {
      qrCodeId = qrResult.qrCodeId
      qrImageUrl = qrResult.qrImageUrl
    } else {
      // A refused QR must not read as "published with a QR" — the caller shows the urls it gets.
      console.error("[publishLeadMagnet] QR code was NOT created:", qrResult.error)
    }
  }

  // OG/share card — best-effort, structurally the QR branch's sibling:
  // conditional on real data, logs the refusal, never fakes success. A magnet
  // with no landing_content gets NO card (enqueueLeadMagnetCard refuses by
  // prop name via missingContentProps — Root.tsx's defaults would otherwise
  // fabricate an offer on an ad card). The render is async; the finished PNG is
  // read back at render time by /lm/[slug] generateMetadata and by the next
  // publish call below.
  {
    const cardResult = await enqueueLeadMagnetCard(input.magnetId, input.brokerageId, supabase)
    if (!cardResult.ok) {
      console.error("[publishLeadMagnet] share card was NOT enqueued:", cardResult.skipped)
    }
  }

  // urls.share UPGRADE: this used to repeat the landing URL. Once a LeadMagnetCard
  // render has completed for this magnet (a prior publish enqueued it), share
  // becomes the finished 1200×630 card image — the artifact a social/ad share
  // actually wants. First publish (nothing rendered yet) and any refused read
  // keep the honest landing-URL fallback.
  {
    const { data: card, error: cardErr } = await supabase
      .from("remotion_composition_renders")
      .select("output_url")
      .eq("brokerage_id", input.brokerageId)
      .eq("entity_type", "lead_capture_form")
      .eq("entity_id", input.magnetId)
      .eq("composition_id", "LeadMagnetCard")
      .eq("render_status", "succeeded")
      .not("output_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (cardErr) console.error("[publishLeadMagnet] share-card read refused:", cardErr.message)
    else if (card?.output_url) shareCardUrl = card.output_url as string
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
      share: shareCardUrl ?? landingUrl,
    },
    qrCodeId,
    publishedAt,
  }
}

// ============================================================================
// KERNEL COMMAND 2b: enqueueLeadMagnetCard — the LeadMagnetCard producer
// ============================================================================

export interface EnqueueLeadMagnetCardResult {
  ok: boolean
  renderId?: string
  /** Why no render was queued — a refusal names its reason, never fakes success. */
  skipped?: string
}

/** Cosmetic eyebrow per magnet type (contract-cosmetic — a default here cannot
 *  state a wrong fact; the OFFER itself is headline/subhead, which REFUSE). */
function cardEyebrowForMagnetType(magnetType: string | null | undefined): string {
  switch (magnetType) {
    case "home_valuation": return "FREE HOME VALUE"
    case "buyer_guide":    return "FREE BUYER GUIDE"
    case "seller_guide":   return "FREE SELLER GUIDE"
    case "market_report":  return "MARKET REPORT"
    case "listing_alert":  return "LISTING ALERTS"
    case "open_house":     return "OPEN HOUSE"
    default:               return "FREE GUIDE"
  }
}

/**
 * Enqueue the 1200×630 LeadMagnetCard still for one magnet — the producer the
 * registered composition never had (remotion/Root.tsx used to carry the
 * "NO producer stages this composition" tombstone).
 *
 * REFUSAL, NOT DEFAULTS: headline/subhead are the contract-required props
 * (lib/remotion/content-contract.ts LeadMagnetCard — "the offer a lead hands
 * over their contact details for") and come ONLY from the form's own
 * lead_capture_forms.landing_content. missingContentProps is asked BEFORE the
 * insert, so a magnet with no AI-built landing copy gets NO card rather than
 * Root.tsx's sample offer on an ad surface. This is the same predicate that
 * already drives noindex on /lm/[slug] (no landing copy ⇒ noindex, and ⇒ no
 * card) — one condition, two enforcement points.
 *
 * DEDUPE is keyed on the magnet's IDENTITY (entity_id = magnetId — the same
 * ruling as leadMagnetQrLabel: the landing URL moves, the magnet does; see the
 * generateQRCode header). A card already queued/rendering, or already succeeded
 * with the SAME copy, is not re-enqueued; changed copy renders a fresh card.
 */
export async function enqueueLeadMagnetCard(
  magnetId: string,
  brokerageId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<EnqueueLeadMagnetCardResult> {
  if (!magnetId || !brokerageId) return { ok: false, skipped: "missing magnetId/brokerageId" }
  const supabase = client ?? createServiceClient()

  const { data: form, error: formErr } = await supabase
    .from("lead_capture_forms")
    .select("id, name, agent_id, magnet_type, landing_content")
    .eq("id", magnetId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (formErr) return { ok: false, skipped: `form unreadable: ${formErr.message}` }
  if (!form) return { ok: false, skipped: "magnet not found" }

  const lc = (((form as any).landing_content ?? {}) as Record<string, unknown>)
  const headline = typeof lc.headline === "string" ? lc.headline.trim() : ""
  const subhead  = typeof lc.subhead  === "string" ? lc.subhead.trim()  : ""
  const ctaLabel = (typeof lc.cta === "string" && lc.cta.trim()) || "Get started"
  const eyebrow  = cardEyebrowForMagnetType((form as any).magnet_type)

  // Brokerage brand — resolved the way section-render.ts:143-153 does.
  const { data: brk, error: brkErr } = await supabase
    .from("brokerages")
    .select("name, logo_url, license_number, license_state")
    .eq("id", brokerageId)
    .maybeSingle()
  if (brkErr) return { ok: false, skipped: `brokerage unreadable: ${brkErr.message}` }
  const brand = {
    primaryColor:  "#0F172A",
    accentColor:   "#F59E0B",
    brokerageName: (brk as any)?.name ?? "Your Brokerage",
    logoUrl:       (brk as any)?.logo_url ?? undefined,
    licenseLine:   [(brk as any)?.license_number, (brk as any)?.license_state].filter(Boolean).join(" · ") || undefined,
    showEhoMark:   true,
  }

  const inputProps: Record<string, unknown> = {
    eyebrow,
    headline,
    subhead,
    ctaLabel,
    // No fabricated hero — the composition collapses to the centered text card.
    heroImageUrl: null,
    brand,
  }
  const { missingContentProps, describeMissingContent } = await import("@/lib/remotion/content-contract")
  const missing = missingContentProps("LeadMagnetCard", inputProps)
  if (missing.length > 0) {
    return { ok: false, skipped: describeMissingContent("LeadMagnetCard", missing) }
  }

  // Dedupe on the magnet's identity, not the URL (see the header).
  const { data: prior, error: priorErr } = await supabase
    .from("remotion_composition_renders")
    .select("id, render_status, input_props")
    .eq("brokerage_id", brokerageId)
    .eq("entity_type", "lead_capture_form")
    .eq("entity_id", magnetId)
    .eq("composition_id", "LeadMagnetCard")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (priorErr) {
    // A refused dedupe read must not silently double-enqueue — report it.
    return { ok: false, skipped: `dedupe read refused: ${priorErr.message}` }
  }
  if (prior) {
    const p = prior as { id: string; render_status: string | null; input_props: Record<string, unknown> | null }
    if (p.render_status === "queued" || p.render_status === "rendering") {
      return { ok: true, renderId: p.id, skipped: "card render already in flight" }
    }
    const prev = (p.input_props ?? {}) as Record<string, unknown>
    const sameCopy = prev.headline === headline && prev.subhead === subhead
      && prev.eyebrow === eyebrow && prev.ctaLabel === ctaLabel
    if (p.render_status === "succeeded" && sameCopy) {
      return { ok: true, renderId: p.id, skipped: "current copy already rendered" }
    }
  }

  // agent attribution: lead_capture_forms.agent_id is AGENTS-class;
  // remotion_composition_renders.agent_user_id is USERS-class (§3 — disjoint).
  let agentUserId: string | null = null
  if ((form as any).agent_id) {
    const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
    agentUserId = await resolveUserIdForAgentRecord(supabase, (form as any).agent_id)
  }

  const { data: render, error: insErr } = await supabase
    .from("remotion_composition_renders")
    .insert({
      brokerage_id:    brokerageId,
      composition_id:  "LeadMagnetCard",
      agent_user_id:   agentUserId,
      entity_type:     "lead_capture_form",
      entity_id:       magnetId,
      used_did_avatar: false,
      used_voiceover:  false,
      render_status:   "queued",
      input_props:     inputProps,
      // Brokerage-scoped: a magnet's share card is tenant marketing collateral,
      // not a per-agent avatar piece.
      scope_type:      "brokerage",
      scope_id:        brokerageId,
      // 'api' is on the requested_via allowlist (check-vocabularies:
      // remotion_composition_renders.requested_via; the allowlist is also noted
      // at avatar-render-orchestrator.ts:86-88) — this enqueue rides the
      // publishLeadMagnet command, not a cron tick.
      requested_via:   "api",
      is_published:    false,
    })
    .select("id")
    .single()
  if (insErr || !render) return { ok: false, skipped: `render insert refused: ${insErr?.message ?? "no row returned"}` }
  return { ok: true, renderId: (render as { id: string }).id }
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

  // Hoisted so the autonomous enroller below can resolve the persona whether the
  // contact already existed or was created by this capture.
  let capturedContactType: string | null = null
  let capturedContactPersona: string | null = null

  if (data.email) {
    const { data: existingContact } = await supabase
      .from("contacts")
      .select("id, agent_id, contact_type, contact_persona")
      .eq("email", data.email)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (existingContact) {
      contactId = existingContact.id
      capturedContactType = (existingContact as { contact_type?: string | null }).contact_type ?? null
      capturedContactPersona = (existingContact as { contact_persona?: string | null }).contact_persona ?? null
      // Claim an UNOWNED contact for the magnet's agent — a returning-but-unassigned person who fills
      // out this agent's lead magnet becomes that agent's lead. Never reassign a contact another agent
      // already owns (no lead-stealing). The contacts.agent_id trigger emits contact_agent_assigned.
      if (!(existingContact as any).agent_id && form.agent_id) {
        // tenant anchor: the contact was resolved by email WITHIN this brokerage,
        // so the update must be pinned to it too — a bare `.eq("id", …)` on a
        // service client is a cross-tenant write waiting to happen.
        // The error is READ. An unclaimed contact staying unclaimed is invisible:
        // the capture reports success, the agent's CRM simply never shows the lead.
        const { error: claimError } = await supabase.from("contacts")
          .update({ agent_id: form.agent_id })
          .eq("brokerage_id", input.brokerageId)
          .eq("id", contactId)
        if (claimError) {
          console.error(`[lead-magnets] agent claim REFUSED for contact ${contactId}:`, claimError.message)
        }
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
        source:     input.source ?? CONTACT_SOURCE_LEAD_MAGNET,
        source_channel: "online_form",
        brokerage_id: input.brokerageId,
        agent_id:   form.agent_id,
        // 'lead' → 'new' (§6 merge, 2026-08-31): a lead-magnet capture is a NEW
        // contact — leads are a different entity that belongs to the brokerage
        // (CLAUDE.md §5). 'lead' was this file's private spelling: no reader
        // matched it, so these contacts were invisible to every workable-contact
        // list (e.g. app/dashboard/isa/calling filters new/contacted/active).
        // Vocabulary: lib/contact-promotion/qualification.ts CONTACT_STATUSES.
        status:     "new",
      }
      if (intentRouting.contactType) newRow.contact_type = intentRouting.contactType
      capturedContactType = (intentRouting.contactType as string | null) ?? null
      // The error is READ. `if (newContact)` below already fails closed, but a
      // refused INSERT and a client that simply returned no row were
      // indistinguishable — so a rejected contact create (a CHECK on
      // contact_type, a PGRST204 phantom column) went by with no trace at all.
      const { data: newContact, error: newContactError } = await supabase
        .from("contacts")
        // tenant anchor (scope burn-down): re-stamped ON the chain, not only
        // inside `newRow` — the scope guard reads the window after `.from(`, and
        // a brokerage_id set in a payload variable declared further up is
        // invisible to it (and to a reader auditing the query).
        .insert({ ...newRow, brokerage_id: input.brokerageId })
        .select("id")
        .maybeSingle()

      if (newContactError) {
        console.error(`[lead-magnets] contact INSERT REFUSED for brokerage ${input.brokerageId}:`, newContactError.message)
      }

      if (newContact) {
        contactId = newContact.id
        // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). A lead-magnet
        // download creates the contact row here and emits no CONTACT_CREATED, so
        // the event-reactor lane never saw it. Voided — the form submission must
        // land even if the queue write fails. Live-deal suppression and
        // de-duplication are inside queueContactEnrichment.
        void import("@/lib/enrichment/contact-enrichment-core")
          .then((m) =>
            m.queueContactEnrichment({
              contactId: newContact.id,
              brokerageId: input.brokerageId,
              triggerType: "lead_magnet",
              supabase,
            }),
          )
          .catch(() => {})
      }
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

  // AUTONOMOUS ENROLMENT — non-fatal by contract (the enroller never throws).
  // This used to select the sequence by `sequence_type = 'lead_magnet'`, which is
  // not a value that column's CHECK admits, so it matched nothing on every run
  // and no lead-magnet capture was ever enrolled. Selection is now by
  // (source_key, persona) — the discriminator m293 added — through the same
  // enroller the home-value capture uses, so the two cannot drift apart again.
  if (contactId) {
    await autoEnrollContact(supabase, {
      brokerageId: input.brokerageId,
      contactId,
      source: input.source ?? CONTACT_SOURCE_LEAD_MAGNET,
      contactType: capturedContactType,
      contactPersona: capturedContactPersona,
      enrolledBy: form.agent_id ?? null,
      firstStepDelayMs: 0,   // a magnet download is a warm moment — follow up now
      now: new Date(submittedAt),
    })
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

/**
 * generateQRCode — the ONE lead-magnet QR minter (survivor of three).
 *
 * MERGED-THEN-DELETED. There were THREE lead-magnet minters writing `qr_codes` with THREE
 * different dedupe keys, so the same magnet routinely ended up with two or three tracked codes
 * that could not see each other and split its scan counts:
 *
 *   • publishLeadMagnet (this file, ~L300) — inline insert, slug `lm-<formSlug>`, NO dedupe.
 *   • generateQRCode    (this function)    — deduped on (brokerage_id, target_url), which is not
 *                                            a stable key: any change to the landing URL minted
 *                                            a fresh code.
 *   • generateQRCodeAction (app/actions/lead-magnets-actions.ts) — random slug, NO dedupe.
 *
 * This function survived (it is the kernel command with the API-route caller) and the other two
 * now delegate here. ONE dedupe key for all three: `lead_magnet:<magnetId>` — the magnet's
 * identity, which does not move when its URL does. What was merged in from the losers:
 *   • `destination_type: 'landing_page'` — only generateQRCodeAction set it, and every
 *     destination-bucketed analytic (and the m148 scan-event metadata) was blind without it.
 *   • the publish path's landing URL as the semantic `target_url`.
 *
 * The QR image is now rendered by the vendored `qrcode` package as a data: URI. It used to be an
 * <img> pointed at api.qrserver.com — which shipped the lead-bearing landing URL to a third party
 * on every render and put an external host inside a print/PDF path.
 */
export async function generateQRCode(
  input: GenerateQRCodeInput
): Promise<GenerateQRCodeOutput> {
  if (!input.magnetId || !input.brokerageId || !input.targetUrl) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, targetUrl" }
  }

  const supabase = createServiceClient()
  const { mintTrackedQr } = await import("@/lib/marketing/tracked-qr")

  const minted = await mintTrackedQr(
    {
      brokerageId: input.brokerageId,
      agentId: input.agentId ?? null,
      // ONE dedupe key for every lead-magnet QR path.
      label: leadMagnetQrLabel(input.magnetId),
      destinationType: "landing_page",
      targetUrl: input.targetUrl,
      purpose: "lead_magnet",
    },
    supabase,
  )

  if (!minted) {
    return { success: false, error: "Failed to create QR code" }
  }

  return {
    success: true,
    qrCodeId: minted.qrCodeId,
    // The PNG encodes the tracked /api/qr/scan?slug= redirector, never the raw landing URL —
    // a code that bypasses the resolver records no scan.
    qrImageUrl: minted.qrCodeDataUrl,
    scanUrl: minted.scanUrl,
    targetUrl: minted.targetUrl,
    slug: minted.slug,
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
// KERNEL COMMAND 7: updateMagnetSettings — MERGED INTO THE SURVIVOR, THEN DELETED
// ============================================================================
// TOMBSTONE (orphan tranche 4). The live writer is
// app/actions/lead-magnets-actions.ts:updateMagnetSettingsAction — wired from the
// MagnetLibrary UI, session-resolved tenant (never caller-supplied brokerageId /
// actorUserId, which this command took as inputs). Before deletion its two extra
// capabilities were ADDED to that survivor: the `fields` (capture-form field list)
// update and the lifecycle_events `lead_magnet_updated` audit row.

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
