"use server"

/**
 * Thin server-action surface over the offer-kernel commands the offer-workspace
 * client component needs. Lives here (with "use server") so the client bundle
 * only sees RPC stubs — not the kernel module body, which transitively pulls
 * the AI/compliance/server-only chain.
 */

import { acceptOffer, rejectOffer, withdrawOffer } from "@/lib/kernel/offers"

export async function acceptOfferAction(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
}) {
  return acceptOffer(params)
}

export async function rejectOfferAction(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
  reason?:     string
}) {
  return rejectOffer(params)
}

export async function withdrawOfferAction(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
}) {
  return withdrawOffer(params)
}
