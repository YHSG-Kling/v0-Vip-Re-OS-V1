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
import { archiveListing as archiveListingRecord, unarchiveListing as unarchiveListingRecord } from "@/lib/kernel/listing-archive"
import { KernelEvent } from "@/lib/kernel/events"

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

/**
 * A LISTING IS ARCHIVED, NOT DELETED.
 *
 * TOMBSTONE — `deleteListing` was HERE and is gone. Its survivor is
 * `archiveListing`, this function, on `lib/kernel/listing-archive.ts:archiveListing`.
 *
 * OWNER'S RULING, which reverses the previous wave:
 *
 *     "listing shouldn't be deleted because of rules of needing to keep real
 *      estate records."
 *
 * What was here: a child-safe HARD delete that had just closed a real defect
 * (`deleteListing` was one statement against a table with 63 foreign keys onto
 * it — 31 refused with a raw 23503, 16 SET NULL keys let it succeed while
 * clearing their pointers unseen). That fix worked. It was the wrong operation:
 * a listing is a real-estate record under a statutory retention window, and
 * "the broker wants it off their board" is not a reason to destroy one.
 *
 * NOTHING WAS THROWN AWAY TO GET HERE. The 63-key manifest that wave measured is
 * the retention ledger in `lib/kernel/listing-archive.ts:LISTING_CHILD_RULES`,
 * read backwards: every `remove` and `cascade` key names rows the delete
 * DESTROYED and the archive keeps, and every `detach` key names a pointer the
 * delete NULLED and the archive keeps — `transactions.listing_id` above all,
 * which is how a closed deal finds the property it closed on.
 *
 * THE ENGINE IS NOT RETIRED EITHER. `lib/kernel/child-safe-delete.ts` still
 * serves `lib/kernel/tenant-creation-rollback.ts`, which is a genuine hard
 * delete of a half-built tenant with no records to retain, and which this ruling
 * does not touch. It simply no longer has a second caller.
 *
 * The state lives in `listings.deleted_at`, not in `status` — `status` is the
 * record's own field (sold / withdrawn / expired) and overwriting it would
 * destroy the fact retention exists to keep, quite apart from the live
 * `listings_status_check` refusing the value. The full column argument and the
 * reader evidence behind it are in the archive module's header.
 */
export async function archiveListing(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    // ACT-AS WRITE SEAM — a read_only grant never writes.
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }

    // Gate first, THEN the service client (CLAUDE.md §4). The tenant comes from
    // the session; `listingId` is a parameter and is therefore not trusted until
    // this read ties it to that tenant.
    const supabase = createServiceClient()

    const { data: owned, error: ownedErr } = await supabase
      .from("listings")
      .select("id, brokerage_id")
      .eq("id", listingId)
      .maybeSingle()

    // supabase-js RESOLVES refusals (§3). A read that failed has NOT proved the
    // listing absent, and "nobody checked" must not render as "checked and fine"
    // — so a failed ownership check refuses instead of falling through.
    if (ownedErr) return { success: false, error: "Could not verify this listing. Nothing was changed." }
    if (!owned) return { success: false, error: "Listing not found" }
    if (owned.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

    const result = await archiveListingRecord(supabase, listingId, auth.brokerageId)
    if (!result.ok) {
      return { success: false, error: result.error ?? "This listing could not be archived." }
    }

    // AUDIT. A retention record that leaves the working surface must say who
    // took it off and when — that is the half a hard delete could never have.
    // Best-effort and voided: the archive already happened and must not be
    // reported as failed because an audit insert did.
    await supabase.from("lifecycle_events").insert({
      entity_type:   "listing",
      entity_id:     listingId,
      event_type:    KernelEvent.LISTING_ARCHIVED,
      brokerage_id:  auth.brokerageId,
      // The REAL accountable actor — under staff act-as this is the
      // impersonator, not the impersonated identity.
      actor_user_id: auth.actorUserId ?? null,
      created_at:    result.outcome.archivedAt,
      metadata: {
        // The record's own status, READ BACK rather than written. Proof in the
        // audit trail that archiving did not rewrite what the listing was.
        status_at_archive: result.outcome.statusAfter,
        retained_rows:     result.outcome.retainedTotal,
        retained_tables:   Object.keys(result.outcome.retained).length,
      },
    }).then(() => null, () => null)

    revalidatePath("/listings")
    revalidatePath("/dashboard")

    return {
      success: true,
      // WHAT SURVIVED. The delete that stood here reported `removed` and
      // `detached`; this reports the opposite number, which is the point of the
      // reversal — these are the rows a delete would have destroyed or unlinked.
      retained:      result.outcome.retained,
      retainedTotal: result.outcome.retainedTotal,
      status:        result.outcome.statusAfter,
      archivedAt:    result.outcome.archivedAt,
    }
  } catch (error) {
    return handleError(error, "archiveListing")
  }
}

/**
 * THE WAY BACK. Built, not optional.
 *
 * A record that can be hidden and never un-hidden has been destroyed as far as
 * the person looking for it is concerned, and "keep real estate records" is not
 * satisfied by a one-way door. This is the second half of the archive
 * (CLAUDE.md §1.2 — when a capability has only one half and the other is wanted,
 * BUILD it), and without it `archiveListing` would be a delete with extra steps.
 */
export async function unarchiveListing(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }

    const supabase = createServiceClient()

    const { data: owned, error: ownedErr } = await supabase
      .from("listings")
      .select("id, brokerage_id")
      .eq("id", listingId)
      .maybeSingle()

    if (ownedErr) return { success: false, error: "Could not verify this listing. Nothing was changed." }
    if (!owned) return { success: false, error: "Listing not found" }
    if (owned.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

    const result = await unarchiveListingRecord(supabase, listingId, auth.brokerageId)
    if (!result.ok) return { success: false, error: result.error ?? "This listing could not be restored." }

    await supabase.from("lifecycle_events").insert({
      entity_type:   "listing",
      entity_id:     listingId,
      event_type:    KernelEvent.LISTING_UNARCHIVED,
      brokerage_id:  auth.brokerageId,
      actor_user_id: auth.actorUserId ?? null,
      created_at:    new Date().toISOString(),
      metadata:      {},
    }).then(() => null, () => null)

    revalidatePath("/listings")
    revalidatePath("/dashboard")

    return { success: true }
  } catch (error) {
    return handleError(error, "unarchiveListing")
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
