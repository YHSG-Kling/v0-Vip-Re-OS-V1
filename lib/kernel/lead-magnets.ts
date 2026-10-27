// lib/kernel/lead-magnets.ts
// Kernel OS: Canonical Lead Magnet Commands
// No mocks, stubs, or placeholders. All operations read/write real Supabase data.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { CONTACT_SOURCE_LEAD_MAGNET } from "@/lib/campaigns/contact-sources"
import { autoEnrollContact } from "@/lib/campaign-sequences/auto-enroll"
import type { LandingContent } from "@/lib/marketing/lead-magnet-copy"
// Wave 141 (lane 141E): the attribution contract is PURE and shared with the ad writer and the public
// page (lib/lead-magnets/attribution.ts) — one spelling of the query string, sanitized here again.
import { sanitizeLeadMagnetAttribution, sourceChannelFor, touchpointChannelFor, type LeadMagnetAttribution } from "@/lib/lead-magnets/attribution"
// Wave 142 (lane 142E): the ONE "who fills this form" roster (pure module shared with the builder / review surfaces).
import { FORM_DECLARABLE_CONTACT_TYPES, declarableContactType } from "@/lib/lead-magnets/form-contact-types"
// Wave 144 (lane 144H, owner ruling 15 — "ALWAYS a humanized review after the draft"): the pure rule the book publish reads.
import { humanizedReviewState, humanizedReviewRefusal, type HumanizedReviewRecord } from "@/lib/lead-magnets/book-editorial"
// Wave 145 (lane 145G, owner ruling 19): a BOOK is its own entity (book_projects, m867); a capture form that DISTRIBUTES one
// carries settings.book_id only. The publish gate and the delivery read the distributed book through this ONE reader.
import { loadDistributedBook, saveBookRow } from "@/lib/lead-magnets/book-entity"
import { leadMagnetPublicText } from "@/lib/lead-magnets/public-text"
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

type Svc = ReturnType<typeof createServiceClient>

/**
 * THE CLIENT SEAM (wave 141, lane 141E — the wave-95 lesson: a seam, never a baseline bump). A caller
 * that already holds the verified client its command writes through (an in-memory proof client, an
 * injected service client) passes it; the default is the service client, exactly as before.
 */
interface LeadMagnetClientOpts {
  client?: Svc
  /**
   * @proofSeam the ONE tracked-QR minter (lib/marketing/tracked-qr.ts mintTrackedQr) is `server-only`;
   * scripts/lead-magnet-creation-guard.ts injects a fake that writes qr_codes on the same in-memory
   * client to prove the publish → QR hook. Production never passes it (the real minter is imported).
   */
  mintTrackedQr?: LeadMagnetQrMinter
}

/** The slice of mintTrackedQr's contract the lead-magnet paths use (structural — no import of the server-only module). */
type LeadMagnetQrMinter = (
  args: { brokerageId: string; agentId: string | null; label: string; destinationType: "landing_page"; targetUrl: string; purpose: "lead_magnet" },
  svc: Svc,
) => Promise<{ qrCodeId: string; slug: string; scanUrl: string; targetUrl: string; qrCodeDataUrl: string } | null>

/** One capture-form field — the shape lead_capture_forms.fields stores and the public forms render. */
export interface LeadMagnetField {
  name: string
  label: string
  type: string
  required: boolean
  options?: string[]
  placeholder?: string
}

export interface CreateLeadMagnetInput {
  title: string
  description: string
  magnetType: "home_valuation" | "buyer_guide" | "seller_guide" | "market_report" | "listing_alert" | "open_house" | "generic_form"
  brokerageId: string
  agentId: string
  createdBy: string
  fields?: LeadMagnetField[]
  tcpaDisclosureText?: string
  thankYouMessage?: string
  redirectUrl?: string
  /**
   * Wave 141 (lane 141E): "draft" creates the row INACTIVE — unreachable publicly (/lm/[slug] serves
   * active forms; a tenant member previews it with ?preview=1), refusing submissions (captureFormSubmission
   * checks is_active) — until publishLeadMagnet, the human approval, activates it. The default "live" keeps
   * the programmatic callers (launch war room, playbook installs) byte-for-byte unchanged.
   */
  publishState?: "draft" | "live"
  /** The AI-built landing surface persisted with the row (the shape /lm/[slug] renders). */
  landingContent?: LandingContent | null
  /** Merged into lead_capture_forms.settings — authoring (AI vs human), provenance (clone), notify flag. */
  settings?: Record<string, unknown>
}

export interface CreateLeadMagnetOutput {
  success: boolean
  magnetId?: string
  slug?: string
  formId?: string
  lifecycleState?: "draft" | "published"
  error?: string
}

/** What lead_capture_forms.settings.lifecycle records — ONE spelling for the writer (create / publish) and
 *  the readers (listLeadMagnets, the library, the draft review). */
interface LeadMagnetLifecycle {
  state: "draft" | "published"
  created_at: string
  published_at: string | null
  /** users.id of the human who published (the approval authority); null while a draft. */
  approved_by: string | null
  channels?: string[]
}

interface CloneLeadMagnetInput {
  sourceMagnetId: string
  brokerageId: string
  agentId: string
  createdBy: string
  /** Optional new name; default "Copy of <source name>". */
  title?: string
}

interface CloneLeadMagnetOutput extends CreateLeadMagnetOutput {
  clonedFromId?: string
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

/**
 * Wave 142 (lane 142E — the Forms Manager / lead-magnet merge): the contact types a FORM may DECLARE for
 * its submitters (lead_capture_forms.settings.default_contact_type). Honoured only when the magnet's own
 * intent (classifyMagnetIntent) says nothing — a generic form. The roster lives in the pure module
 * lib/lead-magnets/form-contact-types.ts (shared with the builder / review surfaces); re-exported here so
 * the kernel's callers read it from the kernel. An unrecognised value is dropped (an INSERT the CHECK
 * refuses would lose the whole capture).
 */
export { FORM_DECLARABLE_CONTACT_TYPES }

/** The book a buyer/seller-guide magnet delivers instead of the 5-chapter booklet (lib/lead-magnets/book-creator.ts). */
export interface LeadMagnetBookRef {
  pdfUrl: string
  documentId: string | null
  title: string
  chapters: number
}

export interface CaptureFormSubmissionInput {
  formId: string
  brokerageId: string
  submissionData: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  tcpaConsentGiven?: boolean
  source?: string
  /**
   * Wave 142: the intake-time locale the DOOR resolved (lib/contact-pipeline/contact-capture.ts
   * resolveCapturedLanguage — the ONE resolver; form field, else Accept-Language, both mapped). Stamped on a
   * NEW contact as contacts.metadata.captured_language, the same place captureContact writes it; never
   * overwrites an existing contact's.
   */
  language?: string | null
  /**
   * Wave 141 (lane 141E): where the visitor came from (campaign / ad campaign / creative / QR / utm).
   * Sanitized again here; `campaignId` is VERIFIED against the magnet's own tenant before anything is
   * stamped — a query-string id never vouches for itself (CLAUDE.md §4).
   */
  attribution?: LeadMagnetAttribution | null
}

export interface CaptureFormSubmissionOutput {
  success: boolean
  submissionId?: string
  contactId?: string
  /** The person behind the capture (wave 102.1 identity layer), null when nothing anchored one. */
  personId?: string | null
  capturedAt?: string
  /** What was actually kept: the verified campaign (or null when it was not this tenant's) + the rest. */
  attribution?: (LeadMagnetAttribution & { campaignVerified: boolean; touchpointId: string | null }) | null
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

/**
 * PURE (wave 142): the FINISHED book a magnet distributes, read from `{ book: project }` — since wave 145 the project is the
 * distributed book's own record (book_projects.project, read through lib/lead-magnets/book-entity.ts loadDistributedBook); only a
 * project that reached ready_for_review with a hosted PDF counts; anything earlier is null (the booklet
 * path stands in). One reader for the capture (delivery) and the review surface. @proofSeam asserted directly.
 */
export function leadMagnetBookRefOf(settings: Record<string, unknown> | null | undefined): LeadMagnetBookRef | null {
  const book = ((settings ?? {}) as Record<string, unknown>).book as Record<string, unknown> | null | undefined
  if (!book || typeof book !== "object") return null
  if (book.stage !== "ready_for_review" || typeof book.pdf_url !== "string" || !book.pdf_url) return null
  const chapters = Array.isArray(book.chapters) ? book.chapters.length : 0
  return { pdfUrl: book.pdf_url, documentId: typeof book.document_id === "string" ? book.document_id : null, title: String(book.title ?? "Your guide"), chapters }
}

export interface TrackMagnetEventInput {
  magnetId: string
  /**
   * OPTIONAL, and NEVER the tenant authority. The tenant an event is stamped
   * to is derived from the magnet's own lead_capture_forms row (§4: the caller's
   * parameter cannot vouch for itself). When supplied it must AGREE with that
   * row or the event is refused — it exists so a caller that already validated
   * the pair (captureFormSubmission did) can assert it, not so an anonymous
   * scan reporter can choose which brokerage's ledger it writes into.
   */
  brokerageId?: string
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
    /** Ad-ATTRIBUTED conversions (wave 141E): touchpoints this magnet converted, read from
     *  marketing_campaign_touchpoints.converted_at — the campaign the capture was verified against. */
    attributedConversions: { total: number; byCampaign: Array<{ campaignId: string; count: number; lastConvertedAt: string }> }
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
    /** Wave 141: draft (never published) vs published (may still be paused via isActive=false). */
    lifecycleState: "draft" | "published"
    /** "ai" when draftLeadMagnetFromConcept authored it, "human" otherwise. */
    authoredBy: "ai" | "human"
    /** Clone provenance — the magnet this one was cloned from (same tenant), else null. */
    clonedFromId: string | null
    clonedFromName: string | null
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

/** The canonical fields per magnet type — the identity fields every capture needs plus the type's own
 *  qualifiers. Exported (wave 141) for the AI draft composer (lib/lead-magnets/ai-draft.ts) and the
 *  builder action, which ADD a tenant's extra questions on top and never remove these. */
export function defaultFieldsForType(
  magnetType: CreateLeadMagnetInput["magnetType"]
): LeadMagnetField[] {
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
  input: CreateLeadMagnetInput,
  opts: LeadMagnetClientOpts = {},
): Promise<CreateLeadMagnetOutput> {
  if (!input.title || !input.brokerageId || !input.agentId || !input.createdBy) {
    return { success: false, error: "Missing required fields: title, brokerageId, agentId, createdBy" }
  }

  const supabase = opts.client ?? createServiceClient()
  const slug = generateSlug(input.title)
  const fields = input.fields?.length ? input.fields : defaultFieldsForType(input.magnetType)
  const isDraft = input.publishState === "draft"
  const nowIso = new Date().toISOString()
  // ONE lifecycle record (settings.lifecycle) — the draft/published fact a paused (is_active=false)
  // published magnet and a never-published draft would otherwise share.
  const lifecycle: LeadMagnetLifecycle = { state: isDraft ? "draft" : "published", created_at: nowIso, published_at: isDraft ? null : nowIso, approved_by: isDraft ? null : input.createdBy }
  const settings: Record<string, unknown> = { ...(input.settings ?? {}), lifecycle }
  const authoredBy = (settings.authoring as { by?: string } | undefined)?.by === "ai" ? "ai" : "human"

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
      landing_content: input.landingContent ?? null,
      settings,
      is_active: !isDraft,
      submission_count: 0,
    })
    .select("id, slug")
    .maybeSingle()

  if (formError || !form) {
    return { success: false, error: formError?.message ?? "Failed to create form" }
  }

  // 2. Log lifecycle event (on the SAME client the row landed on — the 101C seam)
  await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    entityType: "lead_capture_form",
    entityId: form.id,
    event: "lead_magnet_created",
    actorUserId: input.createdBy,
    brokerageId: input.brokerageId,
    metadata: { magnetType: input.magnetType, title: input.title, lifecycleState: lifecycle.state, authoredBy, clonedFromId: (settings.provenance as { cloned_from_id?: string } | undefined)?.cloned_from_id ?? null },
    client: supabase,
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  return {
    success: true,
    magnetId: form.id,
    slug: form.slug,
    formId: form.id,
    lifecycleState: lifecycle.state,
  }
}

// ============================================================================
// KERNEL COMMAND 1b: cloneLeadMagnet — tenants clone / customize an approved magnet (provenance kept)
// ============================================================================

/**
 * Wave 141 (lane 141E, owner: "tenants clone/customize approved assets"). A clone is a NEW DRAFT row
 * (the human edits, then publishes it — the same approval as any draft) carrying the source's fields,
 * landing copy, consent text and thank-you, with provenance recorded on settings.provenance
 * (cloned_from_id / cloned_from_slug / cloned_by / cloned_at). TENANT-PINNED: the source is read by id AND
 * brokerage_id — another tenant's magnet is simply absent (refused, never copied across).
 */
export async function cloneLeadMagnet(
  input: CloneLeadMagnetInput,
  opts: LeadMagnetClientOpts = {},
): Promise<CloneLeadMagnetOutput> {
  if (!input.sourceMagnetId || !input.brokerageId || !input.agentId || !input.createdBy) {
    return { success: false, error: "Missing required fields: sourceMagnetId, brokerageId, agentId, createdBy" }
  }
  const supabase = opts.client ?? createServiceClient()
  const { data: source, error: srcErr } = await supabase
    .from("lead_capture_forms")
    .select("id, name, slug, fields, magnet_type, tcpa_disclosure_text, thank_you_message, redirect_url, landing_content, settings")
    .eq("id", input.sourceMagnetId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (srcErr) return { success: false, error: `Source magnet unreadable: ${srcErr.message}` }
  if (!source) return { success: false, error: "Source magnet not found in this brokerage" }

  const src = source as { id: string; name: string; slug: string; fields: LeadMagnetField[] | null; magnet_type: string | null; tcpa_disclosure_text: string | null; thank_you_message: string | null; redirect_url: string | null; landing_content: LandingContent | null; settings: Record<string, unknown> | null }
  const srcSettings = (src.settings ?? {}) as Record<string, unknown>
  const magnetType = (src.magnet_type ?? "generic_form") as CreateLeadMagnetInput["magnetType"]
  const landing = src.landing_content && typeof src.landing_content === "object"
    ? ({ ...src.landing_content, videoUrl: null, videoProjectId: null } as LandingContent) // the source's rendered video is its own asset, never inherited
    : null
  const created = await createLeadMagnet({
    title: input.title?.trim() || `Copy of ${src.name}`,
    description: "",
    magnetType,
    brokerageId: input.brokerageId,
    agentId: input.agentId,
    createdBy: input.createdBy,
    fields: Array.isArray(src.fields) && src.fields.length > 0 ? src.fields : undefined,
    tcpaDisclosureText: src.tcpa_disclosure_text ?? undefined,
    thankYouMessage: src.thank_you_message ?? undefined,
    redirectUrl: src.redirect_url ?? undefined,
    publishState: "draft",
    landingContent: landing,
    settings: {
      // The notify preference travels with the clone; lifecycle is re-minted by createLeadMagnet.
      ...(typeof srcSettings.notify_on_submission === "boolean" ? { notify_on_submission: srcSettings.notify_on_submission } : {}),
      authoring: { by: "human", cloned: true, source_authoring: srcSettings.authoring ?? null },
      provenance: { cloned_from_id: src.id, cloned_from_slug: src.slug, cloned_from_name: src.name, cloned_by: input.createdBy, cloned_at: new Date().toISOString() },
    },
  }, { client: supabase })
  if (!created.success || !created.magnetId) return created

  await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    entityType: "lead_capture_form",
    entityId: created.magnetId!,
    event: "lead_magnet_cloned",
    actorUserId: input.createdBy,
    brokerageId: input.brokerageId,
    metadata: { clonedFromId: src.id, clonedFromSlug: src.slug, magnetType },
    auditOnly: true,
    client: supabase,
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  return { ...created, clonedFromId: src.id }
}

// ============================================================================
// KERNEL COMMAND 2: publishLeadMagnet
// ============================================================================

export async function publishLeadMagnet(
  input: PublishLeadMagnetInput,
  opts: LeadMagnetClientOpts = {},
): Promise<PublishLeadMagnetOutput> {
  if (!input.magnetId || !input.brokerageId || !input.baseUrl) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, baseUrl" }
  }
  if (!input.actorUserId) {
    // Publishing is the HUMAN APPROVAL of a draft (wave 141): a public page goes live and starts
    // accepting submissions. An approval with no approver is not evidence — refused, never assumed.
    return { success: false, error: "Publishing needs an approving user (actorUserId)" }
  }

  const supabase = opts.client ?? createServiceClient()

  // Fetch the form to get slug
  const { data: form, error: fetchError } = await supabase
    .from("lead_capture_forms")
    .select("id, slug, agent_id, settings")
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

  // EVIDENCE (LAW 5): the approval leaves a ledger row — who published, which channels, what URL —
  // recorded around the activation itself (recording-only claim: a re-publish is a new record, not a replay).
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const curSettings = (((form as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>)

  // THE HUMAN'S PUBLISH IS THE LAST FAIR-HOUSING GATE (wave 142, lane 142E). Whatever the reviewer edited the
  // public copy into is scanned once more here — the ONE pattern list + the public gate's blockers — and a
  // hard flag REFUSES the publish naming the findings. Warnings pass through (CLAUDE.md §5). A magnet with
  // no landing copy has nothing public to scan beyond its name and thank-you line.
  let pagePublicText = ""
  {
    const { data: pageRow, error: pageErr } = await supabase
      .from("lead_capture_forms")
      .select("name, thank_you_message, landing_content")
      .eq("id", input.magnetId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (pageErr) return { success: false, error: `Could not read the page copy before publishing: ${pageErr.message}` }
    // ONE composition of the page's public words (lib/lead-magnets/public-text.ts — wave 145): the text scanned here is the
    // text the AI draft's final phase recorded and the text the version ledger below proves went out.
    const publicText = leadMagnetPublicText(pageRow as Parameters<typeof leadMagnetPublicText>[0])
    pagePublicText = publicText
    const { scanPublicCopy } = await import("@/lib/kernel/marketing/public-copy-rewrite")
    // Wave 143 (lane 143F): a "55+ / senior living" claim passes ONLY against the tenant's recorded, verified
    // housing-for-older-persons exemption for the community the page names (42 U.S.C. § 3607(b)); an unreadable
    // record holds the claim — the human's publish never approves an unverified exemption.
    const { loadOlderPersonsVerifications } = await import("@/lib/compliance/fair-housing-older-persons-store")
    const olderPersons = await loadOlderPersonsVerifications(supabase as never, input.brokerageId)
    const scan = await scanPublicCopy(publicText, "lead_magnet", { olderPersons })
    if (!scan.ok) {
      return { success: false, error: `Fair-housing review: the page copy still says ${scan.findings.map((f) => `"${f.phrase}"`).join(", ")} — rewrite it (${scan.findings.map((f) => f.fix).join("; ")}) before publishing.` }
    }
  }

  // A BOOK MAGNET PUBLISHES ONLY WITH ITS FINISHED, REVIEWABLE BOOK (wave 142): a half-written manuscript has
  // no deliverable, so the page would promise a book the capture cannot send. Fail closed, name the stage.
  let bookSignOff: HumanizedReviewRecord | null = null
  // The book this form DISTRIBUTES (wave 145 — its own row). An unreadable book FAILS CLOSED: a page that promises a book is
  // never published on a gate that could not read the book.
  const distributed = await loadDistributedBook(supabase as never, input.brokerageId, input.magnetId, curSettings)
  if (distributed.error) return { success: false, error: `The book this lead magnet distributes could not be read — not published: ${distributed.error}` }
  {
    const book = (distributed.book?.project ?? null) as { stage?: string; needs_human_review?: number[]; chapters?: Array<{ body?: string; edited?: { human_revised_at?: string } }> } | null
    if (book && typeof book === "object" && book.stage && book.stage !== "ready_for_review") {
      return { success: false, error: `The book is still being written (stage: ${book.stage.replace(/_/g, " ")}) — finish it before publishing this lead magnet.` }
    }
    // A chapter the AI could not make compliant within its cap is the HUMAN's to rewrite (reviseBookChapter) —
    // until then the PDF still carries the steering text, so the publish fails closed naming the chapters.
    if (book && typeof book === "object" && Array.isArray(book.needs_human_review) && book.needs_human_review.length > 0) {
      const n = book.needs_human_review.length
      return { success: false, error: `Fair-housing review: chapter${n === 1 ? "" : "s"} ${book.needs_human_review.join(", ")} of the book still need${n === 1 ? "s" : ""} your rewrite (the AI reached its cap) — revise ${n === 1 ? "it" : "them"} before publishing.` }
    }
    // THE HUMANIZED REVIEW (wave 144): an AI-drafted chapter that still reads machine-written is the HUMAN's to rewrite in
    // their own voice before the book goes out; the reviewer's publish is then the sign-off, recorded on the BOOK's own row
    // (book_projects.project.humanized_review — any later revision clears it) by a counted write before the page activates.
    if (book && typeof book === "object" && Array.isArray(book.chapters)) {
      const review = humanizedReviewState(book.chapters)
      if (!review.ready) return { success: false, error: humanizedReviewRefusal(review) }
      bookSignOff = { by: input.actorUserId, at: publishedAt, basis: "lead_magnet_publish", chapters_human_revised: review.humanRevised, ai_tells_open: 0 }
    }
  }
  // THE VERSION THAT GOES OUT (wave 145, lane 145G — owner ruling 20 / contract C4): the page about to go live is checked
  // against the humanized final the AI draft recorded (distribution_finals, lib/marketing/humanize-final.ts): byte-for-byte the
  // staged final, or the reviewer's OWN edit — which must keep every disclosure the final carried and no word the brand
  // prohibits (fair housing was scanned above). This publish is the human approval. FAIL CLOSED: an unreadable ledger refuses.
  const hf = await import("@/lib/marketing/humanize-final")
  const { resolveBrandVoiceCore } = await import("@/lib/kernel/brand-voice")
  const pageVoice = await resolveBrandVoiceCore(supabase as never, { brokerageId: input.brokerageId, actorUserId: input.actorUserId })
  const versionInput = {
    brokerageId: input.brokerageId, assetKind: "lead_magnet" as const, assetTable: "lead_capture_forms", assetId: input.magnetId,
    content: pagePublicText, approval: { approved: true, by: input.actorUserId, at: publishedAt },
    tenantBrand: { prohibitedWords: pageVoice.prohibitedWords, preferredWords: pageVoice.preferredWords },
  }
  const versionCheck = await hf.checkDistributionPublication(supabase as never, versionInput)
  if (!versionCheck.ok) return { success: false, error: `Not published — ${versionCheck.reason}` }

  const prevLifecycle = (curSettings.lifecycle ?? {}) as Partial<LeadMagnetLifecycle>
  const lifecycle: LeadMagnetLifecycle = {
    state: "published",
    created_at: prevLifecycle.created_at ?? publishedAt,
    published_at: publishedAt,
    approved_by: input.actorUserId,
    channels: input.channels,
  }
  const activation = await withActionLedger<{ ok: true } | { ok: false; error: string }>(
    {
      brokerageId: input.brokerageId,
      action: "marketing.lead_magnet.publish",
      actor: { type: "user", userId: input.actorUserId },
      subject: { type: "lead_capture_form", id: input.magnetId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `human approval: publish lead magnet ${form.slug} to ${input.channels.join(", ")}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "lead_magnets",
      detail: { channels: input.channels, landingUrl, authoring: curSettings.authoring ?? null, provenance: curSettings.provenance ?? null },
    },
    async () => {
      // The humanized-review sign-off lands on the BOOK first (counted): a page never activates on an unrecorded sign-off.
      if (bookSignOff && distributed.book) {
        const signed = await saveBookRow(supabase as never, input.brokerageId, distributed.book.id, { project: { ...distributed.book.project, humanized_review: bookSignOff }, updatedAt: publishedAt })
        if (signed) return { ok: false as const, error: `The book's humanized-review sign-off was not recorded — not published: ${signed}` }
      }
      // Activate the form + record the approval on ONE row (a COUNTED update — CLAUDE.md §3).
      const { data: activated, error: activateErr } = await supabase
        .from("lead_capture_forms")
        .update({ is_active: true, settings: { ...curSettings, lifecycle }, updated_at: publishedAt })
        .eq("brokerage_id", input.brokerageId)
        .eq("id", input.magnetId)
        .select("id")
      if (activateErr) return { ok: false as const, error: `Could not activate the lead magnet: ${activateErr.message}` }
      if ((activated ?? []).length !== 1) return { ok: false as const, error: "Could not activate the lead magnet: no row matched this brokerage + id" }
      return { ok: true as const }
    },
    {
      settle: (r) => r.ok ? { status: "executed", outcome: "published", providerRef: form.slug } : { status: "failed", outcome: "activate_refused", error: r.error },
      replay: (claim) => ({ ok: false as const, error: `ledger refused the publish: ${claim.kind}` }),
    },
    { client: supabase as any },
  )
  if (!activation.ok) return { success: false, error: activation.error }

  // RECORD WHAT WENT LIVE (C4): the approved final marked published — or the reviewer's edit as its own version (basis
  // human_edit). The page is already live, so a lost record is logged loudly, never an unwound publish.
  {
    const rec = await hf.recordDistributionPublication(supabase as never, { ...versionInput, via: "lead_magnet_page", ref: form.slug, now: new Date(publishedAt) })
    if (!rec.ok) console.error("[publishLeadMagnet] the published version was NOT recorded:", rec.error)
  }

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
    }, { client: supabase, mintTrackedQr: opts.mintTrackedQr })
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
    // Best-effort by contract: a producer that THROWS (a module it needs cannot load) is the same
    // honest refusal as one that returns skipped — the publish already landed and must not unwind.
    const cardResult = await enqueueLeadMagnetCard(input.magnetId, input.brokerageId, supabase)
      .catch((e: unknown) => ({ ok: false as const, skipped: `card producer threw: ${(e as Error)?.message ?? String(e)}` }))
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
  await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    entityType: "lead_capture_form",
    entityId: input.magnetId,
    event: "lead_magnet_published",
    actorUserId: input.actorUserId,
    brokerageId: input.brokerageId,
    metadata: { channels: input.channels, landingUrl, publishedAt, approvedBy: input.actorUserId },
    client: supabase,
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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

interface EnqueueLeadMagnetCardResult {
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
 * Wave 102.1 identity evidence for a public form capture. Mirrors lib/contact-pipeline/contact-capture.ts
 * recordCapturePersonEvidence (the identity layer every capture door shares): resolve ONCE, link the contact
 * (capture_match) and the submission row on the same person. A refusal is SAID (console) and the capture is
 * unaffected — identity is evidence, never a gate.
 */
async function recordFormCapturePersonEvidence(
  supabase: any,
  args: { brokerageId: string; contactId: string | null; submissionId: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null },
): Promise<string | null> {
  try {
    const { resolvePerson, linkPersonEvidence } = await import("@/lib/kernel/person-identity")
    const { KernelEvent } = await import("@/lib/kernel/events")
    const person = await resolvePerson(supabase, {
      brokerageId: args.brokerageId,
      firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone,
    })
    if (!person.ok) {
      if (person.reason !== "no_identity_anchor") console.warn(`[lead-magnets] person identity not resolved: ${person.reason}`)
      return null
    }
    if (args.contactId) {
      const c = await linkPersonEvidence(supabase, {
        brokerageId: args.brokerageId, personId: person.personId,
        entityType: "contact", entityId: args.contactId, matchMethod: "capture_match", matchScore: 1,
        source: "form_submit", actor: { type: "system", userId: null }, identity: person.identity,
        existingEvent: KernelEvent.CONTACT_CAPTURED,
      })
      if (!c.ok) console.warn(`[lead-magnets] contact person evidence not recorded: ${c.reason}`)
    }
    const sub = await linkPersonEvidence(supabase, {
      brokerageId: args.brokerageId, personId: person.personId,
      entityType: "form_submission", entityId: args.submissionId, matchMethod: "capture_match", matchScore: 1,
      source: "form_submit", actor: { type: "system", userId: null }, identity: person.identity,
      existingEvent: KernelEvent.FORM_SUBMISSION_RECEIVED,
    })
    if (!sub.ok) console.warn(`[lead-magnets] submission person evidence not recorded: ${sub.reason}`)
    return person.personId
  } catch (err) {
    console.warn("[lead-magnets] person identity threw (submission unaffected):", err instanceof Error ? err.message : String(err))
    return null
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
// Module-private since 2026-09-08 — no importer outside this file; outside mentions are prose (category B tranche 2).
async function enqueueLeadMagnetCard(
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
  input: CaptureFormSubmissionInput,
  opts: LeadMagnetClientOpts = {},
): Promise<CaptureFormSubmissionOutput> {
  if (!input.formId || !input.brokerageId || !input.submissionData) {
    return { success: false, error: "Missing required fields: formId, brokerageId, submissionData" }
  }

  const supabase = opts.client ?? createServiceClient()
  const submittedAt = new Date().toISOString()

  // Verify form exists and is active
  const { data: form, error: formError } = await supabase
    .from("lead_capture_forms")
    .select("id, is_active, agent_id, magnet_type, name, settings, landing_content, tcpa_disclosure_text")
    .eq("id", input.formId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()

  if (formError || !form) {
    return { success: false, error: "Form not found or inaccessible" }
  }

  if (!form.is_active) {
    // A DRAFT (never published) and a paused magnet refuse alike — fail closed (wave 141: the draft the
    // AI wrote is a real row, and this is what keeps it from capturing before a human approves it).
    return { success: false, error: "This form is no longer accepting submissions" }
  }

  // ── ATTRIBUTION (wave 141, lane 141E) ──────────────────────────────────────
  // Sanitized again (the public door and the action both pass it; a forged in-process shape is cleaned
  // the same way a query string is). The campaign id is VERIFIED against the magnet's tenant before it
  // can be stamped anywhere: a campaign_attribution_id pointing at another brokerage's campaign would
  // credit that tenant's spend with this tenant's lead. Not this tenant's → dropped, logged, capture
  // continues with the rest of the attribution (utm / creative / qr are inert strings).
  const attribution = sanitizeLeadMagnetAttribution(input.attribution)
  let verifiedCampaignId: string | null = null
  if (attribution?.campaignId) {
    const { data: campaignRow, error: campaignErr } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", attribution.campaignId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (campaignErr) console.warn("[lead-magnets] attribution campaign read refused:", campaignErr.message)
    if (campaignRow?.id) verifiedCampaignId = campaignRow.id as string
    else console.warn(`[lead-magnets] attribution campaign ${attribution.campaignId} is not this brokerage's — dropped`)
  }
  const consentText = ((form as { tcpa_disclosure_text?: string | null }).tcpa_disclosure_text ?? "By submitting this form, you consent to receive communications from us. You may opt out at any time.")

  // TCPA CONSENT IS REQUIRED ON A VALUATION FORM — ONE RULE, IN THE KERNEL.
  // A submission carrying a property address is a home-value request and will
  // be worked by phone/text, so it may not be recorded without consent. This
  // rule used to live only in the public HTTP door
  // (app/api/lead-magnets/submissions/route.ts), which meant the in-app door
  // (app/actions/lead-magnet-capture.ts, the one /lm/[slug] actually uses)
  // recorded consent-less valuation requests the API would have refused. Both
  // doors now get the same answer from the same place, and the consent record
  // (form_submissions.tcpa_consent_given below) means the same thing on both.
  if ("property_address" in input.submissionData && !input.tcpaConsentGiven) {
    return { success: false, error: "TCPA consent required for this form" }
  }

  // Try to match or create a contact from submission data
  const data = input.submissionData as Record<string, string>
  let contactId: string | undefined

  // Hoisted so the autonomous enroller below can resolve the persona whether the
  // contact already existed or was created by this capture.
  let capturedContactType: string | null = null
  let capturedContactPersona: string | null = null

  // The TCPA consent on the submission becomes a CONTACT-level consent artifact only when there is a
  // phone to consent for (TCPA governs calls/texts) — the same column set persistContactConsent and the
  // ad-lead intake stamp, so every consent reader (ISA gates, SMS dispatch) sees one vocabulary.
  const consentForPhone = input.tcpaConsentGiven === true && !!data.phone
  const consentCols = consentForPhone
    ? { tcpa_consent: true, tcpa_consent_at: submittedAt, tcpa_consent_date: submittedAt, tcpa_consent_text: consentText, tcpa_consent_source: "lead_magnet", tcpa_consent_ip: input.ipAddress ?? null }
    : null

  if (data.email || data.phone) {
    // DEDUP within the tenant: email first, then phone (the ad-lead intake's order — one rule).
    type ExistingContact = { id: string; agent_id?: string | null; contact_type?: string | null; contact_persona?: string | null; campaign_attribution_id?: string | null; tcpa_consent?: boolean | null }
    let existingContact: ExistingContact | null = null
    if (data.email) {
      const { data: byEmail, error: byEmailErr } = await supabase
        .from("contacts")
        .select("id, agent_id, contact_type, contact_persona, campaign_attribution_id, tcpa_consent")
        .eq("email", data.email)
        .eq("brokerage_id", input.brokerageId)
        .maybeSingle()
      if (byEmailErr) console.warn("[lead-magnets] contact email lookup refused:", byEmailErr.message)
      existingContact = (byEmail as ExistingContact | null) ?? null
    }
    if (!existingContact && data.phone) {
      const { data: byPhone, error: byPhoneErr } = await supabase
        .from("contacts")
        .select("id, agent_id, contact_type, contact_persona, campaign_attribution_id, tcpa_consent")
        .eq("phone", data.phone)
        .eq("brokerage_id", input.brokerageId)
        .maybeSingle()
      if (byPhoneErr) console.warn("[lead-magnets] contact phone lookup refused:", byPhoneErr.message)
      existingContact = (byPhone as ExistingContact | null) ?? null
    }

    if (existingContact) {
      contactId = existingContact.id
      capturedContactType = (existingContact as { contact_type?: string | null }).contact_type ?? null
      capturedContactPersona = (existingContact as { contact_persona?: string | null }).contact_persona ?? null
      // FIRST-TOUCH attribution stays; a returning contact with none yet gets this campaign. Consent is
      // UPGRADED (never revoked) when this submission consented and the contact had not.
      const upgrade: Record<string, unknown> = {}
      if (verifiedCampaignId && !existingContact.campaign_attribution_id) upgrade.campaign_attribution_id = verifiedCampaignId
      if (consentCols && existingContact.tcpa_consent !== true) Object.assign(upgrade, consentCols)
      if (Object.keys(upgrade).length > 0) {
        const { error: upgradeErr } = await supabase.from("contacts")
          .update(upgrade)
          .eq("brokerage_id", input.brokerageId)
          .eq("id", contactId)
        if (upgradeErr) console.error(`[lead-magnets] attribution/consent upgrade REFUSED for contact ${contactId}:`, upgradeErr.message)
      }
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
        email:      data.email ?? null,
        phone:      data.phone ?? null,
        source:     input.source ?? CONTACT_SOURCE_LEAD_MAGNET,
        // 'online_form' as before; 'paid_ad' / 'qr_code' only when the attribution proves the arrival.
        source_channel: sourceChannelFor(attribution),
        // The VERIFIED campaign (this tenant's) — the first-touch stamp the acquisition-cost and
        // network-benchmark readers key on. Null when none / not ours.
        campaign_attribution_id: verifiedCampaignId,
        ...(consentCols ?? {}),
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
      // Wave 142: the form's DECLARED persona (settings.default_contact_type — the Forms Manager's one unique
      // piece, merged onto this kernel) fills in only when the magnet type itself says nothing.
      const declaredType = declarableContactType((((form as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>).default_contact_type)
      const resolvedContactType = intentRouting.contactType ?? declaredType
      if (resolvedContactType) newRow.contact_type = resolvedContactType
      capturedContactType = resolvedContactType
      if (input.language) newRow.metadata = { captured_language: input.language }
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
      // The arrival channel, written (wave 141) — it was a live column with a reader (person-timeline)
      // and no writer, and getMagnetPerformance.topSources fabricated a 50/50 split in its place.
      source: input.source ?? (attribution ? sourceChannelFor(attribution) : null),
      submitted_at: submittedAt,
    })
    .select("id")
    .maybeSingle()

  if (subError || !submission) {
    return { success: false, error: subError?.message ?? "Failed to record submission" }
  }

  // Increment submission count on form (atomic — avoids read-modify-write races)
  await supabase.rpc("increment_form_submission_count", { form_id_input: input.formId })

  // PERSON IDENTITY (wave 102.1) — merged onto this kernel command at wave-142 integration from the retired
  // /api/forms/submit capture path (lane 142E consolidated the route here; the kernel's contact path never resolved
  // a person). ONE resolve; the CONTACT (capture_match) and the SUBMISSION row linked on the same person; person_id
  // rides FORM_SUBMISSION_RECEIVED through the output. Best-effort: never blocks the capture.
  const personId = await recordFormCapturePersonEvidence(supabase, {
    brokerageId: input.brokerageId, contactId: contactId ?? null, submissionId: submission.id,
    firstName: data.first_name ?? null, lastName: data.last_name ?? null, email: data.email ?? null, phone: data.phone ?? null,
  })

  // CONSENT ARTIFACT (wave 141): the audit row the compliance surfaces read — the same table and
  // vocabulary the ad-lead intake (consent_source 'ad_lead_form') and persistContactConsent write.
  // Best-effort by contract (the contact is already stamped above); a refusal is logged by the sentinel.
  if (input.tcpaConsentGiven === true && contactId) {
    await sentinelWrite(supabase, supabase.from("contact_consent_events").insert({
      contact_id:     contactId,
      brokerage_id:   input.brokerageId,
      agent_id:       form.agent_id ?? null,
      consent_type:   "marketing",
      consent_text:   consentText,
      consent_source: "lead_magnet",
      consented:      true,
      ip_address:     input.ipAddress ?? null,
      user_agent:     input.userAgent ?? null,
    }), { table: "contact_consent_events", flow: "contact_consent_events_write", reason: "consent audit trail (the contact is already stamped with the consent)" })
  }

  // ATTRIBUTION TOUCHPOINT (wave 141): the conversion lands on the EXISTING attribution spine —
  // marketing_campaign_touchpoints (status 'converted', external_table form_submissions) — so
  // marketing_attribution_credits, manager-touch-provenance and the twin see a lead-magnet conversion
  // from an ad / QR without a new table. Written here on the capture's own client (the recorder,
  // lib/marketing/touchpoint-recorder.ts, is server-only and mints its own service client — no seam);
  // its row shape and metadata.manager rule (touchpointManagerForChannel) are reused verbatim.
  // BLIND SPOT, published: the live channel CHECK has no paid-search value, so a Google click keeps its
  // contact-level campaign stamp but writes no touchpoint row (touchpointChannelFor returns null).
  let touchpointId: string | null = null
  const touchpointChannel = touchpointChannelFor(attribution)
  if (verifiedCampaignId && contactId && touchpointChannel) {
    const { touchpointManagerForChannel } = await import("@/lib/campaign-sequences/touchpoint-bridge")
    const { data: tp, error: tpErr } = await supabase
      .from("marketing_campaign_touchpoints")
      .insert({
        brokerage_id:   input.brokerageId,
        campaign_id:    verifiedCampaignId,
        contact_id:     contactId,
        channel:        touchpointChannel,
        external_table: "form_submissions",
        external_id:    submission.id,
        status:         "converted",
        source:         "trigger",
        metadata:       { manager: touchpointManagerForChannel(touchpointChannel), magnet_id: input.formId, ad_campaign_id: attribution?.adCampaignId ?? null, creative: attribution?.creative ?? null, qr: attribution?.qr ?? null, utm_source: attribution?.utmSource ?? null, utm_medium: attribution?.utmMedium ?? null, utm_campaign: attribution?.utmCampaign ?? null, utm_content: attribution?.utmContent ?? null },
        sent_at:        submittedAt,
        converted_at:   submittedAt,
      })
      .select("id")
      .maybeSingle()
    if (tpErr) console.error("[lead-magnets] attribution touchpoint REFUSED:", tpErr.message)
    else touchpointId = (tp as { id?: string } | null)?.id ?? null
  }

  // If it was a home valuation, create a valuation_request record
  if (data.property_address && contactId) {
    const { error: valuationReqErr } = await supabase.from("valuation_requests").insert({
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
    if (valuationReqErr) console.error(`[lead-magnets] home-valuation request NOT recorded: ${valuationReqErr.message}`)

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
      // lead_capture_forms.agent_id FKs agents(id); deliverMagnet's agentUserId is a USERS id (it lands
      // on compliance_events.actor_user_id and activities.agent_user_id, both FK users). agents.id and
      // users.id are DISJOINT (CLAUDE.md §3) — handing it the agents.id refused both writes with 23503
      // on every submission (wave 93 live walk, lane 93D). Cross via agents.user_id.
      let agentUserId: string | null = null
      if (form.agent_id) {
        const { data: formAgent, error: formAgentErr } = await supabase
          .from("agents").select("user_id").eq("id", form.agent_id).eq("brokerage_id", input.brokerageId).maybeSingle()
        if (formAgentErr) console.warn("[lead-magnets] form agent lookup refused:", formAgentErr.message)
        agentUserId = (formAgent as { user_id?: string | null } | null)?.user_id ?? null
      }
      const { deliverMagnet } = await import("@/lib/marketing/lead-magnet-delivery-runner")
      // Wave 142: a magnet that DISTRIBUTES a FINISHED BOOK (wave 145: the book's own row — book_projects, read through
      // loadDistributedBook) delivers that PDF; the deliverable records the magnet + document refs so follow-up can find it.
      // An unreadable book is said and the booklet path stands in (the capture itself already landed).
      const distributedBook = await loadDistributedBook(supabase as never, input.brokerageId, input.formId, (form as { settings?: Record<string, unknown> | null }).settings ?? null)
      if (distributedBook.error) console.warn("[lead-magnets] distributed book unreadable — the booklet path delivers instead:", distributedBook.error)
      await deliverMagnet({ brokerageId: input.brokerageId, contactId, agentUserId, magnetType, magnetId: input.formId, book: leadMagnetBookRefOf({ book: distributedBook.book?.project ?? null }), ctx: { area: data.city ?? null } }, supabase)
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
  await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    entityType: "form_submission",
    entityId: submission.id,
    event: "form_submission_captured",
    // The submitter is a public visitor, not a platform user: actor_user_id FKs users(id), so the
    // contact id here refused every echo with 23503 (wave 93 live walk). The contact rides in metadata.
    actorUserId: null,
    brokerageId: input.brokerageId,
    metadata: { formId: input.formId, contactId, source: input.source, attribution: attribution ? { ...attribution, campaignId: verifiedCampaignId, campaignVerified: !!verifiedCampaignId, touchpointId } : null },
    client: supabase,
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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
        await sentinelWrite(supabase, supabase.from("notifications").insert({
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
        }), { table: "notifications", flow: "lead_magnets_notify", brokerageId: input.brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })

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
    personId,
    contactId,
    capturedAt: submittedAt,
    attribution: attribution ? { ...attribution, campaignId: verifiedCampaignId, campaignVerified: !!verifiedCampaignId, touchpointId } : null,
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
  input: GenerateQRCodeInput,
  opts: LeadMagnetClientOpts = {},
): Promise<GenerateQRCodeOutput> {
  if (!input.magnetId || !input.brokerageId || !input.targetUrl) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId, targetUrl" }
  }

  const supabase = opts.client ?? createServiceClient()
  // The real minter is server-only; a load failure is an honest refusal (the caller shows the URLs it
  // got — a refused QR must never read as "published with a QR"), never an unwound publish.
  let mintTrackedQr: LeadMagnetQrMinter
  try {
    mintTrackedQr = opts.mintTrackedQr ?? (await import("@/lib/marketing/tracked-qr")).mintTrackedQr
  } catch (e) {
    return { success: false, error: `QR minter unavailable: ${(e as Error)?.message ?? String(e)}` }
  }

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
  if (!input.magnetId || !input.eventType) {
    return { success: false, error: "Missing required fields: magnetId, eventType" }
  }

  const supabase = createServiceClient()

  // ── THE TENANT COMES FROM THE MAGNET, NOT FROM THE CALLER (§4) ────────────
  // This wrote lifecycle_events (and qr_scan_events) stamped to whatever
  // `brokerageId` the caller named, on a SERVICE client, while the only row it
  // read to get there — the form — was looked up by id with NO brokerage
  // predicate. The scan arm of GET /api/lead-magnets/qr/[magnetId] is
  // unauthenticated by nature (a scan comes from a stranger's phone) and took
  // that value from the QUERY STRING, so anyone could forge scan and view
  // events into any tenant's ledger. That is the body-supplied-brokerageId-on-
  // a-service-client shape CLAUDE.md §4 names. The form row is the ONE
  // authority for which tenant a magnet belongs to, so it is read first (for
  // every event type), its brokerage_id is what every write below carries, and
  // a caller-supplied brokerageId is only ever CHECKED against it — a
  // disagreement refuses rather than trusting either side.
  const { data: form, error: formError } = await supabase
    .from("lead_capture_forms")
    .select("id, slug, brokerage_id")
    .eq("id", input.magnetId)
    .maybeSingle()
  if (formError) {
    return { success: false, error: `Could not resolve the lead magnet: ${formError.message}` }
  }
  if (!form?.brokerage_id) {
    return { success: false, error: "Lead magnet not found" }
  }
  const tenantId = form.brokerage_id as string
  if (input.brokerageId && input.brokerageId !== tenantId) {
    return { success: false, error: "brokerageId does not match the lead magnet's brokerage" }
  }

  // If it's a QR scan, increment scan count and log qr_scan_event
  if (input.eventType === "qr_scan") {
    // The code is keyed by its ONE label (leadMagnetQrLabel — the mint path's
    // idempotency key), not by a substring of its URL: target_url is the
    // semantic landing URL and is re-pointable, so an ILIKE on the form slug
    // could match a re-pointed or unrelated code, or nothing at all.
    const { data: qr, error: qrError } = await supabase
      .from("qr_codes")
      .select("id, scan_count")
      .eq("brokerage_id", tenantId)
      .eq("label", leadMagnetQrLabel(input.magnetId))
      .maybeSingle()
    if (qrError) {
      console.error("[lead-magnets] qr_codes lookup refused:", qrError.message)
    }

    if (qr) {
      // Errors are READ (§3): a refused scan insert used to resolve silently and
      // the scan_count still went up, so the count and the event log disagreed.
      const { error: scanError } = await supabase
        .from("qr_scan_events")
        .insert({
          qr_code_id: qr.id,
          brokerage_id: tenantId,
          contact_id: input.contactId ?? null,
          scanned_at: new Date().toISOString(),
          ip_address: input.ipAddress ?? null,
          user_agent: input.userAgent ?? null,
        })
      if (scanError) {
        console.error("[lead-magnets] qr_scan_events insert refused:", scanError.message)
      } else {
        const { error: countError } = await supabase
          .from("qr_codes")
          .update({ scan_count: (qr.scan_count ?? 0) + 1 })
          .eq("brokerage_id", tenantId)
          .eq("id", qr.id)
        if (countError) {
          console.error("[lead-magnets] qr_codes scan_count update refused:", countError.message)
        }
      }
    }
  }

  // Log the lifecycle event — stamped to the MAGNET's tenant.
  const kernelEmit = await import("@/lib/kernel/emit")
  const { data: event, error } = kernelEmit.asWriteResult(await kernelEmit.emitKernelEvent({
      entityType: "lead_capture_form",
      entityId: input.magnetId,
      event: `lead_magnet_${input.eventType}`,
      // A contact is not a platform user (actor_user_id FKs users): a contact id here refused the
      // event with 23503 every time a visitor submitted (wave 93 live walk). contactId rides in metadata.
      actorUserId: null,
      brokerageId: tenantId,
      metadata: { ...input.metadata, contactId: input.contactId },
      auditOnly: true,
    }))

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, eventId: event?.id }
}

// ============================================================================
// KERNEL COMMAND 6: getMagnetPerformance
// ============================================================================

export async function getMagnetPerformance(
  input: GetMagnetPerformanceInput,
  opts: LeadMagnetClientOpts = {},
): Promise<GetMagnetPerformanceOutput> {
  if (!input.magnetId || !input.brokerageId) {
    return { success: false, error: "Missing required fields: magnetId, brokerageId" }
  }

  const supabase = opts.client ?? createServiceClient()

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
    .select("submitted_at, source")
    .eq("form_id", input.magnetId)
    .eq("brokerage_id", input.brokerageId)
    .gte("submitted_at", thirtyDaysAgo.toISOString())
    .order("submitted_at", { ascending: true })

  // Aggregate by day, and by the arrival channel each submission RECORDED (form_submissions.source —
  // wave 141 writes it; older rows with none count as 'unknown', never as a guessed split).
  const dayMap: Record<string, number> = {}
  const sourceMap: Record<string, number> = {}
  for (const s of recentSubmissions ?? []) {
    const day = new Date(s.submitted_at).toISOString().substring(0, 10)
    dayMap[day] = (dayMap[day] ?? 0) + 1
    const src = (s as { source?: string | null }).source || "unknown"
    sourceMap[src] = (sourceMap[src] ?? 0) + 1
  }
  const submissionsByDay = Object.entries(dayMap).map(([date, count]) => ({ date, count }))
  const topSources = Object.entries(sourceMap).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count)

  // Ad-attributed conversions: the touchpoint rows the capture wrote (status converted, external_table
  // form_submissions) for THIS magnet — converted_at is the conversion instant, grouped by campaign.
  const { data: convertedTouches, error: convErr } = await supabase
    .from("marketing_campaign_touchpoints")
    .select("campaign_id, converted_at, metadata")
    .eq("brokerage_id", input.brokerageId)
    .eq("external_table", "form_submissions")
    .eq("status", "converted")
    .gte("converted_at", thirtyDaysAgo.toISOString())
    .order("converted_at", { ascending: false })
    .limit(2000)
  if (convErr) console.error("[lead-magnets] attributed conversions read REFUSED:", convErr.message)
  const byCampaignMap: Record<string, { count: number; lastConvertedAt: string }> = {}
  for (const t of (convertedTouches ?? []) as Array<{ campaign_id: string | null; converted_at: string | null; metadata: Record<string, unknown> | null }>) {
    if (!t.campaign_id || !t.converted_at) continue
    if ((t.metadata?.magnet_id ?? null) !== input.magnetId) continue
    const cur = byCampaignMap[t.campaign_id] ?? { count: 0, lastConvertedAt: t.converted_at }
    cur.count += 1
    if (t.converted_at > cur.lastConvertedAt) cur.lastConvertedAt = t.converted_at
    byCampaignMap[t.campaign_id] = cur
  }
  const byCampaign = Object.entries(byCampaignMap).map(([campaignId, v]) => ({ campaignId, ...v })).sort((a, b) => b.count - a.count)
  const attributedConversions = { total: byCampaign.reduce((n, c) => n + c.count, 0), byCampaign }

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
      // TOMBSTONE (wave 141): this used to be `direct = round(subs × 0.5)` + the QR scan count — a
      // FABRICATED split the dashboard rendered as a measurement. Now the recorded sources (30-day
      // window, same as submissionsByDay), honest 'unknown' for rows written before the source landed.
      topSources,
      attributedConversions,
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
  input: ListLeadMagnetsInput,
  opts: LeadMagnetClientOpts = {},
): Promise<ListLeadMagnetsOutput> {
  if (!input.brokerageId) {
    return { success: false, error: "Missing required field: brokerageId" }
  }

  const supabase = opts.client ?? createServiceClient()

  let query = supabase
    .from("lead_capture_forms")
    .select("id, name, slug, is_active, submission_count, created_at, agent_id, fields, magnet_type, settings")
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

  const nameById = new Map(forms.map((f) => [f.id as string, f.name as string]))
  const magnets = forms.map((f) => {
    const qrEntry = qrBySlug[f.slug]
    const settings = (((f as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>)
    const lifecycle = (settings.lifecycle ?? null) as Partial<LeadMagnetLifecycle> | null
    const provenance = (settings.provenance ?? null) as { cloned_from_id?: string; cloned_from_name?: string } | null
    const authoring = (settings.authoring ?? null) as { by?: string } | null
    // Before wave 141 rows have no lifecycle record: they were created active, i.e. published.
    const lifecycleState: "draft" | "published" = lifecycle?.state === "draft" ? "draft" : "published"
    return {
      id: f.id,
      name: f.name,
      slug: f.slug,
      // The COLUMN, not a sniff of the first field (which read every buyer / seller guide as a
      // generic form); the sniff stays only for rows written before magnet_type was stamped.
      magnetType: ((f as { magnet_type?: string | null }).magnet_type) ?? ((f.fields as any[])?.some?.((x) => x?.name === "property_address") ? "home_valuation" : "generic_form"),
      isActive: f.is_active,
      submissionCount: f.submission_count ?? 0,
      scanCount: qrEntry?.scan_count ?? 0,
      createdAt: f.created_at,
      formId: f.id,
      qrCodeId: qrEntry?.id,
      lifecycleState,
      authoredBy: authoring?.by === "ai" ? "ai" as const : "human" as const,
      clonedFromId: provenance?.cloned_from_id ?? null,
      clonedFromName: provenance?.cloned_from_id ? (nameById.get(provenance.cloned_from_id) ?? provenance.cloned_from_name ?? null) : null,
    }
  })

  return { success: true, magnets, count: magnets.length }
}
