/**
 * lib/compliance/raise-offer-flag.ts
 *
 * THE SESSION-FREE CORE OF RAISING A BUYER-OFFER COMPLIANCE FLAG, plus the
 * identity an unattended watchdog needs in order not to re-raise the same miss
 * every night.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * `app/actions/buyer-offer/flag-compliance.ts:flagOfferCompliance` is the only
 * thing in the tree that raises one of these flags, and it is a `"use server"`
 * export whose FIRST act is a cookie-session gate (`auth.getUser()` →
 * `Unauthorized`). That gate is correct and stays: every export of a
 * `"use server"` module is an RPC endpoint, and a bypass parameter would let any
 * authenticated caller claim it.
 *
 * But `app/api/cron/em-receipt-watcher/route.ts` is a CRON. It holds a service
 * credential and has no cookies, so `auth.getUser()` returned null on every
 * iteration and the watchdog got `{ success: false, error: "Unauthorized" }`
 * back — every offer, every night. A missing earnest-money receipt has therefore
 * never once been flagged, and the route counted `flagged` only on iterations
 * that never happened.
 *
 * The settled shape in this repo for exactly this is `lib/buyer-offer/
 * expire-offers.ts`: a session-free core that TAKES a client and does the work,
 * so the session-gated action and the unattended sweep each get their own
 * entrance to the SAME logic — no fake identity, no weakened gate. This is that
 * door for the compliance-flag lane.
 *
 * PATH: `lib/compliance/` because the flag row's whole lifecycle already lives
 * here — `offer-flag-resolution.ts` owns the raise (recordOfferComplianceFlag)
 * and the close (resolveOfferComplianceFlags) and the identity that ties them
 * together (complianceFlagKey). A raise core that lived anywhere else would be
 * the fourth place that has an opinion about what a flag is.
 *
 * NOT a `"use server"` file. Nothing here is an HTTP endpoint.
 *
 * ── WHY THE server-only DEPENDENCIES ARE IMPORTED DYNAMICALLY ────────────────
 * `notify-helpers` and `agent-identity-resolver` both open with
 * `import "server-only"`, which throws outside a react-server condition. Loading
 * them at call time (the same idiom `lib/kernel/event-reactor.ts` already uses
 * for the resolver) keeps this module importable by
 * `scripts/wave11-slice-loops-simulator.ts`, so the sweep's behaviour is
 * provable without credentials instead of only assertable by reading source.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { isValidUUID } from "@/lib/validations"
import { getIsaSystemUserIdCached } from "@/lib/auth/isa-actor"
import { rawRoleVariantsFor } from "@/lib/security/types"
import {
  complianceFlagKey,
  recordOfferComplianceFlag,
  OFFER_COMPLIANCE_FLAG_EVENT,
} from "./offer-flag-resolution"

/** The taxonomy buckets `flagOfferCompliance` accepts. Defined here so the
 *  action and the unattended sweep cannot drift apart on the vocabulary. */
export type OfferComplianceFlagType =
  | "missing_signature"
  | "missing_initial"
  | "missing_form"
  | "missing_field"
  | "expired_disclosure"
  | "other"

export interface RaiseOfferComplianceFlagInput {
  /** offers.id */
  offerId: string
  /**
   * users.id of whoever is accountable for the raise → activities.agent_user_id.
   * A SESSION caller passes the signed-in user. An unattended caller passes what
   * `resolveUnattendedRaiserUserId` gave it and refuses when that is null — the
   * column FKs users(id), so there is no honest literal to put here.
   */
  raiserUserId: string
  /**
   * TENANT ASSERTION, session path only: refuse unless the offer belongs to this
   * brokerage. A service-credential sweep omits it — it never reads a tenant
   * from a caller, it reads `offers.brokerage_id` off the row it is processing.
   */
  requireBrokerageId?: string | null
  flagType: OfferComplianceFlagType
  severity: "low" | "medium" | "high" | "critical"
  title: string
  body?: string
  /** documents.id of the staged packet when the flag is packet-specific. */
  documentId?: string
}

export interface RaiseOfferComplianceFlagOutcome {
  /** The audit row was written or refreshed. */
  success: boolean
  /** How many humans this actually reached. Zero is reported, never rounded up. */
  notified_count: number
  /** The stable identity of the miss — lib/compliance/offer-flag-resolution.ts. */
  flag_key?: string
  /** An already-open flag for the SAME miss was refreshed, not duplicated. */
  deduped?: boolean
  error?: string
}

/**
 * Raise (or refresh) a compliance flag against an offer and fan it out.
 *
 * Everything `flagOfferCompliance` did EXCEPT the session gate: load the offer,
 * assert the tenant when one was asserted, resolve the buyer-side agent's
 * users.id, write the audit row through the module that also closes it, and
 * notify.
 *
 * FAILS CLOSED on reads: supabase-js resolves a refused query, so the offer load
 * destructures `error` — otherwise "this offer does not exist" and "the read was
 * refused" arrive identically and the sweep skips the offer forever in silence.
 */
export async function raiseOfferComplianceFlag(
  svc: SupabaseClient,
  input: RaiseOfferComplianceFlagInput,
): Promise<RaiseOfferComplianceFlagOutcome> {
  const { offerId, raiserUserId, requireBrokerageId, flagType, severity, title, body, documentId } = input

  if (!isValidUUID(offerId)) return { success: false, notified_count: 0, error: "Invalid offer ID" }
  if (!isValidUUID(raiserUserId)) {
    // activities.agent_user_id FKs users(id). Writing a placeholder here is the
    // silent-write class: the row is refused and the caller reports a flag.
    return { success: false, notified_count: 0, error: "Invalid raiser user ID" }
  }

  const { data: offer, error: offerError } = await svc
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, transaction_id")
    .eq("id", offerId)
    .maybeSingle()

  if (offerError) return { success: false, notified_count: 0, error: `Could not read the offer: ${offerError.message}` }
  if (!offer) return { success: false, notified_count: 0, error: "Offer not found" }
  if (requireBrokerageId && offer.brokerage_id !== requireBrokerageId) {
    return { success: false, notified_count: 0, error: "Forbidden" }
  }
  if (!offer.brokerage_id) {
    // activities.brokerage_id is NOT NULL with no default — an insert omitting it
    // writes ZERO rows while reporting success.
    return { success: false, notified_count: 0, error: "Offer has no brokerage — cannot file the compliance flag" }
  }

  // `offers.agent_id` is an AGENTS id; the bell target is a USERS id. Disjoint
  // spaces, resolved through the ONE canonical helper rather than a second
  // inline `agents → user_id` lookup (this file replaced exactly such a copy in
  // flag-compliance.ts).
  let assignedAgentUserId: string | null = null
  if (offer.agent_id) {
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    assignedAgentUserId = await resolveAgentRecordToUserId(offer.agent_id as string)
  }

  const recorded = await recordOfferComplianceFlag({
    offerId,
    brokerageId: offer.brokerage_id as string,
    raiserUserId,
    // activities.agent_id FKs agents(id); agent_user_id is users-class. Disjoint
    // spaces — offers.agent_id is already an agents id and goes only to agentId.
    agentId: (offer.agent_id as string | null) ?? null,
    contactId: (offer.contact_id as string | null) ?? null,
    flagType,
    severity,
    title,
    body,
    documentId,
    client: svc,
  })

  const { notifyComplianceFlag } = await import("@/lib/notifications/notify-helpers")
  const { notified_count } = await notifyComplianceFlag(svc as any, {
    brokerageId: offer.brokerage_id as string,
    agentUserId: assignedAgentUserId,
    transactionId: (offer.transaction_id as string | null) ?? null,
    flag: {
      type: `compliance.${flagType}`,
      severity,
      title,
      body,
      entityType: "offer",
      entityId: offerId,
      documentId: documentId ?? null,
      offerId,
    },
  })

  return {
    success: recorded.success,
    notified_count,
    flag_key: recorded.flag_key,
    deduped: recorded.deduped,
    error: recorded.error,
  }
}

// ─── THE UNATTENDED ACTOR ────────────────────────────────────────────────────

export interface UnattendedRaiserResolution {
  /** users.id, or null when this brokerage has nobody the flag can be filed under. */
  userId: string | null
  /** Which door it came through — reported by the sweep so the row is explicable. */
  via: "isa_system_actor" | "offer_agent" | "brokerage_principal" | "none"
  error?: string
}

/**
 * Who a cron files a compliance flag under.
 *
 * `activities.agent_user_id` FKs users(id), so "the system" cannot be a literal
 * string here. `lib/auth/isa-actor.ts` already settled this shape and its
 * docblock states the fallback: callers writing an actor id "MUST fall back to
 * the brokerage admin's user_id rather than writing a literal string". So:
 *
 *   1. the brokerage's provisioned system actor,
 *   2. the offer's own agent (the party accountable for the miss),
 *   3. any principal of the brokerage (broker / admin / superadmin),
 *   4. nothing — and the caller must SKIP AND SAY SO, not invent an id.
 *
 * Step 2 is what the watcher did on its own before this, and it was also its
 * silent exit: an offer whose agent had no users row was `continue`d with no
 * record anywhere that a deadline had passed unexamined.
 */
export async function resolveUnattendedRaiserUserId(
  svc: SupabaseClient,
  params: { brokerageId: string | null | undefined; agentRecordId?: string | null },
): Promise<UnattendedRaiserResolution> {
  const { brokerageId, agentRecordId } = params
  if (!brokerageId) return { userId: null, via: "none", error: "no brokerage on the row" }

  const isaUserId = await getIsaSystemUserIdCached(svc, brokerageId)
  if (isaUserId) return { userId: isaUserId, via: "isa_system_actor" }

  if (agentRecordId) {
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    const agentUserId = await resolveAgentRecordToUserId(agentRecordId)
    if (agentUserId) return { userId: agentUserId, via: "offer_agent" }
  }

  // Role values are expanded through the canonical vocabulary rather than
  // hand-spelled: a `.in("user_type", ["TC"])` that matches zero rows is a
  // SUCCESSFUL query, and that exact mistake once cost this product every
  // compliance notification to a transaction coordinator.
  const { data: principals, error: principalError } = await svc
    .from("users")
    .select("id")
    .eq("brokerage_id", brokerageId)
    // RECIPIENT FILTER: 'superadmin' dropped — it matches zero users.user_type
    // rows (platform staff carry platform_role instead). broker_owner appended:
    // storable, owns the brokerage, and not a canonical role so the expansion
    // cannot carry it.
    .in("user_type", [...rawRoleVariantsFor(["broker", "admin"]), "broker_owner"])
    .order("created_at", { ascending: true })
    .limit(1)

  if (principalError) {
    return { userId: null, via: "none", error: `principal lookup failed: ${principalError.message}` }
  }
  const principalId = (principals ?? [])[0]?.id as string | undefined
  if (principalId) return { userId: principalId, via: "brokerage_principal" }

  return { userId: null, via: "none", error: "no system actor, agent user or brokerage principal" }
}

// ─── THE EARNEST-MONEY WATCHDOG'S IDENTITY + DEDUPE ──────────────────────────
//
// THE DEDUPE THAT COULD NEVER MATCH. The watcher filtered
//   notes ilike '%<offerId>%em_receipt_missing%'
// while the writer stores `JSON.stringify({ offer_id, flagType, severity, … })`
// with `flagType` from the six-value packet vocabulary. The literal
// `em_receipt_missing` is written nowhere in the tree, so the filter matched
// zero rows on every run — a dedupe that is exactly as effective as no dedupe.
// With the auth half fixed alone, the watchdog would have re-flagged and
// re-notified every accepted offer every night.
//
// So the key is the one the WRITER actually writes: `metadata.flag_key`, from
// wave 9's `complianceFlagKey` — the single answer in this codebase to "what
// identifies the same miss". Nothing here invents a second identity.
//
// WHICH FORCED A SECOND CORRECTION. `complianceFlagKey` is over flagType+title,
// and the watcher's title embedded the overdue day count
// ("… (3 days past contract deadline)"). That string changes every night, so the
// key would change every night: `recordOfferComplianceFlag` would mint a NEW
// open flag per run instead of refreshing one, and the ledger would stack the
// duplicates it was built to collapse. The title is now the STABLE subject and
// the day count lives in the body, where re-reading it is the point.

/** The stable subject of "this offer's earnest-money receipt is missing". */
export function emReceiptFlagSubject(): { flagType: OfferComplianceFlagType; title: string } {
  return {
    // Closest bucket in the taxonomy; the body says it is the EM receipt.
    flagType: "missing_form",
    // NO variable parts. See the note above — a title that moves is a key that
    // moves, and a key that moves is a duplicate every run.
    title: "Earnest money receipt missing",
  }
}

/** The flag key the EM watchdog raises under, from the shared identity fn.
 *  Module-private: nothing outside should hold a second copy of this key — the
 *  only honest way to ask "is this the same miss" is to derive it here. */
function emReceiptFlagKey(): string {
  return complianceFlagKey(emReceiptFlagSubject())
}

export interface EmReceiptFlagWindowResult {
  /** True when this exact miss was already raised (or re-raised) inside the window. */
  raisedWithinWindow: boolean
  /** When it was last raised, from the writer's own stamps. */
  lastRaisedAt: string | null
  /** Set when the ledger could not be read — the caller RAISES anyway and reports this. */
  error?: string
}

/**
 * Has this offer's EM-receipt miss already been raised inside the window?
 *
 * Matches on the canonical flag anchor — brokerage + entity_type 'offer' +
 * entity_id + activity_type + `metadata->>flag_key` — and reads the last raise
 * from what the writer stamps: `last_reflagged_at` on a refresh, `raised_at` on
 * the original insert, `created_at` as the floor. It deliberately does NOT
 * filter on status: a flag a TC resolved two hours ago still means the humans
 * have heard about this miss today, and re-notifying them is the noise this
 * window exists to prevent.
 *
 * ON A REFUSED READ it returns `raisedWithinWindow: false` WITH an error, so the
 * caller raises and reports the warning. That is the same ruling
 * `recordOfferComplianceFlag` already made for its own lookup ("a refused lookup
 * is reported but does NOT suppress the write") and it is safe here for the same
 * reason: the writer upserts on the flag key, so the worst case is one duplicate
 * NOTIFICATION, while the other direction is a missed money deadline.
 */
export async function emReceiptFlagRaisedWithin(
  svc: SupabaseClient,
  params: { brokerageId: string; offerId: string; since: Date },
): Promise<EmReceiptFlagWindowResult> {
  const { data, error } = await svc
    .from("activities")
    .select("id, created_at, metadata")
    .eq("brokerage_id", params.brokerageId)
    .eq("entity_type", "offer")
    .eq("entity_id", params.offerId)
    .eq("activity_type", OFFER_COMPLIANCE_FLAG_EVENT)
    .filter("metadata->>flag_key", "eq", emReceiptFlagKey())
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) {
    return { raisedWithinWindow: false, lastRaisedAt: null, error: `flag-ledger lookup failed: ${error.message}` }
  }

  const rows = (data ?? []) as Array<{ created_at: string | null; metadata: Record<string, any> | null }>
  let lastRaisedMs = Number.NEGATIVE_INFINITY
  let lastRaisedAt: string | null = null
  for (const row of rows) {
    const stamp =
      (row.metadata?.last_reflagged_at as string | undefined) ??
      (row.metadata?.raised_at as string | undefined) ??
      row.created_at
    const ms = stamp ? new Date(stamp).getTime() : NaN
    if (!Number.isFinite(ms)) continue
    if (ms > lastRaisedMs) { lastRaisedMs = ms; lastRaisedAt = stamp ?? null }
  }

  return {
    raisedWithinWindow: Number.isFinite(lastRaisedMs) && lastRaisedMs >= params.since.getTime(),
    lastRaisedAt,
  }
}
