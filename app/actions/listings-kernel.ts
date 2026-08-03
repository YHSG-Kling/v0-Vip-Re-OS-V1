"use server"
/**
 * app/actions/listings-kernel.ts
 * Thin "use server" wrappers over lib/kernel/listings.ts.
 *
 * Pattern:
 *   1. Auth — get session user
 *   2. Resolve context — brokerage_id, agent_id (agents.id FK, not users.id)
 *   3. Validate caller scope (same brokerage)
 *   4. Delegate to kernel command
 *   5. revalidatePath on mutation
 *
 * NEVER implement business logic here. All logic lives in lib/kernel/listings.ts.
 */

import { revalidatePath } from "next/cache"
import {
  verifyMlsSyndication,
  type MlsVerification,
  type MlsFeedObservation,
  type MlsFeedSource,
} from "@/lib/listings/mls-verification"
import { createClient } from "@/lib/supabase/server"
import { LISTING_STATUSES, isListingStatus } from "@/lib/constants"
import {
  createListingRecord,
  createOrAttachSellerContact,
  loadListingWorkspace,
  saveListingDraft,
  validateListingLaunchReadiness,
  launchListing,
  updateListingStage,
  attachMediaToListing,
  generateListingDescription,
  createTransactionShellFromAcceptedOffer,
  closeListingLifecycle,
  prefillListingFormFromRecord,
  type CreateListingInput,
  type SellerContactInput,
  type ListingUpdate,
  type MediaAttachmentInput,
  type ListingStage,
} from "@/lib/kernel/listings"

// ─── Auth context helper ──────────────────────────────────────────────────────

async function resolveCallerContext() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" as const }

  // Resolve brokerage_id and the real agents.id (FK, not users.id)
  const [userRow, agentRow] = await Promise.all([
    supabase
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  const brokerageId = agentRow.data?.brokerage_id ?? userRow.data?.brokerage_id
  if (!brokerageId) return { error: "No brokerage found for this user" as const }

  return {
    userId:      user.id,
    agentId:     agentRow.data?.id ?? null,   // agents.id (NOT users.id); null for broker/admin without an agent profile
    brokerageId,
    userType:    userRow.data?.user_type ?? "agent",
  }
}

// ─── Action: resolveListingIdByMls ───────────────────────────────────────────

/**
 * Resolve an MLS number typed by an agent to one of THIS brokerage's listing ids.
 *
 * The offer wizard collects an MLS number and used to drop that string straight
 * into `offers.listing_id`, which is a uuid FK — so any agent who actually filled
 * the field in got a failed insert, and any agent who left it blank got an offer
 * with no listing attached. This is the missing translation step.
 *
 * Returns `{ listingId: null }` when nothing matches: an offer on a property this
 * brokerage does not list is completely normal, and it must not block the offer.
 */
export async function resolveListingIdByMlsAction(mlsNumber: string): Promise<{
  success: boolean
  listingId: string | null
  error?: string
}> {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, listingId: null, error: ctx.error }

  const trimmed = mlsNumber?.trim()
  if (!trimmed) return { success: true, listingId: null }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("listings")
    .select("id")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("mls_number", trimmed)
    .maybeSingle()

  if (error) return { success: false, listingId: null, error: error.message }
  return { success: true, listingId: data?.id ?? null }
}

// ─── Action: createListingWithSellerContact ───────────────────────────────────

/**
 * Called from ListingCreateSheet and from the New Listing wizard (FormWizard,
 * mode="listing").
 *
 * Creates a seller contact (or attaches existing) then creates the listing record.
 * The listing lands as a DRAFT — see createListingRecord for the rule. It becomes
 * a real listing only when the signed agreement clears the compliance check.
 */
export async function createListingWithSellerContact(params: {
  sellerFirstName: string
  sellerLastName: string
  sellerEmail?: string
  sellerPhone?: string
  address: string
  city: string
  state: string
  zip: string
  listPrice?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  propertyType?: string
  /** Form IDs selected during the listing initiation flow */
  selectedFormIds?: string[]
  /** Field values keyed by form name then field name */
  formFieldValues?: Record<string, Record<string, string>>
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  // Step 1: Find or create seller contact
  const sellerResult = await createOrAttachSellerContact({
    brokerageId: ctx.brokerageId,
    agentId:     ctx.agentId,
    firstName:   params.sellerFirstName,
    lastName:    params.sellerLastName,
    email:       params.sellerEmail,
    phone:       params.sellerPhone,
  })
  if (!sellerResult.success) return { success: false, error: sellerResult.error }

  // Step 2: Create listing record
  const listingResult = await createListingRecord({
    agentId:          ctx.agentId,
    sellerContactId:  sellerResult.contactId,
    brokerageId:      ctx.brokerageId,
    address:          params.address,
    city:             params.city,
    state:            params.state,
    zip:              params.zip,
    listPrice:        params.listPrice,
    bedrooms:         params.bedrooms,
    bathrooms:        params.bathrooms,
    sqft:             params.sqft,
    propertyType:     params.propertyType,
  })
  if (!listingResult.success) return { success: false, error: listingResult.error }

  const newListingId = (listingResult.listing as any).id as string

  // Step 3: Persist form field data collected during the initiation flow (non-fatal)
  if (params.selectedFormIds?.length && params.formFieldValues) {
    try {
      const { saveFormDraft } = await import("@/lib/kernel/forms")
      for (const formId of params.selectedFormIds) {
        const fields = params.formFieldValues[formId]
        if (fields && Object.keys(fields).length > 0) {
          await saveFormDraft({
            brokerage_id: ctx.brokerageId,
            agent_id:     ctx.agentId,
            form_name:    formId,
            context_type: "listing",
            context_id:   newListingId,
            field_values: fields,
          }).catch((err: unknown) => {
            console.error("[createListingWithSellerContact] Form draft save failed (non-fatal):", err)
          })
        }
      }
    } catch (err) {
      console.error("[createListingWithSellerContact] Form draft import failed (non-fatal):", err)
    }
  }

  revalidatePath("/dashboard/listings")

  return {
    success:  true,
    listing:  listingResult.listing,
    listingId: newListingId,
    sellerCreated: sellerResult.created,
  }
}

// ─── Action: saveListingDraftAction ──────────────────────────────────────────

export async function saveListingDraftAction(params: {
  listingId: string
  updates: Partial<ListingUpdate>
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await saveListingDraft({
    listingId:    params.listingId,
    updates:      params.updates,
    actorUserId:  ctx.userId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}`)
    revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)
  }

  return result
}

// ─── Action: validateLaunchReadinessAction ────────────────────────────────────

export async function validateLaunchReadinessAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }
  return validateListingLaunchReadiness({ listingId })
}

// ─── Action: verifyMlsSyndicationAction ──────────────────────────────────────

/**
 * OWNER RULING: "the admin needs to add the actual listing that is in house
 * manually to the mls or state mls but verification that it is actually live on
 * the mls can be checked in rentcast or the tenants(subscriber) idxbroker."
 *
 * So this does NOT fetch a number for the agent to paste. The agent already has
 * the number — they typed it into the MLS themselves. This asks the opposite
 * question, which nothing in the OS ever asked before:
 *
 *   The OS says this listing is live on the MLS. Is it?
 *
 * The feeds the brokerage already pays for are the only outside parties that can
 * answer. See lib/listings/mls-verification.ts for the four honest verdicts and
 * why "no feed connected" must never render as "not on the MLS".
 */
export async function verifyMlsSyndicationAction(listingId: string): Promise<{
  success: boolean
  verification?: MlsVerification
  error?: string
}> {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const supabase = await createClient()
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, address, city, state, zip, brokerage_id, mls_number, listing_date, updated_at")
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (listingError) return { success: false, error: listingError.message }
  if (!listing) return { success: false, error: "Listing not found in your brokerage" }

  const target = normalizeStreet(listing.address as string | null)
  if (!target) return { success: false, error: "This listing has no street address to match on" }

  const observations: MlsFeedObservation[] = []
  const consulted: MlsFeedSource[] = []

  // ── Feed 1: RentCast's for-sale index, narrowed to this listing's zip/city.
  const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
  const rc = await searchRentcastSaleListings({
    brokerageId: ctx.brokerageId,
    filters: {
      zipCode: (listing.zip as string | null) ?? undefined,
      city: (listing.zip ? undefined : (listing.city as string | null)) ?? undefined,
      state: (listing.state as string | null) ?? undefined,
      limit: 50,
    },
  })
  // A FAILED search is NOT an empty search. Only a feed we actually reached
  // counts as consulted — otherwise a 401 from RentCast would silently become
  // "your listing is not on the MLS", which is the worst possible lie here.
  if (rc.success) {
    consulted.push("rentcast")
    for (const l of rc.listings) {
      if (normalizeStreet(l.address) !== target) continue
      observations.push({
        source: "rentcast",
        mlsNumber: l.mlsNumber,
        mlsName: l.mlsName,
        address: l.address,
        status: l.status,
      })
    }
  }

  // ── Feed 2: the brokerage's own IDX connection, when they have one.
  try {
    const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
    const idx = await IDXBrokerClient.forBrokerage(ctx.brokerageId, { agentUserId: ctx.userId })
    if (idx.isConfigured()) {
      consulted.push("idx")
      const rows = await idx.searchActiveListings({
        city: (listing.city as string | null) ?? undefined,
        state: (listing.state as string | null) ?? undefined,
        zipCode: (listing.zip as string | null) ?? undefined,
      })
      for (const l of rows) {
        if (normalizeStreet(l.address) !== target) continue
        observations.push({
          source: "idx",
          mlsNumber: l.mlsNumber,
          mlsName: null,
          // searchActiveListings only ever returns ACTIVE rows — that is the
          // method's contract and its name. Saying so beats leaving status null,
          // which isActiveOnFeed would (correctly) refuse to treat as live.
          address: l.address,
          status: "active",
        })
      }
    }
  } catch {
    // Unreachable IDX is not a finding about the listing. It stays out of
    // `consulted`, so the verdict degrades to unverifiable rather than lying.
  }

  const verification = verifyMlsSyndication(
    {
      storedMlsNumber: (listing.mls_number as string | null) ?? null,
      liveSince: ((listing.listing_date as string | null) ?? (listing.updated_at as string | null)) ?? null,
    },
    observations,
    consulted,
  )

  return { success: true, verification }
}

/**
 * Street-line comparison key. Deliberately CONSERVATIVE: it only strips the
 * things that are pure formatting (case, punctuation, whitespace runs) and
 * normalises the handful of suffixes that every feed spells differently. It does
 * NOT try to be clever about unit numbers or directionals — a near-match this
 * calls "different" costs a `pending` verdict the agent can dismiss, while a
 * near-match it wrongly calls "same" would compare our listing against SOMEONE
 * ELSE'S MLS number and could raise a false contradiction against a correct row.
 */
function normalizeStreet(raw: string | null | undefined): string | null {
  if (!raw) return null
  const first = raw.split(",")[0] ?? raw
  const s = first
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!s) return null
  const SUFFIX: Record<string, string> = {
    street: "st", avenue: "ave", av: "ave", boulevard: "blvd", drive: "dr",
    road: "rd", lane: "ln", court: "ct", circle: "cir", place: "pl",
    terrace: "ter", parkway: "pkwy", highway: "hwy", trail: "trl", way: "way",
    north: "n", south: "s", east: "e", west: "w",
    northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  }
  return s.split(" ").map((w) => SUFFIX[w] ?? w).join(" ")
}

// ─── Action: launchListingAction ─────────────────────────────────────────────

export async function launchListingAction(params: {
  listingId: string
  mlsNumber: string
  mlsLink?: string
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await launchListing({
    listingId:   params.listingId,
    mlsNumber:   params.mlsNumber,
    mlsLink:     params.mlsLink,
    actorUserId: ctx.userId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}`)
    revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)
    revalidatePath("/dashboard/listings")

    // Auto-generate QR code for listing inquiry — non-fatal
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const { data: listing } = await svc
        .from("listings")
        .select("id, address, brokerage_id, agent_id")
        .eq("id", params.listingId)
        .maybeSingle()

      if (listing) {
        // THE PACKET THE WHOLE MODULE IS NAMED FOR. app/actions/ai-listing-packet.ts
        // opens with "GENERATES COMPREHENSIVE PROPERTY PACKETS FOR DISPLAY AFTER
        // LISTING GOES LIVE ON MLS" and ends with autoGeneratePacketOnLive — which
        // nothing called, so the packet only ever existed if an agent found the
        // panel on the lifecycle page and asked for it by hand. This is the "goes
        // live" moment: launchListing has just stamped the MLS number and taken the
        // listing to ACTIVE, which is also what generateListingPacket's own
        // MLS-live gate requires.
        //
        // Guarded by an existing-job check so a re-launch does not re-spend six
        // GPT-4o generations, and DISPATCHED rather than awaited (same pattern as
        // the promo-video / lifecycle-mail reactors below) because the agent must
        // not wait on document generation to learn their listing went live.
        try {
          const { data: existingPacket } = await svc
            .from("listing_packet_jobs")
            .select("id")
            .eq("listing_id", params.listingId)
            .eq("job_type", "full_packet")
            .limit(1)
            .maybeSingle()
          if (!existingPacket) {
            const { autoGeneratePacketOnLive } = await import("@/app/actions/ai-listing-packet")
            void autoGeneratePacketOnLive(params.listingId, ctx.userId).then((r) => {
              if (!r?.success) {
                console.error("[launchListing] listing packet NOT generated:", r?.error)
              }
            })
          }
        } catch (err) {
          console.error("[launchListing] listing packet dispatch failed:", err)
        }

        // CONSENSUS MEMORY — launching a listing is a STRATEGIC play: raise a pre-launch huddle to the
        // Shopping Agent for a read on live buyer appetite at this price (listing_launch → shopping_agent).
        // The outcome resolves it later — a deal closing on this listing proves the read right, the listing
        // expiring proves it wrong (consult-outcome-resolver) — so the pre-launch pricing read builds a
        // track record over time. Best-effort; never blocks the launch.
        try {
          const { requestSecondOpinion } = await import("@/lib/kernel/second-opinion-runner")
          await requestSecondOpinion({
            brokerageId: (listing as any).brokerage_id, fromManager: "listing_concierge",
            playType: "listing_launch", entityType: "listing", entityId: params.listingId,
            context: "pre-launch read on buyer appetite at this price",
          }, svc)
        } catch {
          // Non-fatal — the huddle is an enhancement, the launch proceeds.
        }

        const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        if (!baseUrl) {
          // Base URL not configured — skip QR generation but continue action
        } else {
        const targetUrl = `${baseUrl}/listings/${listing.id}`
        // qr_codes.slug is globally unique — suffix with base36 timestamp.
        const slug = `listing-${listing.id.slice(0, 8)}-${Date.now().toString(36)}`
        const { data: existing } = await svc
          .from("qr_codes")
          .select("id")
          .eq("listing_id", params.listingId)
          .eq("purpose", "listing")
          .maybeSingle()

        if (!existing) {
          await svc.from("qr_codes").insert({
            brokerage_id: listing.brokerage_id,
            agent_id:     listing.agent_id,
            listing_id:   params.listingId,
            label:        `Listing — ${listing.address}`,
            slug,
            target_url:   targetUrl,
            // qr_codes.purpose CHECK only allows: listing, open_house, event,
            // business_card, general. 'listing_inquiry' was invalid and the
            // insert would fail the constraint.
            purpose:      "listing",
            scan_count:   0,
            lead_count:   0,
            is_active:    true,
          })
        }
        } // end else (baseUrl exists)
      }
    } catch {
      // Non-fatal — QR generation is a best-effort enhancement
    }
  }

  return result
}

// ─── Action: updateListingStageAction ────────────────────────────────────────

export async function updateListingStageAction(params: {
  listingId: string
  targetStage: ListingStage
  notes?: string
  overrideReason?: string
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await updateListingStage({
    listingId:      params.listingId,
    targetStage:    params.targetStage,
    actorUserId:    ctx.userId,
    notes:          params.notes,
    overrideReason: params.overrideReason,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)
    revalidatePath("/dashboard/listings")
  }

  return result
}

// ─── Action: attachMediaAction ────────────────────────────────────────────────

export async function attachMediaAction(params: {
  listingId: string
  fileUrl: string
  mediaType: "photo" | "video" | "document" | "virtual_tour"
  isPrimary?: boolean
  caption?: string
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await attachMediaToListing({
    listingId:   params.listingId,
    brokerageId: ctx.brokerageId,
    fileUrl:     params.fileUrl,
    mediaType:   params.mediaType,
    uploadedBy:  ctx.userId,
    isPrimary:   params.isPrimary,
    caption:     params.caption,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}`)
  }

  return result
}

// ─── Action: generateListingDescriptionAction ────────────────────────────────

export async function generateListingDescriptionAction(params: {
  listingId: string
  style?: "luxury" | "family" | "investment" | "standard"
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  return generateListingDescription({
    listingId: params.listingId,
    agentId:   ctx.agentId,
    style:     params.style,
  })
}

// ─── Action: createTransactionFromOfferAction ────────────────────────────────

export async function createTransactionFromOfferAction(params: {
  listingId: string
  offerId: string
}) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await createTransactionShellFromAcceptedOffer({
    listingId:   params.listingId,
    offerId:     params.offerId,
    agentId:     ctx.agentId,
    brokerageId: ctx.brokerageId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${params.listingId}`)
    revalidatePath("/dashboard/transactions")
  }

  return result
}

// ─── Action: closeListingAction ───────────────────────────────────────────────

export async function closeListingAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }

  const result = await closeListingLifecycle({
    listingId,
    actorUserId: ctx.userId,
  })

  if (result.success) {
    revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
    revalidatePath("/dashboard/listings")
  }

  return result
}

// ─── Action: prefillListingFormAction ────────────────────────────────────────

export async function prefillListingFormAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }
  return prefillListingFormFromRecord({ listingId })
}

// ─── Action: loadListingWorkspaceAction ──────────────────────────────────────

export async function loadListingWorkspaceAction(listingId: string) {
  const ctx = await resolveCallerContext()
  if ("error" in ctx) return { success: false, error: ctx.error }
  return loadListingWorkspace({ listingId, userId: ctx.userId })
}

// ─── Action: updateListingStatus (migrated from listings.ts) ─────────────────

export async function updateListingStatus(listingId: string, status: string) {
  const supabase = await createClient()
  try {
    // VOCABULARY GATE. `status` arrives as free text from a client picker, and
    // listings.status is CHECK-constrained — so an unadmitted value reached the
    // database and came back as a raw constraint error that names no valid
    // phases. The picker offered "under_contract" (a TRANSACTION status) for
    // exactly this reason: nothing here disagreed with it. Validated against the
    // one canonical list the picker now renders from, so the two cannot drift.
    if (!isListingStatus(status)) {
      return {
        success: false,
        error: `'${status}' is not a listing phase. Valid: ${LISTING_STATUSES.join(", ")}`,
      }
    }

    // Auth + ownership check — was previously open IDOR
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }
    const { data: callerRow } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

    const { data: listingRow } = await supabase
      .from("listings")
      .select("brokerage_id")
      .eq("id", listingId)
      .maybeSingle()
    if (!listingRow) return { success: false, error: "Listing not found" }
    if (listingRow.brokerage_id !== callerRow.brokerage_id) {
      return { success: false, error: "Forbidden" }
    }

    // current_stage was renamed to lifecycle_stage (migration 1014) and the
    // CHECK requires the uppercase enum (CLOSED / LISTING_CANCELLED), so the
    // old { current_stage: "closed" | "cancelled" } update threw on both the
    // column and the value.
    const { data, error } = await supabase
      .from("listings")
      .update({
        status,
        lifecycle_stage:
          status === "sold" ? "CLOSED" : status === "withdrawn" ? "LISTING_CANCELLED" : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listingId)
      // tenant anchor (scope burn-down)
      .eq("brokerage_id", callerRow.brokerage_id)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/listings")
    revalidatePath(`/dashboard/listings/${listingId}`)
    revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
    return { success: true, listing: data }
  } catch (error) {
    console.error("updateListingStatus error:", error)
    return { success: false, error: "Failed to update listing status" }
  }
}
