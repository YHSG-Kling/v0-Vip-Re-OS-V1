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
import { emitKernelEvent } from "@/lib/kernel/emit"

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

/**
 * REPORTED, NOT WIRED AND NOT DELETED (lane G4, 2026-08-28) — the verdict, so the
 * next pass does not re-derive it.
 *
 * This is the by-id listing RESOLVER, and it is deliberately the one read on this
 * rail that does NOT filter `deleted_at` — an archived listing must still open by
 * id or it has been destroyed in every sense that matters, which is what
 * scripts/listing-archive-simulator.ts pins it as a negative control for. That
 * makes it a WATCHED function rather than an abandoned one.
 *
 * It has no caller. It is NOT a duplicate that can be collapsed: the by-id reads
 * that exist are each narrower on purpose and are not interchangeable with it —
 * the lifecycle, media, offers and seller-update pages each select the columns
 * their own screen needs, server-side, and the offer wizard's read
 * (app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx) takes
 * three columns through the browser's RLS client. Repointing any of them at this
 * would push a `select("*")` listing row — `commission_rate` and
 * `seller_walkaway_price` included — onto an agent-facing client bundle, which
 * §5 forbids. There is one same-named twin, services/supabaseService.ts:
 * getListingById, and it is the WORSE half (admin client, no auth, no tenant
 * predicate, returns null on a refused read) and also has no caller — a
 * merge-then-delete onto THIS survivor is the right call, but that file is
 * outside this lane's set and is reported instead.
 *
 * The honest missing half is a listing surface that needs the whole record over
 * the wire, and none exists today. Build the surface, then wire this; do not
 * invent a caller for it.
 */
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

/**
 * THE HAND-EDIT WRITER, AND THE ONLY PRICE-CHANGE LANE.
 *
 * WIRED (lane G4, 2026-08-28): app/dashboard/listings/[id]/components/price-reduction-sheet.tsx.
 *
 * It was unreachable, and that mattered more than an unused export normally
 * does, because two capabilities hang off THIS function and nothing else:
 *
 *   1. `listing_price_changes` — read by the SELLER PORTAL's price history
 *      (app/actions/portal-seller.ts:228) and counted by the market-position
 *      snapshot (lib/intelligence/derived-snapshots.ts:48). The ledger's only
 *      writer is the insert below, so with no caller the seller's price history
 *      was permanently empty and `price_reduction_count` was permanently 0.
 *   2. `assignTierToListing` — marketing tier is priced off list price, so a
 *      price change that skips it leaves the tier assigned against a number
 *      that no longer exists.
 *
 * NOT A DUPLICATE of listings-kernel.ts:saveListingDraftAction, which was
 * checked end to end before wiring: that is the DESCRIPTION/marketing-copy edit
 * door (its live caller sends `public_remarks` only), it runs neither of the two
 * consequences above, and it holds an allow-list this one does not need because
 * its only caller passes one field. Different business process, same table —
 * merging them would have destroyed the price lane, not consolidated it.
 *
 * NOT A DUPLICATE of listing-lifecycle.ts:handlePriceReduction either. That is
 * the ORCHESTRATOR EVENT handler for `listing.price_reduction`
 * (lib/orchestrator/internal.ts:87) and all it does is raise the "update all
 * marketing with the new price" task. It never touched `listings.list_price` —
 * so the "Reduce Price" sheet, which called it alone, toasted "Price reduced
 * to $X" over a price that had not moved. Both now run, in the order the
 * business process needs: the price is written HERE first, the follow-up task
 * is raised there second.
 *
 * ── THE ALLOW-LIST EXISTS BECAUSE THE WIRE DOES ──────────────────────────────
 *
 * `updates` used to be spread into the UPDATE with only `brokerage_id` and `id`
 * deleted from it. That was survivable for as long as nothing could call this;
 * the moment it has a browser-reachable caller it is an open write on every
 * other column of a 60-column table, including `status`, `lifecycle_stage`,
 * `agent_id`, `mls_number` and `sold_price` — all of which belong to actions
 * that own them (launchListingAction, updateListingStatus, the stage engine).
 * Wiring a door onto a deny-list is how a fix becomes a hole, so the allow-list
 * is part of the wire, not a follow-up.
 *
 * It is deliberately ONE column. This function's whole reason to exist beyond
 * saveListingDraftAction is the two price consequences above; every other
 * hand-editable column already has its door at
 * listings-kernel.ts:saveListingDraftAction, whose EDITABLE_LISTING_FIELDS is
 * the allow-list for that lane. Two lists that overlap would be two vocabularies
 * for one idea (§6) — these do not overlap except on `list_price` itself, which
 * is reported as the one remaining second price door: it is reachable through
 * the draft action's allow-list and, going that way, skips the ledger and the
 * tier. Nothing in the product sends it that way today.
 */
const PRICE_LANE_FIELDS = ["list_price"] as const

export async function updateListing(listingId: string, updates: Record<string, unknown>) {
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

    // ALLOW-LIST, not a deny-list. A key this lane does not own is REFUSED BY
    // NAME rather than dropped: a caller who sent `status` and got `{ success:
    // true }` back would reasonably believe the status changed.
    const incoming = updates ?? {}
    const safeUpdates: Record<string, unknown> = {}
    const rejected: string[] = []
    for (const key of Object.keys(incoming)) {
      if ((PRICE_LANE_FIELDS as readonly string[]).includes(key)) safeUpdates[key] = incoming[key]
      else rejected.push(key)
    }
    if (rejected.length > 0) {
      return {
        success: false,
        error:
          `This action only changes the list price. Not editable here: ${rejected.join(", ")} ` +
          `— use the listing's own edit surface (saveListingDraftAction) for those.`,
      }
    }
    if (Object.keys(safeUpdates).length === 0) {
      return { success: false, error: "No updates provided" }
    }

    // A price must be a real number. `list_price` is numeric in the live schema,
    // so a string or NaN reaching the UPDATE is a raw Postgres error the caller
    // cannot act on — and a negative or zero list price is not a price.
    const submittedPrice = Number(safeUpdates.list_price)
    if (!Number.isFinite(submittedPrice) || submittedPrice <= 0) {
      return { success: false, error: "Enter a list price greater than zero." }
    }
    safeUpdates.list_price = submittedPrice

    const { data, error } = await supabase
      .from("listings")
      .update({ ...safeUpdates, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) throw error

    // Trigger tier assignment ONLY when the price actually moved. `newPrice` is
    // the COERCED number validated above, not the raw body value — comparing a
    // string "485000" against a numeric currentPrice is always "changed", which
    // would ledger a no-op price change on every save.
    const newPrice = submittedPrice
    if (newPrice !== currentPrice) {
      await assignTierToListing(listingId, brokerageId, actorUserId).catch((err) => {
        console.error("[updateListing] Tier assignment failed (non-blocking):", err)
      })
      // PRICE-CHANGE LEDGER (writer-less burn-down): the seller portal's price
      // history read had NO writer — every price change now lands the ledger row
      // the portal renders. Best-effort; the update itself never fails on it.
      //
      // change_reason is DERIVED from the two prices this function already holds,
      // not taken from the caller (§6 — one vocabulary per function, and the one
      // authority on which way a price moved is the pair of numbers). It stood at
      // the constant "manual_update", which is what the SELLER reads on their own
      // price-history card: every reduction rendered to them as a nameless edit.
      const priceChangeReason =
        currentPrice == null      ? "price_set"
        : newPrice < currentPrice ? "price_reduction"
        : newPrice > currentPrice ? "price_increase"
        : "manual_update"
      await supabase.from("listing_price_changes").insert({
        brokerage_id: brokerageId,
        listing_id: listingId,
        agent_id: (currentListing as any).agent_id ?? null,
        old_price: currentPrice,
        new_price: newPrice,
        change_reason: priceChangeReason,
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
    // emitKernelEvent: the audit row AND the reactor — an archived listing now reaches
    // notification_rules / sequences keyed on listing_archived, not just the table.
    await emitKernelEvent({
      entityType:  "listing",
      entityId:    listingId,
      event:       KernelEvent.LISTING_ARCHIVED,
      brokerageId: auth.brokerageId,
      listingId,
      // The REAL accountable actor — under staff act-as this is the
      // impersonator, not the impersonated identity.
      actorUserId: auth.actorUserId ?? null,
      createdAt:   result.outcome.archivedAt,
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

    await emitKernelEvent({
      entityType:  "listing",
      entityId:    listingId,
      event:       KernelEvent.LISTING_UNARCHIVED,
      brokerageId: auth.brokerageId,
      listingId,
      actorUserId: auth.actorUserId ?? null,
      metadata:    {},
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
