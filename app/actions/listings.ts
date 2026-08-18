"use server"

import { revalidatePath } from "next/cache"
import { getListingsService, createListingService } from "@/lib/application/listings"
import { getListingTimelineService } from "@/lib/application/listing-lifecycle"
import { createServiceClient } from "@/lib/supabase/service"
import { handleError } from "@/lib/errors"
import { assignTierToListing } from "@/lib/listings/tier-assigner"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveActingContext, READ_ONLY_ACTING_ERROR } from "@/lib/platform/acting-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * CRUD operations for listings
 * Re-exported through index.ts
 *
 * Every read + write previously skipped the auth.getUser() check. Reads
 * leaned on RLS policies (which work for authed users but tell anonymous
 * callers that listings exist by responding with empty arrays vs. errors),
 * but every write (update/delete) ran without verifying the caller had
 * any relationship to the listing's brokerage. updateListing also accepted
 * an actorUserId param which was used for tier-assignment audit — caller
 * could spoof anyone.
 */

// ★ ACT-AS WRITE SEAM ★ — this gate used to read users.brokerage_id for the RAW
// auth.uid(), so a platform-staff member acting-as a tenant (who has no
// brokerage of their own) was refused "Unauthorized" even though getAgentContext
// had already resolved the target tenant. It now resolves through the
// impersonation-aware acting context: the effective tenant under an ACTIVE
// grant (re-validated on this very call), the caller's own tenant otherwise.
// `readOnly` is surfaced so WRITERS refuse a 'read_only' grant; the reads
// (getListingById) stay available to it. `actorUserId` is the REAL actor for
// every audit lane. New tenant writers: adopt resolveWriteContext/-ActingContext.
async function requireCaller(): Promise<
  | { ok: true; userId: string; actorUserId: string; brokerageId: string; readOnly: boolean }
  | { ok: false; error: string }
> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.userId) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  return {
    ok: true,
    userId: ctx.userId,
    actorUserId: ctx.actorUserId,
    brokerageId: ctx.brokerageId,
    readOnly: ctx.readOnly,
  }
}

/**
 * ABSORBED (wave 16) from the retired /api/dashboard/data `listings` branch: the
 * SESSION-DERIVED tenant filter and the session-pinned agent scope.
 *
 * This delegated straight through with whatever the caller passed, and the
 * service applies `agent_id` only when given and no tenant filter at all — so
 * `getListings()` returned every listing on the platform and
 * `getListings({ agentId })` returned any agent's book. The tenant now comes
 * from the session and is not overridable; a caller-supplied agent id may only
 * NARROW, and only for a broker/admin inside their own tenant.
 */
export async function getListings(params?: {
  agentId?: string
  status?: string
  stage?: string
  limit?: number
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false as const, error: "Not authenticated", listings: [] as unknown[] }
  }
  if (!ctx.brokerageId) {
    return {
      success: false as const,
      error: "Your account is not linked to a brokerage yet.",
      listings: [] as unknown[],
    }
  }

  if (params?.agentId && !UUID_REGEX.test(params.agentId)) {
    return { success: false as const, error: "Invalid agent ID", listings: [] as unknown[] }
  }

  // agents.id from the session — never a users.id, never a caller's claim.
  let agentFilter: string | undefined
  if (isAdminOrBroker({ user_type: ctx.userType })) {
    agentFilter = params?.agentId
  } else {
    if (!ctx.agentId) {
      return { success: false as const, error: "Agent profile not found", listings: [] as unknown[] }
    }
    agentFilter = ctx.agentId
  }

  return getListingsService({
    status: params?.status,
    stage: params?.stage,
    limit: params?.limit,
    agentId: agentFilter,
    brokerageId: ctx.brokerageId,
  })
}

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getListingById(listingId: string) {
  try {
    // Validate listingId is a proper UUID (not "new" or other invalid values)
    if (!listingId || !UUID_REGEX.test(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("listings")
      .select("*, seller_contact:seller_contact_id(id, first_name, last_name, email, phone), agent:agents!listings_agent_id_fkey(id, user_id)")
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (error) throw error

    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "getListingById")
  }
}

export async function createListing(params: {
  agentId: string
  sellerId: string
  address: string
  city: string
  state: string
  zip: string
  price?: number
  bedrooms?: number
  bathrooms?: number
  squareFootage?: number
  propertyType?: string
  listingType?: string
}) {
  // ADJACENT WRITER FIX (wave 16, not a merge): this never supplied the tenant,
  // and createListingService writes whatever it is given — so every row created
  // through this door carried a NULL brokerage_id and was therefore invisible to
  // the tenant-filtered reader above (and visible to any policy that admits an
  // untenanted row). Same class as the ai-auto-response stamp.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false as const, error: "Your account is not linked to a brokerage yet." }
  }

  const result = await createListingService({
    agentId: params.agentId,
    brokerageId: ctx.brokerageId,
    sellerContactId: params.sellerId,
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    listPrice: params.price,
    bedrooms: params.bedrooms,
    bathrooms: params.bathrooms,
    sqft: params.squareFootage,
    propertyType: params.propertyType,
  })
  if (result.success) {
    revalidatePath("/listings")
    revalidatePath("/dashboard")
  }
  return result
}

export async function updateListing(listingId: string, updates: any, _actorUserId?: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    // ACT-AS WRITE SEAM — a read_only grant never writes.
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    // The REAL actor (the staff member under act-as) — this id feeds the
    // tier-assignment audit lane below, so the trail names who really acted.
    const actorUserId = auth.actorUserId

    const supabase = createServiceClient()

    // Load current listing to verify ownership + capture pre-update price
    const { data: currentListing } = await supabase
      .from("listings")
      .select("brokerage_id, list_price, agent_id")
      .eq("id", listingId)
      .maybeSingle()
    if (!currentListing) return { success: false, error: "Listing not found" }
    if (currentListing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    const brokerageId = currentListing.brokerage_id as string
    const currentPrice = currentListing.list_price as number | null

    const priceUpdated = updates.list_price !== undefined || updates.price !== undefined

    // Never let caller-supplied updates change tenant ownership
    const safeUpdates = { ...updates }
    delete safeUpdates.brokerage_id
    delete safeUpdates.id

    const { data, error } = await supabase
      .from("listings")
      .update({ ...safeUpdates, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) throw error

    // Trigger tier assignment ONLY when price changes
    const newPrice = updates.list_price ?? updates.price
    if (priceUpdated && newPrice !== currentPrice) {
      await assignTierToListing(listingId, brokerageId, actorUserId).catch((err) => {
        console.error("[updateListing] Tier assignment failed (non-blocking):", err)
      })
      // PRICE-CHANGE LEDGER (writer-less burn-down): the seller portal's price
      // history read had NO writer — every price change now lands the ledger row
      // the portal renders. Best-effort; the update itself never fails on it.
      await supabase.from("listing_price_changes").insert({
        brokerage_id: brokerageId,
        listing_id: listingId,
        agent_id: (currentListing as any).agent_id ?? null,
        old_price: currentPrice,
        new_price: newPrice,
        change_reason: "manual_update",
        effective_date: new Date().toISOString().split("T")[0],
      }).then(() => undefined, (e: unknown) => console.error("[updateListing] price-change ledger:", e))
    }

    revalidatePath("/listings")
    revalidatePath(`/listings/${listingId}`)
    revalidatePath(`/dashboard/listings/${listingId}/marketing-tier`)

    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "updateListing")
  }
}

export async function deleteListing(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    // ACT-AS WRITE SEAM — a read_only grant never writes.
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }

    const supabase = createServiceClient()

    const { error } = await supabase
      .from("listings")
      .delete()
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)

    if (error) throw error

    revalidatePath("/listings")
    revalidatePath("/dashboard")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteListing")
  }
}

// updateListingStatus was migrated to app/actions/listings-kernel.ts
// Import it from there: import { updateListingStatus } from "@/app/actions/listings-kernel"

/**
 * DUPLICATE COLLAPSED — this was the SECOND copy of the listing-timeline read.
 *
 * It embedded `completed_by:profiles(first_name, last_name)`; there is no
 * public.profiles table in the live database, and PostgREST rejects the WHOLE
 * query when a select names a relation it cannot resolve — so this read never
 * returned a row. Its twin, getListingTimelineService, had already been
 * repointed at `users` (listing_stage_history.completed_by FKs users(id)) and
 * the fix never reached here, which is exactly what having two copies buys you.
 *
 * The query now lives in ONE place. The tenant ownership check this wrapper used
 * to perform moved INTO the service with it — see the note there — so nothing it
 * gated was given up; the service also reports its error instead of swallowing
 * it. What stays here is what a wrapper is for: shape validation and the
 * `{ success }` envelope this action's callers expect.
 */
export async function getListingTimeline(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const { timeline, error } = await getListingTimelineService(listingId)
    if (error) return { success: false, error }

    return { success: true, timeline }
  } catch (error) {
    return handleError(error, "getListingTimeline")
  }
}
