"use server"

/**
 * Thin server-action surface for the offer-acceptance compliance-bridge
 * panel. Same pattern as offer-kernel-actions: the client component imports
 * these RPC stubs so the underlying kernel/* modules (which transitively
 * pull server-only imports) never enter the client bundle.
 */

import { acceptOfferConditionally, loadComplianceBridgeStatus } from "@/lib/kernel/transactions"
import { emitCompliancePassed } from "@/lib/buyer-offer/compliance-gate"

export async function acceptOfferConditionallyAction(params: {
  offerId:     string
  listingId:   string
  brokerageId: string
  agentUserId: string
}) {
  return acceptOfferConditionally({
    offerId:     params.offerId,
    agentId:     params.agentUserId,
    brokerageId: params.brokerageId,
    listingId:   params.listingId,
  })
}

export async function emitCompliancePassedAction(params: {
  offerId: string
  userId:  string
}) {
  return emitCompliancePassed({ offerId: params.offerId, userId: params.userId })
}

export async function loadComplianceBridgeStatusAction(offerId: string) {
  return loadComplianceBridgeStatus(offerId)
}
