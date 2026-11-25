"use server"

/**
 * Thin server-action surface for the offer-acceptance compliance-bridge
 * panel. These are "use server" entrypoints callable directly by any
 * authenticated client, so each MUST authorize server-side: the caller's
 * brokerage is derived from the session (never trusted from the request), and
 * the target offer must belong to that brokerage. emitCompliancePassed is the
 * document-compliance GATE signal, so it is additionally restricted to staff
 * roles — otherwise a client could mark any offer "compliant" and create a
 * transaction with no documents/signatures.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { acceptOfferConditionally, loadComplianceBridgeStatus } from "@/lib/kernel/transactions"
import { emitCompliancePassed } from "@/lib/buyer-offer/compliance-gate"

type Caller =
  | { ok: true; userId: string; brokerageId: string; userType: string | null }
  | { ok: false; error: string }

async function resolveCaller(): Promise<Caller> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, userType: (u as any).user_type ?? null }
}

/** Returns the offer's brokerage_id (service client — bypasses RLS for the check). */
async function offerBrokerageId(offerId: string): Promise<string | null> {
  const svc = createServiceClient()
  const { data } = await svc.from("offers").select("brokerage_id").eq("id", offerId).maybeSingle()
  return (data as any)?.brokerage_id ?? null
}

// TOMBSTONE (wave 156, 156B): the retyped STAFF_ROLES list (broker, admin, compliance_officer, tc) was replaced by the review
// authority rule lib/kernel/compliance/representation-gate.ts mayReviewRepresentation (→ lib/auth/deal-work-ownership.ts).

export async function acceptOfferConditionallyAction(params: {
  offerId:     string
  listingId:   string
  brokerageId: string  // ignored — brokerage is derived from the session
  agentUserId: string
}) {
  const caller = await resolveCaller()
  if (!caller.ok) return { success: false, error: caller.error }

  const ownerBrokerage = await offerBrokerageId(params.offerId)
  if (!ownerBrokerage || ownerBrokerage !== caller.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  return acceptOfferConditionally({
    offerId:     params.offerId,
    agentId:     params.agentUserId,
    brokerageId: caller.brokerageId,
    listingId:   params.listingId,
  })
}

export async function emitCompliancePassedAction(params: {
  offerId: string
  userId:  string  // ignored — the acting user is the authenticated caller
}) {
  const caller = await resolveCaller()
  if (!caller.ok) return { success: false, error: caller.error }

  // Manually emitting the compliance-passed gate bypasses the automated document
  // audit, so it is a staff-only override within the offer's own brokerage.
  // WAVE 156 (lane 156B): accepting a packet is the REVIEW authority (lib/auth/deal-work-ownership.ts closingApproval —
  // compliance_officer or the tenant admin roster), read through the ONE rule the representation review uses. A TC assists
  // the deal and never accepts its paperwork; an agent never accepts their own.
  {
    const { mayReviewRepresentation } = await import("@/lib/kernel/compliance/representation-gate")
    if (!mayReviewRepresentation({ sameTenant: true, userType: caller.userType ?? null, grantedRoles: [], isOwningAgent: false }).ok) {
      return { success: false, error: "Forbidden" }
    }
  }
  const ownerBrokerage = await offerBrokerageId(params.offerId)
  if (!ownerBrokerage || ownerBrokerage !== caller.brokerageId) {
    return { success: false, error: "Forbidden" }
  }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return await ledgerSessionAction({ brokerageId: caller.brokerageId, action: "offer.compliance_gate.override", actor: { type: "user", userId: caller.userId }, subject: { type: "offer", id: params.offerId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", detail: { user_type: caller.userType } }, async () => {
  // WAVE 156 round 2: THE OVERRIDE GOES THROUGH THE SAME EVIDENCE-BOUND REVIEW. It may accept a packet that is waiting for a
  // person (needs_review) — that acceptance is recorded as THIS reviewer's approval of the current evidence hash — and it is
  // REFUSED, with the reasons, while any hold or refusal stands. It can no longer stamp past a contradiction.
  const svc = createServiceClient()
  const { governingOfferPacket } = await import("@/lib/offers/governing-terms")
  const gp = await governingOfferPacket(svc as never, caller.brokerageId, params.offerId)
  if (!gp.ok) return { success: false, error: `The executed contract could not be established, so compliance cannot be recorded: ${gp.reason}` }
  const { loadAndDecideOfferRepresentation, REPRESENTATION_REVIEW_GATE } = await import("@/lib/kernel/compliance/representation-gate")
  const review = await loadAndDecideOfferRepresentation(svc as never, { brokerageId: caller.brokerageId, offerId: params.offerId, packet: gp.packet, gate: { allowed: true, refusals: [] } })
  if (!review.ok) return { success: false, error: `The executed contract's terms could not be read, so compliance cannot be recorded: ${review.error}` }
  const holds = review.decision.blockingReasons.filter((r) => r.severity !== "review")
  if (review.decision.verdict === "hold" || review.decision.verdict === "refuse") {
    return { success: false, error: `Compliance cannot be recorded over an open hold: ${holds.map((r) => r.message).join(" ")}`, hold_reasons: holds.map((r) => ({ code: r.code, document_id: r.documentId, field: r.field, repair: r.repair ?? null })) }
  }
  const { data: approval, error: approvalErr } = await svc.from("compliance_events").insert({
    brokerage_id: caller.brokerageId, gate_name: REPRESENTATION_REVIEW_GATE, entity_type: "purchase_offer", entity_id: params.offerId,
    allowed: true, actor_user_id: caller.userId, actor_role: caller.userType ?? "reviewer", severity: "info", violations: [],
    details: { kind: "human_review", decision: "approve", evidence_hash: review.decision.evidenceHash, version: review.decision.version, via: "compliance_bridge_override", reviewed_reasons: review.decision.blockingReasons.map((r) => r.code) },
  }).select("id")
  if (approvalErr || !approval || approval.length === 0) return { success: false, error: `The reviewer's approval could not be recorded, so compliance was not stamped${approvalErr ? `: ${approvalErr.message}` : "."}` }
  return emitCompliancePassed({ offerId: params.offerId, userId: caller.userId })
  })
}

export async function loadComplianceBridgeStatusAction(offerId: string) {
  const caller = await resolveCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  const ownerBrokerage = await offerBrokerageId(offerId)
  if (!ownerBrokerage || ownerBrokerage !== caller.brokerageId) {
    return { success: false, error: "Forbidden" }
  }
  return loadComplianceBridgeStatus(offerId)
}
