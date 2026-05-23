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

const STAFF_ROLES = new Set(["broker", "admin", "compliance_officer", "tc"])

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
  if (!STAFF_ROLES.has(caller.userType ?? "")) {
    return { success: false, error: "Forbidden" }
  }
  const ownerBrokerage = await offerBrokerageId(params.offerId)
  if (!ownerBrokerage || ownerBrokerage !== caller.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  return emitCompliancePassed({ offerId: params.offerId, userId: caller.userId })
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
