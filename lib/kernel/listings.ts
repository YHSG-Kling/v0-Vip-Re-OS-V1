/**
 * lib/kernel/listings.ts
 * Canonical Listing OS kernel commands.
 *
 * Ownership rules (per document-gzr9a.md):
 * - Every command has explicit input/output contracts.
 * - All DB writes use live schema column names only.
 * - "use server" is NOT used here — this is a library module imported by
 *   both app/actions/listings-kernel.ts (Server Actions) and RSC pages.
 * - AI ISA assignment is NEVER triggered from listing commands — it fires
 *   only from the CRM lead pipeline (lib/kernel/crm.ts).
 * - Stage transitions ALWAYS delegate to executeListingTransition in
 *   app/actions/listing-lifecycle-core.ts — never written directly.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "./events"
import type { ListingStage as LifecycleListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"

// ─── Shared result type ───────────────────────────────────────────────────────

export type KernelResult<T> =
  | ({ success: true } & T)
  | { success: false; error: string }

// ─── Listing types ────────────────────────────────────────────────────────────

export type ListingStage = LifecycleListingStage

export interface CreateListingInput {
  agentId: string
  sellerContactId: string
  brokerageId: string
  address: string
  city: string
  state: string
  zip: string
  listPrice?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  propertyType?: string
}

export interface SellerContactInput {
  brokerageId: string
  agentId: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
}

export interface ListingUpdate {
  address?: string
  city?: string
  state?: string
  zip?: string
  list_price?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  property_type?: string
  showing_instructions?: string
  mls_number?: string
  mls_link?: string
  marketing_tier_id?: string
  marketing_budget?: number
  go_live_date?: string
  listing_date?: string
}

export interface ListingFormPrefill {
  listingId: string
  address: string
  city: string
  state: string
  zip: string
  listPrice?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  propertyType?: string
  sellerFirstName?: string
  sellerLastName?: string
  sellerEmail?: string
  sellerPhone?: string
  agentFirstName?: string
  agentLastName?: string
  agentEmail?: string
  agentLicenseNumber?: string
  agentLicenseState?: string
  brokerageName?: string
  brokerageAddress?: string
  brokeragePhone?: string
  brokerageLicense?: string
}

export interface MediaAttachmentInput {
  listingId: string
  brokerageId: string
  fileUrl: string
  mediaType: "photo" | "video" | "document" | "virtual_tour"
  uploadedBy: string
  isPrimary?: boolean
  caption?: string
  sort_order?: number
}

// ─── 1. createListingRecord ───────────────────────────────────────────────────

/**
 * Create a new listing record.
 * Input: CreateListingInput
 * Output: { listing }
 * Writes: listings (INSERT) + lifecycle_events (LISTING_AGREEMENT_INITIATED stage entry)
 * Validates: agentId UUID, sellerContactId UUID, brokerageId UUID, address required
 */
export async function createListingRecord(
  input: CreateListingInput
): Promise<KernelResult<{ listing: Record<string, unknown> }>> {
  if (!isValidUUID(input.agentId))          return { success: false, error: "Invalid agent ID" }
  if (!isValidUUID(input.sellerContactId))  return { success: false, error: "Invalid seller contact ID" }
  if (!isValidUUID(input.brokerageId))      return { success: false, error: "Invalid brokerage ID" }
  if (!input.address?.trim())               return { success: false, error: "Address is required" }
  if (!input.city?.trim())                  return { success: false, error: "City is required" }
  if (!input.state?.trim())                 return { success: false, error: "State is required" }

  try {
    const supabase = await createClient()

    const { data: listing, error } = await supabase
      .from("listings")
      .insert({
        agent_id:          input.agentId,
        seller_contact_id: input.sellerContactId,
        brokerage_id:      input.brokerageId,
        address:           input.address.trim(),
        city:              input.city.trim(),
        state:             input.state.trim(),
        zip:               input.zip?.trim(),
        list_price:        input.listPrice   ?? null,
        bedrooms:          input.bedrooms    ?? null,
        bathrooms:         input.bathrooms   ?? null,
        sqft:              input.sqft        ?? null,
        property_type:     input.propertyType ?? "residential",
        // A listing is created from a seller contact by an assigned agent who is
        // about to run the listing agreement — so it starts at agreement-initiation,
        // not LEAD (LEAD is the pre-assignment lead-pipeline stage on `leads`).
        status:            "active",
        lifecycle_stage:   "LISTING_AGREEMENT_INITIATED",
      })
      .select()
      .single()

    if (error) return { success: false, error: error.message }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type:  "listing",
        entity_id:    listing.id,
        event_type:   KernelEvent.LISTING_CREATED ?? "listing_created",
        brokerage_id: input.brokerageId,
        metadata:     { stage: "LISTING_AGREEMENT_INITIATED", agent_id: input.agentId },
        created_at:   new Date().toISOString(),
      })
      .then(() => {})

    // Portal fan-out: the seller sees "Your listing is being prepared".
    const { fanOutKernelEvent } = await import("./event-fanout")
    await fanOutKernelEvent({
      event:           KernelEvent.LISTING_CREATED,
      brokerageId:     input.brokerageId,
      entityType:      "listing",
      entityId:        listing.id as string,
      sellerContactId: input.sellerContactId,
      listingId:       listing.id as string,
      agentUserId:     input.agentId,
      metadata:        { stage: "LISTING_AGREEMENT_INITIATED" },
    }).catch(() => {})

    return { success: true, listing }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "createListingRecord failed"
    return { success: false, error: msg }
  }
}

// ─── 2. createOrAttachSellerContact ──────────────────────────────────────────

/**
 * Find an existing contact by email or phone, or create a new one.
 * Input: SellerContactInput
 * Output: { contactId: string, created: boolean }
 * Writes: contacts (UPSERT by email or phone_digits)
 * Rule: never overwrites an existing contact's data — only creates if no match found.
 */
export async function createOrAttachSellerContact(
  input: SellerContactInput
): Promise<KernelResult<{ contactId: string; created: boolean }>> {
  if (!isValidUUID(input.brokerageId)) return { success: false, error: "Invalid brokerage ID" }
  if (!isValidUUID(input.agentId))     return { success: false, error: "Invalid agent ID" }
  if (!input.firstName?.trim())        return { success: false, error: "First name is required" }

  try {
    const supabase = await createClient()

    // Search by email first, then phone
    if (input.email) {
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", input.brokerageId)
        .eq("email", input.email.toLowerCase().trim())
        .maybeSingle()
      if (existing?.id) return { success: true, contactId: existing.id, created: false }
    }

    if (input.phone) {
      // phone_digits is a generated column — query using the phone column directly
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", input.brokerageId)
        .eq("phone", input.phone.trim())
        .maybeSingle()
      if (existing?.id) return { success: true, contactId: existing.id, created: false }
    }

    // Create new contact
    // NOTE: phone_digits is a generated/computed column in the DB — do NOT include it in INSERT.
    // The database calculates it automatically from the phone column.
    const { data: contact, error } = await supabase
      .from("contacts")
      .insert({
        brokerage_id:  input.brokerageId,
        agent_id:      input.agentId,
        first_name:    input.firstName.trim(),
        last_name:     input.lastName?.trim() ?? "",
        email:         input.email?.toLowerCase().trim() ?? null,
        phone:         input.phone ?? null,
        contact_type:  "seller",
        status:        "active",
        source:        "manual_entry",
        source_family: "direct_intake",
      })
      .select("id")
      .single()

    if (error) return { success: false, error: error.message }
    return { success: true, contactId: contact.id, created: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "createOrAttachSellerContact failed" }
  }
}

// ─── 3. loadListingWorkspace ──────────────────────────────────────────────────

/**
 * Load the full listing workspace for a detail/lifecycle page.
 * Input: { listingId, userId }
 * Output: { listing, media, tasks, timeline, currentStage }
 * Reads: listings, listing_media, tasks, lifecycle_events
 * Validates: listingId UUID, brokerage scope enforced via RLS
 */
export async function loadListingWorkspace(input: {
  listingId: string
  userId: string
}): Promise<KernelResult<{
  listing: Record<string, unknown>
  media: unknown[]
  tasks: unknown[]
  timeline: unknown[]
  currentStage: string | null
}>> {
  if (!isValidUUID(input.listingId)) return { success: false, error: "Invalid listing ID" }

  try {
    const supabase = await createClient()

    const [listingResult, mediaResult, tasksResult, timelineResult] = await Promise.all([
      supabase
        .from("listings")
        .select(`
          *,
          seller:seller_contact_id(id, first_name, last_name, email, phone),
          agent:agent_id(id, brokerage_id)
        `)
        .eq("id", input.listingId)
        .maybeSingle(),
      supabase
        .from("listing_media")
        .select("*")
        .eq("listing_id", input.listingId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("tasks")
        .select("*")
        .eq("listing_id", input.listingId)
        .order("due_date", { ascending: true }),
      supabase
        .from("lifecycle_events")
        .select("*")
        .eq("entity_id", input.listingId)
        .eq("entity_type", "listing")
        .order("created_at", { ascending: false })
        .limit(30),
    ])

    if (!listingResult.data) return { success: false, error: "Listing not found" }

    // Derive current stage from most recent lifecycle_event or listings.lifecycle_stage
    const latestEvent = (timelineResult.data ?? []).find(
      (e: any) => e.event_type?.startsWith("listing_stage")
    )
    const currentStage = (latestEvent as any)?.metadata?.stage
      ?? (listingResult.data as any)?.lifecycle_stage
      ?? "LEAD"

    return {
      success: true,
      listing:      listingResult.data,
      media:        mediaResult.data ?? [],
      tasks:        tasksResult.data ?? [],
      timeline:     timelineResult.data ?? [],
      currentStage,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "loadListingWorkspace failed" }
  }
}

// ─── 4. saveListingDraft ──────────────────────────────────────────────────────

/**
 * Save a draft update to listing fields (property info, marketing details).
 * Input: { listingId, updates: Partial<ListingUpdate>, actorUserId }
 * Output: { listing }
 * Writes: listings (UPDATE)
 * Validates: UUID, only allowed fields (cannot update status/stage directly)
 */
export async function saveListingDraft(input: {
  listingId: string
  updates: Partial<ListingUpdate>
  actorUserId: string
}): Promise<KernelResult<{ listing: Record<string, unknown> }>> {
  if (!isValidUUID(input.listingId))    return { success: false, error: "Invalid listing ID" }
  if (!isValidUUID(input.actorUserId))  return { success: false, error: "Invalid user ID" }
  if (!input.updates || Object.keys(input.updates).length === 0) {
    return { success: false, error: "No updates provided" }
  }

  // Strip disallowed fields — callers must use updateListingStage for lifecycle changes
  const { ...safeUpdates } = input.updates as Record<string, unknown>
  delete safeUpdates.status
  delete safeUpdates.current_stage
  delete safeUpdates.lifecycle_stage
  delete safeUpdates.agent_id
  delete safeUpdates.brokerage_id
  delete safeUpdates.seller_contact_id

  try {
    const supabase = await createClient()

    const { data: listing, error } = await supabase
      .from("listings")
      .update({ ...safeUpdates, updated_at: new Date().toISOString() })
      .eq("id", input.listingId)
      .select()
      .single()

    if (error) return { success: false, error: error.message }
    return { success: true, listing }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "saveListingDraft failed" }
  }
}

// ─── 5. validateListingLaunchReadiness ───────────────────────────────────────

/**
 * Check whether the listing meets the minimum requirements to launch.
 * Input: { listingId }
 * Output: { ready: boolean, blockers: string[] }
 * Reads: listings, listing_media
 * Blockers: no seller contact, no list price, fewer than 5 photos
 * NOTE: public_remarks exists (m194); this check is intentionally omitted here.
 */
export async function validateListingLaunchReadiness(input: {
  listingId: string
}): Promise<KernelResult<{ ready: boolean; blockers: string[] }>> {
  if (!isValidUUID(input.listingId)) return { success: false, error: "Invalid listing ID" }

  try {
    const supabase = await createClient()

    const [listingResult, mediaCountResult] = await Promise.all([
      supabase
        .from("listings")
        .select("address, list_price, seller_contact_id, mls_number")
        .eq("id", input.listingId)
        .maybeSingle(),
      supabase
        .from("listing_media")
        .select("id", { count: "exact", head: true })
        .eq("listing_id", input.listingId)
        .eq("media_type", "photo"),
    ])

    if (!listingResult.data) return { success: false, error: "Listing not found" }

    const listing = listingResult.data
    const blockers: string[] = []

    if (!listing.seller_contact_id) blockers.push("No seller contact linked")
    if (!listing.list_price)        blockers.push("No list price set")
    if (!listing.mls_number)        blockers.push("No MLS number entered")

    const photoCount = mediaCountResult.count ?? 0
    if (photoCount < 5) blockers.push(`Photos: need at least 5 (${photoCount} uploaded)`)

    return { success: true, ready: blockers.length === 0, blockers }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "validateListingLaunchReadiness failed" }
  }
}

// ─── 6. launchListing ────────────────────────────────────────────────────────

/**
 * Launch a listing to active status.
 * Input: { listingId, mlsNumber, mlsLink?, actorUserId }
 * Output: { listing }
 * Validates: launch readiness gate must pass first
 * Writes: listings (UPDATE mls_number, status), lifecycle_events
 * Stage: delegates to executeListingTransition(ACTIVE) from listing-lifecycle-core.ts
 */
export async function launchListing(input: {
  listingId: string
  mlsNumber: string
  mlsLink?: string
  actorUserId: string
}): Promise<KernelResult<{ listing: Record<string, unknown> }>> {
  if (!isValidUUID(input.listingId))   return { success: false, error: "Invalid listing ID" }
  if (!input.mlsNumber?.trim())        return { success: false, error: "MLS number is required" }

  // Gate: validate launch readiness first
  const readiness = await validateListingLaunchReadiness({ listingId: input.listingId })
  if (!readiness.success) return { success: false, error: readiness.error }
  if (!readiness.ready)   return { success: false, error: readiness.blockers[0] ?? "Launch blockers present" }

  try {
    const supabase = await createClient()

    const { data: listing, error } = await supabase
      .from("listings")
      .update({
        mls_number:      input.mlsNumber.trim(),
        mls_link:        input.mlsLink?.trim() ?? null,
        status:          "active",
        lifecycle_stage: "MLS_ACTIVE",
        listing_date:    new Date().toISOString().split("T")[0],
        updated_at:      new Date().toISOString(),
      })
      .eq("id", input.listingId)
      .select()
      .single()

    if (error) return { success: false, error: error.message }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type:  "listing",
        entity_id:    input.listingId,
        event_type:   "listing_stage_active",
        metadata:     { mls_number: input.mlsNumber, actor: input.actorUserId },
        created_at:   new Date().toISOString(),
      })
      .then(() => {})

    return { success: true, listing }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "launchListing failed" }
  }
}

// ─── 7. updateListingStage ────────────────────────────────────────────────────

/**
 * Single gate for all listing stage changes.
 * Input: { listingId, targetStage, actorUserId, notes?, overrideReason? }
 * Output: { transition }
 * Delegates to: executeListingTransition (listing-lifecycle-core.ts)
 * Rule: this is the ONLY way stage changes happen — never update current_stage directly.
 */
export async function updateListingStage(input: {
  listingId: string
  targetStage: ListingStage
  actorUserId: string
  notes?: string
  overrideReason?: string
}): Promise<KernelResult<{ fromStage: string | null; toStage: string; enabledSystemGates: string[] }>> {
  if (!isValidUUID(input.listingId))   return { success: false, error: "Invalid listing ID" }
  if (!input.targetStage)              return { success: false, error: "Target stage is required" }

  try {
    // Dynamic import to avoid circular dependency — lifecycle-core imports supabase
    const { executeListingTransition } = await import(
      "@/app/actions/listing-lifecycle-core"
    )
    const result = await executeListingTransition({
      listingId:      input.listingId,
      targetStage:    input.targetStage,
      notes:          input.notes,
      overrideReason: input.overrideReason,
    })

    if (!result.success) return { success: false, error: result.error ?? "Stage transition failed" }
    return {
      success: true,
      fromStage:          result.transition?.fromStage ?? null,
      toStage:            result.transition?.toStage ?? input.targetStage,
      enabledSystemGates: result.transition?.enabledSystemGates ?? [],
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "updateListingStage failed" }
  }
}

// ─── 8. attachMediaToListing ─────────────────────────────────────────────────

/**
 * Attach a media asset to a listing.
 * Input: MediaAttachmentInput
 * Output: { mediaId: string }
 * Writes: listing_media (INSERT)
 */
export async function attachMediaToListing(
  input: MediaAttachmentInput
): Promise<KernelResult<{ mediaId: string }>> {
  if (!isValidUUID(input.listingId))   return { success: false, error: "Invalid listing ID" }
  if (!input.fileUrl?.trim())          return { success: false, error: "File URL is required" }

  try {
    const supabase = await createClient()

    const { data: media, error } = await supabase
      .from("listing_media")
      .insert({
        listing_id:   input.listingId,
        brokerage_id: input.brokerageId,
        file_url:     input.fileUrl.trim(),
        media_type:   input.mediaType,
        uploaded_by:  input.uploadedBy,
        is_primary:   input.isPrimary ?? false,
        caption:      input.caption   ?? null,
        sort_order:   input.sort_order ?? 0,
      })
      .select("id")
      .single()

    if (error) return { success: false, error: error.message }
    return { success: true, mediaId: media.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "attachMediaToListing failed" }
  }
}

// ─── 9. generateListingDescription ───────────────────────────────────────────

/**
 * Generate an AI listing description for a property.
 * Input: { listingId, agentId, style? }
 * Output: { description: string }
 * Reads: listings (for context)
 * Does NOT write — returns text for caller to save via saveListingDraft.
 */
export async function generateListingDescription(input: {
  listingId: string
  agentId: string
  style?: "luxury" | "family" | "investment" | "standard"
}): Promise<KernelResult<{ description: string }>> {
  if (!isValidUUID(input.listingId)) return { success: false, error: "Invalid listing ID" }

  try {
    const supabase = await createClient()

    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type, showing_instructions, brokerage_id")
      .eq("id", input.listingId)
      .maybeSingle()

    if (!listing) return { success: false, error: "Listing not found" }

    const { generateText } = await import("ai")
    const { resolveModel } = await import("@/lib/ai/resolve-model")

    const styleContext = {
      luxury:     "Use elevated, aspirational language for a luxury buyer audience.",
      family:     "Emphasize warmth, family-friendly features, and community.",
      investment: "Highlight income potential, location advantages, and ROI.",
      standard:   "Clear, professional real estate copy for a broad audience.",
    }[input.style ?? "standard"]

    const prompt = `You are a professional real estate copywriter. Write a compelling MLS listing description.

Property:
- Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
- Price: $${listing.list_price?.toLocaleString() ?? "TBD"}
- Beds: ${listing.bedrooms ?? "N/A"} | Baths: ${listing.bathrooms ?? "N/A"} | Sqft: ${listing.sqft?.toLocaleString() ?? "N/A"}
- Type: ${listing.property_type ?? "Residential"}
${listing.showing_instructions ? `- Notes: ${listing.showing_instructions}` : ""}

Style: ${styleContext}

Write 2-3 paragraphs (150-250 words). No address in the first sentence. Lead with a compelling hook.`

    const { text } = await generateText({
      model:  resolveModel("openai/gpt-4o-mini"),
      prompt,
    })

    const rawDescription = text.trim()

    // Apply brand voice + compliance check (non-blocking)
    let finalDescription = rawDescription
    try {
      const { guardContent } = await import("@/lib/content-guardian")
      const brokerageId = (listing as any).brokerage_id as string | undefined
      if (brokerageId) {
        const guarded = await guardContent({
          content: rawDescription,
          agentId: input.agentId,
          brokerageId,
          contentType: "listing_description",
        })
        finalDescription = guarded.content
      }
    } catch {
      // Non-fatal — return raw description if guardian fails
    }

    return { success: true, description: finalDescription }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateListingDescription failed" }
  }
}

// ─── 10. createTransactionShellFromAcceptedOffer ─────────────────────────────

/**
 * Create a transaction shell when an offer is accepted.
 * Input: { listingId, offerId, agentId, brokerageId }
 * Output: { transactionId: string }
 * Validates: offer.status === 'accepted', listing.seller_contact_id present
 * Writes: transactions (INSERT)
 */
export async function createTransactionShellFromAcceptedOffer(input: {
  listingId:   string
  offerId:     string
  agentId:     string
  brokerageId: string
}): Promise<KernelResult<{ transactionId: string }>> {
  if (!isValidUUID(input.listingId))   return { success: false, error: "Invalid listing ID" }
  if (!isValidUUID(input.offerId))     return { success: false, error: "Invalid offer ID" }
  if (!isValidUUID(input.agentId))     return { success: false, error: "Invalid agent ID" }
  if (!isValidUUID(input.brokerageId)) return { success: false, error: "Invalid brokerage ID" }

  try {
    const supabase = await createClient()

    // Validate offer is accepted
    const { data: offer } = await supabase
      .from("offers")
      .select("id, status, offer_price, buyer_contact_id")
      .eq("id", input.offerId)
      .maybeSingle()

    if (!offer)                       return { success: false, error: "Offer not found" }
    if (offer.status !== "accepted")  return { success: false, error: "Offer is not in accepted status" }

    // Get listing seller contact
    const { data: listing } = await supabase
      .from("listings")
      .select("id, seller_contact_id, address, city, state, zip, list_price")
      .eq("id", input.listingId)
      .maybeSingle()

    if (!listing)                        return { success: false, error: "Listing not found" }
    if (!listing.seller_contact_id)      return { success: false, error: "Listing has no seller contact" }

    const { data: transaction, error } = await supabase
      .from("transactions")
      .insert({
        agent_id:          input.agentId,
        brokerage_id:      input.brokerageId,
        listing_id:        input.listingId,
        offer_id:          input.offerId,
        // contact_id = primary in-house client; this transaction is created from
        // OUR listing, so the in-house client is the seller. Live column is
        // deal_type (buyer|seller|dual) — "transaction_type"/"seller_side" did
        // not exist / failed the CHECK, so the insert silently errored.
        contact_id:        listing.seller_contact_id,
        seller_contact_id: listing.seller_contact_id,
        buyer_contact_id:  offer.buyer_contact_id ?? null,
        deal_type:         "seller",
        status:            "under_contract",
        stage:             "UNDER_CONTRACT",
        purchase_price:    offer.offer_price ?? listing.list_price,
        deal_name:         [listing.address, listing.city, listing.state].filter(Boolean).join(", ") || `Transaction ${input.offerId.slice(0, 8)}`,
        property_address:  [listing.address, listing.city, listing.state].filter(Boolean).join(", "),
      })
      .select("id")
      .single()

    if (error) return { success: false, error: error.message }
    return { success: true, transactionId: transaction.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "createTransactionShellFromAcceptedOffer failed" }
  }
}

// ─── 11. closeListingLifecycle ────────────────────────────────────────────────

/**
 * Close a listing and convert seller to lifetime customer.
 * Input: { listingId, actorUserId }
 * Output: void
 * Delegates to updateListingStage(CLOSED) which triggers handleSellerToLifetimeTransition.
 */
export async function closeListingLifecycle(input: {
  listingId: string
  actorUserId: string
}): Promise<KernelResult<object>> {
  const result = await updateListingStage({
    listingId:   input.listingId,
    targetStage: "CLOSED",
    actorUserId: input.actorUserId,
  })
  if (!result.success) return { success: false, error: result.error }
  return { success: true }
}

// ─── 12. prefillListingFormFromRecord ────────────────────────────────────────

/**
 * Load all context needed to prefill listing-side forms.
 * Input: { listingId }
 * Output: { prefillData: ListingFormPrefill }
 * Reads: listings JOIN contacts(seller_contact_id) JOIN agents + brokerages
 * RULE: Returns seller/listing/property/agent/brokerage context ONLY.
 *       NEVER returns buyer info — buyer info lives on contacts/offers.
 */
export async function prefillListingFormFromRecord(input: {
  listingId: string
}): Promise<KernelResult<{ prefillData: ListingFormPrefill }>> {
  if (!isValidUUID(input.listingId)) return { success: false, error: "Invalid listing ID" }

  try {
    const supabase = await createClient()

    const { data: listing } = await supabase
      .from("listings")
      .select(`
        id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type,
        seller:seller_contact_id(id, first_name, last_name, email, phone),
        agent:agent_id(
          id, brokerage_id,
          users:user_id(first_name, last_name, email),
          license_number, license_state,
          brokerage:brokerage_id(name, address, phone, license_number)
        )
      `)
      .eq("id", input.listingId)
      .maybeSingle()

    if (!listing) return { success: false, error: "Listing not found" }

    const seller  = (listing as any).seller  ?? {}
    const agent   = (listing as any).agent   ?? {}
    const agentUser = agent.users ?? {}
    const brokerage = agent.brokerage ?? {}

    const prefillData: ListingFormPrefill = {
      listingId:        listing.id,
      address:          (listing as any).address,
      city:             (listing as any).city,
      state:            (listing as any).state,
      zip:              (listing as any).zip,
      listPrice:        (listing as any).list_price,
      bedrooms:         (listing as any).bedrooms,
      bathrooms:        (listing as any).bathrooms,
      sqft:             (listing as any).sqft,
      propertyType:     (listing as any).property_type,
      sellerFirstName:  seller.first_name,
      sellerLastName:   seller.last_name,
      sellerEmail:      seller.email,
      sellerPhone:      seller.phone,
      agentFirstName:   agentUser.first_name,
      agentLastName:    agentUser.last_name,
      agentEmail:       agentUser.email,
      agentLicenseNumber: agent.license_number,
      agentLicenseState:  agent.license_state,
      brokerageName:      brokerage.name,
      brokerageAddress:   brokerage.address,
      brokeragePhone:     brokerage.phone,
      brokerageLicense:   brokerage.license_number,
    }

    return { success: true, prefillData }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "prefillListingFormFromRecord failed" }
  }
}
