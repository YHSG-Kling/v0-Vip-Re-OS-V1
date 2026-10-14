// lib/transactions/stale-listing-sphere-sweep.ts
//
// THE SPHERE HANDOFF FOR A CLOSED LISTING WHOSE LINKED TRANSACTION NEVER
// REACHES ITS OWN TERMINAL STATE (carried note, lane FB, wave 47 → wave 48).
//
// TWO PRODUCERS publish "deal_closed" (sphere_of_influence, the closed/past-
// client relationship manager) today, and each is correct for exactly one
// shape:
//
//   1. lib/application/listing-lifecycle.ts (advanceListingStageService) —
//      fires the moment a LISTING's own lifecycle_stage reaches "CLOSED",
//      but ONLY when NO transaction is linked to it. When one IS linked, it
//      deliberately steps aside: "that transaction's OWN stage machine is
//      the richer producer... owns this handoff when the TRANSACTION reaches
//      ITS OWN closed stage" (see that file's comment above the dedupe
//      lookup, ~line 676).
//   2. app/actions/transaction-stage-machine.ts (advanceTransactionStage) —
//      fires when a TRANSACTION's own stage reaches TRANSACTION_STAGES.CLOSED.
//
// THE GAP: a listing can be marked CLOSED (an agent closes it as inventory —
// signed, sold, done) while its LINKED transaction row sits abandoned at an
// earlier stage forever — nobody advanced it, or its own stage machine call
// failed silently upstream, or the transaction was created for a deal that
// closed through a workflow that never touched app/actions/transaction-
// stage-machine.ts at all. Producer 1 saw a transaction was linked and
// stepped aside for producer 2. Producer 2 never ran, because nothing ever
// asked the TRANSACTION to advance. The seller's CONTACT record is already
// converted to lifetime (handleSellerToLifetimeTransition runs unconditionally
// on the listing CLOSED transition, before either producer's dedupe check) —
// only the WELCOME SIGNAL to Sphere is missing, so the manager who owns the
// ongoing relationship never learns the deal is theirs to work.
//
// THIS SWEEP is the safety net for BOTH failure shapes above, and for the
// THIRD one producer 1's own comment names as a risk it accepts rather than
// guesses at: "A REFUSED lookup fails CLOSED (skips the publish, logs
// loudly)" — if that transaction lookup was refused at close time, NEITHER
// producer ever got a chance to fire, and nothing before this file retried it.
//
// SCOPE, DELIBERATELY NARROW: this does not force a transaction's OWN stage
// machine forward (ALLOWED_TRANSITIONS only permits CLOSING_PREP → CLOSED, so
// a transaction stuck earlier — FINANCING_PENDING, even UNDER_CONTRACT — has
// no single legal hop to CLOSED, and forcing one would need the human
// override path (requireOverrideActor), which an unattended sweep must never
// exercise). Instead this publishes the SAME "deal_closed" signal the real
// producers publish, directly, once — CLAUDE.md's own DELETE/BUILD split
// applies to signals as much as tables: the capability (the welcome handoff)
// is wanted and has no duplicate on this specific path, so it is BUILT here,
// not faked by force-advancing a transaction record that may not actually be
// ready to be called closed.
//
// DEDUPE, ACROSS BOTH PRODUCERS' ENTITY SHAPES (§2 — an absence assertion
// needs to see what it is asserting the absence OF). publishManagerSignal's
// own built-in dedupe only looks at OPEN signals for ONE (entity_type,
// entity_id) pair — not enough here, because this sweep must never re-publish
// a welcome that Sphere already CONSUMED, and must recognise a welcome that
// producer 2 already sent under the TRANSACTION's own entity_id even though
// this sweep reasons in terms of the LISTING. So before publishing, this
// checks manager_signals directly (any status — open, consumed, expired) for
// EITHER producer's shape: (entity_type='listing', entity_id=<listingId>) —
// producer 1's shape and this sweep's own — OR (entity_type='transaction',
// entity_id=<one of the linked transaction ids>) — producer 2's shape.
//
// RESIDUAL RISK, STATED RATHER THAN HIDDEN: this sweep fires using the
// LISTING as the entity. If the swept transaction is later reactivated and
// genuinely reaches its own CLOSED stage, producer 2 fires again under the
// TRANSACTION's entity_id — a DIFFERENT key from this sweep's — so the
// broader any-status check above is what stops a double welcome, and it only
// works looking FORWARD from a sweep that already ran. A transaction that
// closes for real BEFORE ever being swept is unaffected (producer 2 alone
// handles it, dedupe key matches on the transaction id, exactly as today).
// The remaining crack — this sweep runs, Sphere already CONSUMED that
// signal, and weeks later the SAME transaction genuinely reaches CLOSED — is
// accepted as rare and is not silently hidden: the any-status re-check would
// still catch it as long as this sweep's OWN prior signal is still visible in
// manager_signals, which it always is (rows are never deleted here).
// NOT "server-only" — deliberately, so scripts/stale-listing-sphere-sweep-simulator.ts
// can import this module directly under tsx (the server-only package throws on
// import outside webpack's server graph, the exact friction
// scripts/calendar-sync-adapter-simulator.ts's header documents). This file is
// reached only from app/api/cron/stale-listing-sphere-sweep/route.ts and the
// simulator, never from a client component, so the guard has nothing to protect
// here that createServiceClient's own service-role requirement does not already.
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { TRANSACTION_STATUSES_TERMINAL, type TransactionStatus } from "./transaction-status"

type Svc = ReturnType<typeof createServiceClient>

export interface StaleListingSphereSweepResult {
  /** CLOSED listings with a seller contact examined. */
  scanned: number
  /** deal_closed signals newly published. */
  published: number
  /** Skipped — a linked transaction has already reached a terminal status (producer 2 owns it). */
  handledByTransaction: number
  /** Skipped — a deal_closed signal (either producer's shape) already exists for this deal. */
  alreadySignaled: number
  /** Rows this sweep could not evaluate or publish for — read/write refusals, logged, never swallowed. */
  errors: number
}

const LISTING_CLOSED_STAGE = "CLOSED"

export async function sweepStaleClosedListingSphereHandoffs(
  client?: Svc,
): Promise<StaleListingSphereSweepResult> {
  const supabase = client ?? createServiceClient()
  const result: StaleListingSphereSweepResult = {
    scanned: 0, published: 0, handledByTransaction: 0, alreadySignaled: 0, errors: 0,
  }

  // Every CLOSED listing with a converted seller — handleSellerToLifetimeTransition
  // already required seller_contact_id to run, so a null here means the contact
  // conversion itself never happened and there is no client to hand to Sphere.
  const { data: listings, error: listingsError } = await supabase
    .from("listings")
    .select("id, brokerage_id, seller_contact_id, address, city, state")
    .eq("lifecycle_stage", LISTING_CLOSED_STAGE)
    .not("seller_contact_id", "is", null)

  if (listingsError) {
    console.error("[stale-listing-sphere-sweep] listing scan refused:", listingsError.message)
    result.errors++
    return result
  }
  if (!listings || listings.length === 0) return result

  const listingIds = listings.map((l) => l.id as string)

  // Every transaction linked to ANY of those listings, in one query.
  const { data: txns, error: txnsError } = await supabase
    .from("transactions")
    .select("id, listing_id, brokerage_id, status")
    .in("listing_id", listingIds)

  if (txnsError) {
    console.error("[stale-listing-sphere-sweep] linked-transaction scan refused:", txnsError.message)
    result.errors++
    return result
  }

  const txnsByListing = new Map<string, Array<{ id: string; status: TransactionStatus | null }>>()
  for (const t of txns ?? []) {
    const arr = txnsByListing.get(t.listing_id as string) ?? []
    arr.push({ id: t.id as string, status: (t.status as TransactionStatus | null) ?? null })
    txnsByListing.set(t.listing_id as string, arr)
  }

  for (const listing of listings) {
    result.scanned++
    const listingId = listing.id as string
    const brokerageId = listing.brokerage_id as string
    const linked = txnsByListing.get(listingId) ?? []

    // Any linked transaction already terminal → producer 2 owns (or already
    // ran) this handoff under that transaction's own entity_id. Nothing to do.
    if (linked.some((t) => t.status && (TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes(t.status))) {
      result.handledByTransaction++
      continue
    }

    // No linked transaction at all is producer 1's territory at close time —
    // this sweep still checks (below) in case that original publish was the
    // "REFUSED lookup" failure its own comment names, but it is not the
    // primary gap this sweep exists for.

    const transactionIds = linked.map((t) => t.id)

    // ANY-STATUS dedupe across BOTH producers' entity shapes (see file header).
    const { data: existingByListing, error: existingByListingError } = await supabase
      .from("manager_signals")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("to_manager", "sphere_of_influence")
      .eq("signal_type", "deal_closed")
      .eq("entity_type", "listing")
      .eq("entity_id", listingId)
      .limit(1)
      .maybeSingle()
    if (existingByListingError) {
      console.error(`[stale-listing-sphere-sweep] listing signal-history check refused for ${listingId}:`, existingByListingError.message)
      result.errors++
      continue
    }
    if (existingByListing) {
      result.alreadySignaled++
      continue
    }
    if (transactionIds.length > 0) {
      const { data: existingByTxn, error: existingByTxnError } = await supabase
        .from("manager_signals")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("to_manager", "sphere_of_influence")
        .eq("signal_type", "deal_closed")
        .eq("entity_type", "transaction")
        .in("entity_id", transactionIds)
        .limit(1)
        .maybeSingle()
      if (existingByTxnError) {
        console.error(`[stale-listing-sphere-sweep] transaction signal-history check refused for ${listingId}:`, existingByTxnError.message)
        result.errors++
        continue
      }
      if (existingByTxn) {
        result.alreadySignaled++
        continue
      }
    }

    const propertyAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
    const published = await publishManagerSignal({
      brokerageId,
      fromManager: "deal_coordinator",
      toManager: "sphere_of_influence",
      signalType: "deal_closed",
      entityType: "listing",
      entityId: listingId,
      contactId: listing.seller_contact_id as string,
      message: transactionIds.length > 0
        ? `${propertyAddress || "A listing"} closed but its linked deal never reached its own closed stage — this client is lifetime territory now. Over to you for the welcome.`
        : `${propertyAddress || "A listing"} closed — this client is now lifetime territory. Over to you for the welcome.`,
    }, supabase)
    if (!published.ok) {
      console.error(`[stale-listing-sphere-sweep] deal_closed publish failed for listing ${listingId}:`, published.reason)
      result.errors++
      continue
    }
    result.published++
  }

  return result
}
