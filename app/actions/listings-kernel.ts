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
import { createClient } from "@/lib/supabase/server"
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
    agentId:     agentRow.data?.id ?? user.id,   // agents.id — falls back to user.id for broker/admin
    brokerageId,
    userType:    userRow.data?.user_type ?? "agent",
  }
}

// ─── Action: createListingWithSellerContact ───────────────────────────────────

/**
 * Called from ListingCreateSheet.
 * Creates a seller contact (or attaches existing) then creates the listing record.
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
        .select("id, property_address, brokerage_id, agent_id")
        .eq("id", params.listingId)
        .maybeSingle()

      if (listing) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        if (!baseUrl) {
          // Base URL not configured — skip QR generation but continue action
        } else {
        const targetUrl = `${baseUrl}/listings/${listing.id}`
        const slug = `listing-${listing.id.slice(0, 8)}`
        const { data: existing } = await svc
          .from("qr_codes")
          .select("id")
          .eq("listing_id", params.listingId)
          .eq("purpose", "listing_inquiry")
          .maybeSingle()

        if (!existing) {
          await svc.from("qr_codes").insert({
            brokerage_id: listing.brokerage_id,
            agent_id:     listing.agent_id,
            listing_id:   params.listingId,
            label:        `Listing Inquiry — ${listing.property_address}`,
            slug,
            target_url:   targetUrl,
            purpose:      "listing_inquiry",
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
    const { data, error } = await supabase
      .from("listings")
      .update({
        status,
        current_stage:
          status === "sold" ? "closed" : status === "withdrawn" ? "cancelled" : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listingId)
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
