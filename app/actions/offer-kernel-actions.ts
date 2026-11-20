"use server"

/**
 * Thin server-action surface over the offer-kernel commands the offer-workspace
 * client component needs. Lives here (with "use server") so the client bundle
 * only sees RPC stubs — not the kernel module body, which transitively pulls
 * the AI/compliance/server-only chain.
 *
 * TENANT FROM THE SESSION (lane 91D2, CLAUDE.md §4). Each wrapper used to hand
 * the caller's whole object — brokerageId included — straight to the kernel
 * command, so the tenant the command acted in was whatever the request named.
 * The body brokerageId is now only asserted (a different brokerage is refused)
 * and the command receives the session's.
 */

import { acceptOffer, rejectOffer, withdrawOffer } from "@/lib/kernel/offers"
import { requireCallerTenant } from "@/lib/auth/require-caller"

export async function acceptOfferAction(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
}) {
  const tenant = await requireCallerTenant(params.brokerageId)
  if (!tenant.ok) return { success: false as const, error: tenant.error }
  return acceptOffer({ ...params, brokerageId: tenant.brokerageId })
}

export async function rejectOfferAction(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
  reason?:     string
}) {
  const tenant = await requireCallerTenant(params.brokerageId)
  if (!tenant.ok) return { success: false as const, error: tenant.error }
  return rejectOffer({ ...params, brokerageId: tenant.brokerageId })
}

export async function withdrawOfferAction(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
}) {
  const tenant = await requireCallerTenant(params.brokerageId)
  if (!tenant.ok) return { success: false as const, error: tenant.error }
  return withdrawOffer({ ...params, brokerageId: tenant.brokerageId })
}
