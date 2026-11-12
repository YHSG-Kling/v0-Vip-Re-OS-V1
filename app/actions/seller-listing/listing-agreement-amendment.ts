"use server"

/**
 * app/actions/seller-listing/listing-agreement-amendment.ts — THE DOOR FOR AN EXECUTED AMENDMENT TO A LISTING AGREEMENT
 * (wave 145, lane 145B; owner rulings 1 + 2; cross-lane contract C7).
 *
 * Owner: "The listing agreement would have the date the seller wants to go live on the MLS so check the listing
 * agreement." The seller-agreed MLS live date (and the seller's Coming Soon street-address instruction) are terms of the
 * EXECUTED listing agreement. They are never typed over: the only correction is an executed amendment, recorded here as
 * a `contract_term_versions` row anchored to the agreement (m797 + m856 — the same versioned record the offer side's
 * addenda use, app/actions/buyer-offer/record-contract-addendum.ts). The original agreement row is never touched; the
 * amendment supersedes it at read time (lib/listings/listing-agreement-terms.ts governingListingAgreementTerms).
 *
 * What it will NOT do — nothing here invents anything:
 *   · it records no amendment on a listing with no executed agreement (there is nothing to amend);
 *   · it records an amendment only from a stored document that shows the SELLER's and the listing side's signatures
 *     (recordListingAgreementAmendment refuses the rest by name) — the date and the terms are the agent's confirmed
 *     reading of that document;
 *   · it never marks anything "live on the MLS" — that stays the feed-verified writer's alone.
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant is the SESSION's (requireCaller); the caller must be the
 * listing's agent or a tenant admin; the service client is used only AFTER that gate. The change is a legal-class act
 * (a contract term), so it runs inside withActionLedger (LAW 5) and then follows through the existing survivors
 * (lib/listings/mls-live-date.ts followSellerAgreedMlsLiveDate: planned date, compliance loop, open-house schedule,
 * the agent's bell, the lifecycle event).
 */

import { requireCaller } from "@/lib/auth/require-caller"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"

export interface ListingAgreementAmendmentInput {
  listingId: string
  /** The stored document that IS the executed amendment (it must show the seller's and the listing agent's/broker's signatures). */
  documentId: string
  /** The day it was fully signed, yyyy-mm-dd, as printed on the document. */
  executedOn: string
  /** The seller-agreed MLS live date the amendment states (yyyy-mm-dd); null strikes it; omit when the amendment does not change it. */
  sellerRequestedMlsLiveDate?: string | null
  /** The seller's Coming Soon street-address instruction the amendment states; null strikes it; omit when unchanged. */
  comingSoonStreetAddressAuthorized?: boolean | null
}

export interface ListingAgreementAmendmentResult {
  success: boolean
  error?: string
  versionNo?: number
  /** Which survivors the change reached (evidence, policy, marketing schedule, alert). */
  reached?: string[]
  warning?: string
}

export async function recordListingAgreementAmendmentAction(params: ListingAgreementAmendmentInput): Promise<ListingAgreementAmendmentResult> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (!isValidUUID(params?.listingId)) return { success: false, error: "Invalid listing ID" }
  if (!isValidUUID(params?.documentId)) return { success: false, error: "Choose the stored document that is the executed amendment." }
  const terms: Record<string, unknown> = {}
  if (params.sellerRequestedMlsLiveDate !== undefined) terms.seller_requested_mls_live_date = params.sellerRequestedMlsLiveDate === "" ? null : params.sellerRequestedMlsLiveDate
  if (params.comingSoonStreetAddressAuthorized !== undefined) terms.coming_soon_street_address_authorized = params.comingSoonStreetAddressAuthorized
  if (Object.keys(terms).length === 0) return { success: false, error: "State the term(s) the amendment changes." }

  const svc = createServiceClient()
  // THE GATE: the listing is in the caller's brokerage (session tenant), and the caller is its agent or a tenant admin.
  const { data: listing, error: lErr } = await svc.from("listings").select("id, agent_id, brokerage_id")
    .eq("id", params.listingId).eq("brokerage_id", caller.brokerageId).maybeSingle()
  if (lErr) return { success: false, error: `The listing could not be read: ${lErr.message}` }
  if (!listing) return { success: false, error: "Listing not found in your brokerage." }
  if (!TENANT_ADMIN_USER_TYPES.has(String(caller.userType ?? "").toLowerCase())) {
    const agentId = await resolveAgentIdInBrokerage(svc as any, caller.userId, caller.brokerageId)
    if (!agentId || (listing as { agent_id?: string | null }).agent_id !== agentId) {
      return { success: false, error: "Only the listing's agent or a brokerage admin can record an amendment to its listing agreement." }
    }
  }

  const { recordListingAgreementAmendment } = await import("@/lib/listings/listing-agreement-terms")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  type Rec = Awaited<ReturnType<typeof recordListingAgreementAmendment>>
  const rec: Rec = await withActionLedger<Rec>(
    {
      brokerageId: caller.brokerageId,
      action: "listing.agreement_amendment.record",
      actor: { type: "user", userId: caller.userId },
      subject: { type: "listing", id: params.listingId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `executed listing-agreement amendment (${Object.keys(terms).join(", ")}) signed ${params.executedOn}`,
      idempotencyKey: `listing_agreement_amendment:${params.listingId}:${params.documentId}`,
      riskClass: "LEGAL",
      systemSource: "listing-agreement-amendment",
      detail: { document_id: params.documentId, executed_on: params.executedOn, terms },
    },
    () => recordListingAgreementAmendment(svc as any, {
      brokerageId: caller.brokerageId, listingId: params.listingId, documentId: params.documentId, executedOn: params.executedOn, terms, recordedBy: caller.userId,
    }),
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: `amendment ${r.versionNo} recorded` } : { status: "failed", outcome: "refused", error: r.reason }),
      // Every non-acting claim fails closed. WAVE 147 (lane 147F): `unknown` (an earlier attempt whose outcome is not
      // known) used to read "the action ledger refused: unknown" — it is not a refusal, and the agent must check before
      // retrying, so it now says that.
      replay: (claim) => ({ ok: false, reason: claim.kind === "replay" ? "this amendment document was already recorded" : claim.kind === "in_flight" ? "this amendment is being recorded right now" : claim.kind === "unknown" ? "an earlier attempt to record this amendment ended in an unknown state — check the listing agreement's versions before trying again" : `the action ledger refused: ${claim.error}` }),
    },
  )
  if (!rec.ok) return { success: false, error: rec.reason }

  // FOLLOW-THROUGH — only when the amendment changed the seller-agreed date. A refusal here is REPORTED: the amendment
  // is recorded (the legal fact stands); the listing's planned date did not follow, and the agent is told why.
  let reached: string[] = ["evidence:contract_term_versions"]
  const warnings: string[] = []
  if (rec.changed.includes("seller_requested_mls_live_date")) {
    const { followSellerAgreedMlsLiveDate } = await import("@/lib/listings/mls-live-date")
    const f = await followSellerAgreedMlsLiveDate(svc as any, { brokerageId: caller.brokerageId, listingId: params.listingId, actorUserId: caller.userId, via: "amendment", amendmentVersion: rec.versionNo })
    if (!f.ok) warnings.push(`The amendment is recorded, but the listing's planned MLS live date did not follow it: ${f.reason}`)
    else { reached = [...reached, ...f.reached]; warnings.push(...f.warnings) }
  }
  try {
    const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
    const ev = await recordLifecycleEvent(svc as any, caller.brokerageId, {
      event_type: "listing.agreement.amendment_recorded",
      payload: { listing_id: params.listingId, agreement_id: rec.agreementId, version_no: rec.versionNo, document_id: params.documentId, executed_on: params.executedOn, changed: rec.changed },
      source: "ui", user_id: caller.userId, entity_type: "listing", entity_id: params.listingId,
      dedupe_key: `listing-agreement-amendment-${rec.id}`,
    }, { dedupeWindowHours: null })
    if (!ev.ok) console.error(`[listing-agreement-amendment] amendment ${rec.versionNo} recorded but its lifecycle event was not: ${ev.error}`)
    else reached.push("evidence:listing.agreement.amendment_recorded")
  } catch (err) {
    console.error("[listing-agreement-amendment] lifecycle event threw:", (err as Error)?.message ?? err)
  }
  return { success: true, versionNo: rec.versionNo, reached, ...(warnings.length ? { warning: warnings.join(" ") } : {}) }
}
