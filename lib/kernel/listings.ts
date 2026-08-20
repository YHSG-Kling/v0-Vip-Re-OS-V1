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
import { isValidUUID, validateProperty } from "@/lib/validations"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.
import { KernelEvent } from "./events"
import type { ListingStage as LifecycleListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"

// ─── Shared result type ───────────────────────────────────────────────────────

export type KernelResult<T> =
  | ({ success: true } & T)
  | { success: false; error: string }

// ─── Listing types ────────────────────────────────────────────────────────────

export type ListingStage = LifecycleListingStage

/**
 * THE TWO ENTITY SPACES A LISTING'S HISTORY IS WRITTEN INTO.
 *
 * `lifecycle_events` is keyed by (entity_type, entity_id) and a listing's id
 * appears under TWO different entity_types, written by two different producers:
 *
 *   "listing_stage_machine"  ENTITY_MAP in lib/kernel/lifecycle.ts routes the
 *                            listing STAGE machine here — every transition made
 *                            through transitionLifecycle / logStageTransition
 *                            (lib/listing-lifecycle/lifecycle-logger.ts:56).
 *                            This is where stage history lives.
 *
 *   "listing"                everything else that happens TO a listing, written
 *                            directly: createListingRecord (this file, ~line
 *                            179), launchListing (this file, ~line 517), the
 *                            manual stage OVERRIDE audit row
 *                            (app/actions/listing-lifecycle.ts:165,
 *                            "listing.stage_overridden"), seller updates, open
 *                            houses, neighborhood reports, CMA generation,
 *                            predictive pricing, and the compliance
 *                            listing-auto-create chain.
 *
 * loadListingWorkspace read ONLY "listing", so its timeline never contained a
 * single stage transition. Swapping it to "listing_stage_machine" would have
 * been the mirror-image bug — it would have dropped the create, the launch and
 * the override audit row, which are the rows a workspace most needs. BOTH are
 * genuine producers, so the workspace reads BOTH.
 *
 * VERIFIED LIVE (project hrvaqgvukzxfskkcrwbt): lifecycle_events carries no
 * CHECK on entity_type — both spellings are admissible, so neither producer was
 * ever refused. The live table holds 284 rows across entity_type user(221),
 * contact(49), buyer_lifecycle(8), ai_daily_briefing(3), ad_campaign(2),
 * agent(1) — and ZERO under either listing spelling, which is what "the
 * workspace history is empty for every listing" looks like from the database
 * side. Reading both is what makes the next listing event visible here.
 */
export const LISTING_TIMELINE_ENTITY_TYPES = ["listing", "listing_stage_machine"] as const

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

// MediaAttachmentInput + attachMediaToListing were REMOVED as duplicates
// (merge-then-delete, owner-sanctioned). SURVIVOR:
// app/actions/listing-media.ts:uploadListingMedia — wired and strictly more
// complete (MLS branding rule, attribution flags, brand compliance check,
// hero-photo fan-out; expresses all eight admitted media types, not four).

// ─── 1. createListingRecord ───────────────────────────────────────────────────

/**
 * Create a new listing record.
 * Input: CreateListingInput
 * Output: { listing }
 * Writes: listings (INSERT) + lifecycle_events (LISTING_AGREEMENT_INITIATED stage entry)
 * Validates: agentId UUID, sellerContactId UUID, brokerageId UUID, address required,
 *            and the PROPERTY FACTS (list price, zip, bedrooms, bathrooms)
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

  // ── PROPERTY FACTS (orphan burn-down, lane O — validateProperty WIRED) ──────
  // The six checks above all guard IDENTITY; the numbers a listing is actually
  // sold on had no gate at all. A negative or NaN `list_price`, a zip that is
  // not a zip, or a 300-bedroom house all inserted cleanly and then propagated —
  // list_price feeds the CMA, the seller net sheet and the commission forecast;
  // zip is the market key for comps. validateProperty (lib/validations/index.ts)
  // is the only property-fact validator in the tree and had zero callers; this
  // is the entrance it was written for. It is ADDITIVE by construction — each
  // field is checked only when the caller supplied it, so every existing
  // partial-input path is unchanged. The joined message names the field that
  // actually failed.
  const propertyFacts = validateProperty({
    zip: input.zip,
    price: input.listPrice,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
  })
  if (!propertyFacts.valid) return { success: false, error: propertyFacts.errors.join("; ") }

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
        //
        // AND IT IS A DRAFT. A listing is not taken on until the listing agreement
        // is SIGNED and the compliance check has reviewed every required document,
        // initial and signature. This row exists so the agreement has something to
        // hang off — it is NOT a live listing, and `draft` is what keeps it out of
        // buyer search, the public pages and the MLS-ready surfaces.
        //
        // Promotion out of draft is NOT this function's job and must never be done
        // by hand here: app/actions/documents.ts verifies agent+seller signatures
        // AND initials on the listing agreement, then requires auditListingDocuments
        // to report zero blocking gaps, and only then emits
        // `compliance.listing_agreement_passed`. The chain
        // lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts adopts
        // this draft and moves it to coming_soon / LISTING_AGREEMENT_SIGNED.
        status:            "draft",
        lifecycle_stage:   "LISTING_AGREEMENT_INITIATED",
      })
      .select()
      .single()

    if (error) return { success: false, error: error.message }

    // Emit lifecycle event. `.then(() => {})` swallowed the outcome — a
    // refused insert and a written row looked identical, and the listing's
    // history silently began empty. Non-fatal (the listing exists either way)
    // but never silent.
    const { error: eventError } = await supabase
      .from("lifecycle_events")
      .insert({
        entity_type:  "listing",
        entity_id:    listing.id,
        event_type:   KernelEvent.LISTING_CREATED ?? "listing_created",
        brokerage_id: input.brokerageId,
        metadata:     { stage: "LISTING_AGREEMENT_INITIATED", agent_id: input.agentId },
        created_at:   new Date().toISOString(),
      })
    if (eventError) {
      console.error("[createListingRecord] lifecycle_events insert failed — this listing has no creation row:", eventError.message)
    }

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

    // Search by email first, then phone.
    // A FAILED dedupe read must NOT fall through to the insert below: an
    // unchecked `{ data: existing }` turns a refused lookup into "no match",
    // and this function's whole contract is "never create a duplicate".
    if (input.email) {
      const { data: existing, error: emailLookupError } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", input.brokerageId)
        .eq("email", input.email.toLowerCase().trim())
        .maybeSingle()
      if (emailLookupError) return { success: false, error: `Could not check for an existing contact by email: ${emailLookupError.message}` }
      if (existing?.id) return { success: true, contactId: existing.id, created: false }
    }

    if (input.phone) {
      // phone_digits is a generated column — query using the phone column directly
      const { data: existing, error: phoneLookupError } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", input.brokerageId)
        .eq("phone", input.phone.trim())
        .maybeSingle()
      if (phoneLookupError) return { success: false, error: `Could not check for an existing contact by phone: ${phoneLookupError.message}` }
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

    // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). A seller contact
    // created alongside a listing is the case the ruling's "just before" is
    // about: the listing exists but has not been signed, so the seller is still
    // a prospect and enrichment is exactly what should happen now. If the
    // listing is already at LISTING_AGREEMENT_SIGNED or beyond,
    // queueContactEnrichment's live-deal check declines and the contact is
    // picked up after the deal ends instead. The decision is the predicate's,
    // not this call site's. Voided — listing setup must not fail on enrichment.
    void import("@/lib/enrichment/contact-enrichment-core")
      .then((m) =>
        m.queueContactEnrichment({
          contactId: contact.id,
          brokerageId: input.brokerageId,
          triggerType: "listing_seller_intake",
          supabase,
        }),
      )
      .catch(() => {})

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
        // BOTH producers — see LISTING_TIMELINE_ENTITY_TYPES. Reading one of the
        // two is how this timeline came back empty for every listing.
        .in("entity_type", [...LISTING_TIMELINE_ENTITY_TYPES])
        .order("created_at", { ascending: false })
        .limit(30),
    ])

    // EVERY read is checked. supabase-js RESOLVES a refused query, so
    // `{ data }` alone turns an RLS refusal into an empty list that reads
    // exactly like "this listing has no history / no photos / no tasks". A
    // failed read is now a named failure, never a quiet absence.
    if (listingResult.error)  return { success: false, error: `Could not read the listing: ${listingResult.error.message}` }
    if (!listingResult.data)  return { success: false, error: "Listing not found" }
    if (mediaResult.error)    return { success: false, error: `Could not read the listing's media: ${mediaResult.error.message}` }
    if (tasksResult.error)    return { success: false, error: `Could not read the listing's tasks: ${tasksResult.error.message}` }
    if (timelineResult.error) return { success: false, error: `Could not read the listing's history: ${timelineResult.error.message}` }

    // CURRENT STAGE. listings.lifecycle_stage is the column the database
    // maintains and CHECK-constrains to the canonical stages; it is the
    // authority (same ruling as resolveCurrentStage in
    // app/actions/listing-lifecycle-core.ts). The event log is the FALLBACK for
    // the case where the column is somehow empty.
    //
    // The old derivation could not have worked either way round: it looked for
    // `event_type.startsWith("listing_stage")` and then read `metadata.stage`,
    // but transitionLifecycle — the only writer of stage rows — stores
    // event_type as `lifecycle.${eventType}` and puts the stage in
    // `metadata.to_state`. Both halves missed.
    const latestStageEvent = (timelineResult.data ?? []).find((e: any) => {
      const meta = (e?.metadata ?? {}) as Record<string, unknown>
      return typeof meta.to_state === "string" || typeof meta.stage === "string"
    })
    const eventStage =
      ((latestStageEvent as any)?.metadata?.to_state as string | undefined)
      ?? ((latestStageEvent as any)?.metadata?.stage as string | undefined)

    const currentStage = ((listingResult.data as any)?.lifecycle_stage as string | null)
      ?? eventStage
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
 * Input: { listingId, suppliedMlsNumber? }
 * Output: { ready: boolean, blockers: string[] }
 * Reads: listings, listing_media
 * Blockers: no seller contact, no list price, no MLS number, fewer than 5 photos
 * NOTE: public_remarks exists (m194); this check is intentionally omitted here.
 *
 * suppliedMlsNumber closes a DEADLOCK. launchListing is the only writer of
 * listings.mls_number on the launch path — it takes the number as input and
 * stamps it on the row. But it calls this gate FIRST, and the gate read the
 * STORED mls_number. A listing that had never been launched had no stored
 * number, so the gate blocked, so the write never ran, so the number never got
 * stored. The one function that fills the field could never get past the check
 * for the field being empty.
 *
 * The number the caller is launching WITH satisfies the requirement just as
 * well as one already on the row — it is about to become the stored one. So the
 * gate accepts either. Callers that are only *reporting* readiness (the
 * lifecycle page) pass nothing and keep the strict stored-value semantics,
 * which is what a checklist should show.
 */
export async function validateListingLaunchReadiness(input: {
  listingId: string
  suppliedMlsNumber?: string
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

    // A launch gate that could not READ is not a gate that passed — and a
    // failed photo COUNT would otherwise come back as `count ?? 0` and be
    // reported to the agent as "you have no photos", sending them to re-upload
    // media that is already there.
    if (listingResult.error)   return { success: false, error: `Could not read the listing: ${listingResult.error.message}` }
    if (!listingResult.data)   return { success: false, error: "Listing not found" }
    if (mediaCountResult.error) return { success: false, error: `Could not count the listing's photos: ${mediaCountResult.error.message}` }

    const listing = listingResult.data
    const blockers: string[] = []

    if (!listing.seller_contact_id) blockers.push("No seller contact linked")
    if (!listing.list_price)        blockers.push("No list price set")
    if (!(listing.mls_number?.trim() || input.suppliedMlsNumber?.trim()))
      blockers.push("No MLS number entered")

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
  // Pass the number we are launching WITH — see the note on the gate. Without
  // this, the only writer of mls_number can never satisfy the mls_number check.
  const readiness = await validateListingLaunchReadiness({
    listingId: input.listingId,
    suppliedMlsNumber: input.mlsNumber,
  })
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

    // Emit lifecycle event — brokerage_id is NOT NULL (pass 5): the launch
    // event never landed without it. The updated listing row carries it.
    // `to_state` is the key transitionLifecycle uses and the key every timeline
    // reader looks for; `stage` is kept alongside it for the older readers.
    const { error: launchEventError } = await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: (listing as any)?.brokerage_id ?? null,
        entity_type:  "listing",
        entity_id:    input.listingId,
        event_type:   "listing_stage_active",
        metadata:     { mls_number: input.mlsNumber, actor: input.actorUserId, to_state: "MLS_ACTIVE", stage: "MLS_ACTIVE" },
        created_at:   new Date().toISOString(),
      })
    if (launchEventError) {
      console.error("[launchListing] lifecycle_events insert failed — the launch is not in the listing's history:", launchEventError.message)
    }

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

// ─── 8. (attachMediaToListing removed — see note above MediaAttachmentInput) ──

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

    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type, showing_instructions, brokerage_id")
      .eq("id", input.listingId)
      .maybeSingle()

    if (listingError) return { success: false, error: `Could not read the listing: ${listingError.message}` }
    if (!listing)     return { success: false, error: "Listing not found" }

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
          // The listing this text is FOR already exists — it was loaded above —
          // so approval_items.item_id is written directly by the insert and the
          // reviewer's queue entry opens the listing. No second write, and no
          // window in which the flagged item is unlinked.
          // `input.listingId` — isValidUUID-checked at the top and the key the
          // row above was resolved by. The select does not name `id`, and reading
          // it off `listing` would have been undefined.
          subjectId: input.listingId,
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

// ─── 10. (createTransactionShellFromAcceptedOffer removed) ───────────────────
//
// REMOVED as a duplicate (merge-then-delete, owner-sanctioned). SURVIVOR:
// lib/transactions/offer-bridge.ts:createTransactionFromOffer — the documented
// single source of truth for transaction creation, live on three paths
// (seller-offers.ts acceptOffer, buyer-offer/convert-to-transaction.ts,
// buyer-offer/submit-to-compliance.ts). The shell omitted the readiness gate,
// contract facts, milestone seeding, the offers.transaction_id back-link and
// the cost breakdown, and stamped buyer_contact_id unconditionally — a defect
// the bridge already fixed. Nothing it did is missing on the survivor.

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
 * Compose a brokerage's office address the way it should read on a form:
 * "123 Main St, Suite 200, Pensacola, FL 32501".
 *
 * Every column is nullable and both live brokerages currently hold NULL for
 * street and zip, so this NEVER emits a placeholder, an empty string or a bare
 * comma: parts that are missing are dropped, the city/state/zip line collapses
 * to whichever of them exist ("FL 32501", "Pensacola", "32501"), and an address
 * with no parts at all comes back `undefined` so the caller writes NULL rather
 * than printing punctuation into a contract.
 *
 * Whitespace-only values count as missing — a column holding " " would
 * otherwise contribute a comma and nothing else.
 */
function composeBrokerageAddress(brokerage: {
  address?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
} | null | undefined): string | undefined {
  const clean = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null

  const street = clean(brokerage?.address)
  const suite  = clean(brokerage?.address_line2)
  const city   = clean(brokerage?.city)
  const state  = clean(brokerage?.state)
  const zip    = clean(brokerage?.zip)

  // City and state are comma-separated; the postcode follows the state with a
  // SPACE, not a comma — "Pensacola, FL 32501".
  const locality = [[city, state].filter(Boolean).join(", "), zip]
    .filter((part) => part && part.length > 0)
    .join(" ")

  const parts = [street, suite, locality].filter((part) => part && part.length > 0)
  return parts.length > 0 ? parts.join(", ") : undefined
}

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

    const { data: listing, error: prefillError } = await supabase
      .from("listings")
      .select(`
        id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type,
        seller:seller_contact_id(id, first_name, last_name, email, phone),
        agent:agent_id(
          id, brokerage_id,
          users:user_id(first_name, last_name, email),
          license_number, license_state,
          brokerage:brokerage_id(name, address, address_line2, city, state, zip, phone, license_number)
        )
      `)
      .eq("id", input.listingId)
      .maybeSingle()

    // This payload carries a seller's name, email and phone plus the brokerage's
    // licence block. A refused read must say so — reporting it as "Listing not
    // found" sends the agent looking for a listing that is plainly there while
    // the form they are about to send goes out with an empty licence block.
    if (prefillError) return { success: false, error: `Could not read the listing: ${prefillError.message}` }
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
      // The brokerage's OFFICE ADDRESS, composed from the columns the table now
      // actually has. History, because it decides what this line may and may not
      // do: this embed once asked for `brokerages.address` when no such column
      // existed — PostgREST rejects an unknown column in a nested select, and the
      // whole prefill (agent name, agent licence, brokerage name, phone, licence)
      // failed for EVERY listing, silently, because the error was swallowed into a
      // generic result shape. m456 added the real columns (`address`,
      // `address_line2`, `zip`, verified in information_schema), so the street line
      // is read rather than guessed at, and `brokerage_address` — a REQUIRED brand
      // field for email and direct mail (lib/brand-template-registry/
      // brand-requirements.ts:90,127) — can finally carry a physical address.
      //
      // NOTHING IS INVENTED. Every part is optional in the schema and both live
      // brokerages currently store NULL for street and zip. A form that prints
      // ", ," is worse than a blank one, so parts that are null are dropped and an
      // address with no parts at all is `undefined`, never "" and never a stray
      // comma. See composeBrokerageAddress above.
      brokerageAddress:   composeBrokerageAddress(brokerage),
      brokeragePhone:     brokerage.phone,
      brokerageLicense:   brokerage.license_number,
    }

    return { success: true, prefillData }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "prefillListingFormFromRecord failed" }
  }
}
