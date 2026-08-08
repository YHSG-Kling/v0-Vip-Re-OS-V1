// lib/enrichment/deal-suppression.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE I/O HALF of the enrichment suppression rule. The vocabulary partition and
// the pure classifiers live in ./deal-vocabulary (no `server-only`, so the guard
// can import them); this file asks the database the question and is the single
// import site every enrichment entry point uses.
//
// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// supabase-js RESOLVES a refused query — `const { data }` reads "RLS said no" as
// "no rows", i.e. as "this contact is not in a deal". For a suppression check
// that inversion is the whole defect: an unreadable table would turn the gate
// off rather than on. Every read here destructures `error`, and ANY error
// returns `inLiveDeal: true`. If we cannot tell whether the contact is in a live
// deal, we do not enrich.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { isListingLive, isTransactionLive } from "./deal-vocabulary"

export * from "./deal-vocabulary"

// ─── THE PREDICATE ───────────────────────────────────────────────────────────

export interface LiveDealVerdict {
  /** True = DO NOT ENRICH. True is also what every failure returns. */
  inLiveDeal: boolean
  /** "listing" | "transaction" | "unreadable" — why enrichment is suppressed. */
  reason?: "listing" | "transaction" | "unreadable"
  /** The listing/transaction id that suppressed, for the log line. */
  entityId?: string
  /** Set only when the verdict is fail-closed rather than observed. */
  error?: string
}

const NOT_IN_DEAL: LiveDealVerdict = { inLiveDeal: false }

/**
 * Does this contact have an active listing or an active transaction RIGHT NOW?
 *
 * Call this immediately before spending money at a paid enrichment provider —
 * never cache the answer across a batch, because a batch can outlive a stage
 * transition.
 *
 * `brokerageId` is REQUIRED and is applied to both reads. It is not a
 * convenience: without it a service-client read here would silently answer the
 * question across every tenant, and a foreign tenant's live deal would suppress
 * (or, worse, a foreign contact id would read as "no deals" and unlock spend).
 *
 * Never throws. Returns `inLiveDeal: true` on any read error.
 */
export async function isContactInLiveDeal(params: {
  contactId: string
  brokerageId: string
  /** Reuse an existing client. Defaults to the service client — this is an
   *  unattended-safe predicate and must give the same answer with or without a
   *  session. */
  supabase?: SupabaseClient<any, any, any>
}): Promise<LiveDealVerdict> {
  const { contactId, brokerageId } = params

  // A missing id is not "no deals" — it is "we cannot tell". Fail closed.
  // (contacts.id / agents.id / users.id are disjoint id spaces; an empty string
  // here would also raise 22P02 rather than returning zero rows.)
  if (!contactId || !brokerageId) {
    return { inLiveDeal: true, reason: "unreadable", error: "contactId and brokerageId are both required" }
  }

  const supabase = params.supabase ?? createServiceClient()

  // ── Listings ──────────────────────────────────────────────────────────────
  // Both FK columns are checked. `contact_id` is the generic link and
  // `seller_contact_id` is the one the listing kernel actually stamps; rows
  // exist with either, so an .or() over both is the only complete question.
  const { data: listings, error: listingError } = await supabase
    .from("listings")
    .select("id, lifecycle_stage, status")
    .eq("brokerage_id", brokerageId)
    .or(`contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .limit(200)

  if (listingError) {
    return { inLiveDeal: true, reason: "unreadable", error: `listings: ${listingError.message}` }
  }

  for (const row of listings ?? []) {
    if (isListingLive(row as { lifecycle_stage?: string | null; status?: string | null })) {
      return { inLiveDeal: true, reason: "listing", entityId: (row as { id: string }).id }
    }
  }

  // ── Transactions ──────────────────────────────────────────────────────────
  // Three FK columns: the generic link plus both sides of the deal. A buyer
  // under contract is linked through buyer_contact_id only.
  const { data: transactions, error: txnError } = await supabase
    .from("transactions")
    .select("id, status, stage")
    .eq("brokerage_id", brokerageId)
    .or(
      `contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`,
    )
    .limit(200)

  if (txnError) {
    return { inLiveDeal: true, reason: "unreadable", error: `transactions: ${txnError.message}` }
  }

  for (const row of transactions ?? []) {
    if (isTransactionLive(row as { status?: string | null; stage?: string | null })) {
      return { inLiveDeal: true, reason: "transaction", entityId: (row as { id: string }).id }
    }
  }

  return NOT_IN_DEAL
}

/**
 * Batch form of the same question — one round trip per table instead of two per
 * contact. Used by the nightly net and the queue drain, which both hold a list.
 *
 * Returns the SUPPRESSED subset. On any read error it returns EVERY id passed
 * in: the fail-closed direction for a batch is "suppress all of them", not
 * "suppress none".
 */
export async function contactsInLiveDeals(params: {
  contactIds: string[]
  brokerageId: string
  supabase?: SupabaseClient<any, any, any>
}): Promise<{ suppressed: Set<string>; degraded: boolean; error?: string }> {
  const ids = [...new Set(params.contactIds.filter((id) => typeof id === "string" && id.length > 0))]
  if (ids.length === 0) return { suppressed: new Set(), degraded: false }
  if (!params.brokerageId) {
    return { suppressed: new Set(ids), degraded: true, error: "brokerageId is required" }
  }

  const supabase = params.supabase ?? createServiceClient()
  const suppressed = new Set<string>()
  const list = ids.join(",")

  const { data: listings, error: listingError } = await supabase
    .from("listings")
    .select("contact_id, seller_contact_id, lifecycle_stage, status")
    .eq("brokerage_id", params.brokerageId)
    .or(`contact_id.in.(${list}),seller_contact_id.in.(${list})`)

  if (listingError) {
    return { suppressed: new Set(ids), degraded: true, error: `listings: ${listingError.message}` }
  }

  for (const row of (listings ?? []) as Array<Record<string, string | null>>) {
    if (!isListingLive(row)) continue
    for (const col of ["contact_id", "seller_contact_id"]) {
      const v = row[col]
      if (v && ids.includes(v)) suppressed.add(v)
    }
  }

  const { data: transactions, error: txnError } = await supabase
    .from("transactions")
    .select("contact_id, buyer_contact_id, seller_contact_id, status, stage")
    .eq("brokerage_id", params.brokerageId)
    .or(
      `contact_id.in.(${list}),buyer_contact_id.in.(${list}),seller_contact_id.in.(${list})`,
    )

  if (txnError) {
    return { suppressed: new Set(ids), degraded: true, error: `transactions: ${txnError.message}` }
  }

  for (const row of (transactions ?? []) as Array<Record<string, string | null>>) {
    if (!isTransactionLive(row)) continue
    for (const col of ["contact_id", "buyer_contact_id", "seller_contact_id"]) {
      const v = row[col]
      if (v && ids.includes(v)) suppressed.add(v)
    }
  }

  return { suppressed, degraded: false }
}
