"use server"

/**
 * app/actions/commission-policy/client-agreement-fees.ts — THE DOORS FOR TRANSACTION / ADMIN FEES THE SELLER'S AND THE BUYER'S
 * AGREEMENTS ESTABLISH (wave 145, lane 145C; owner ruling 5, 2026-10-27).
 *
 * Every export is a public endpoint (CLAUDE.md §4): async, tenant from the SESSION, never a body field. The agent who wrote the
 * client agreement ENTERS a fee (not authoritative); a finance admin or the compliance officer VERIFIES it against the executed
 * agreement and records the brokerage-policy decision; an executed amendment supersedes it. Rules + writers:
 * lib/commission/client-agreement-fees.ts (service client after its own gate). Never an agent-agreement fee.
 */

import { resolveSessionActor } from "@/lib/agreements/session-actor"
import type { ClientFeeEntry, ClientFeeResolution } from "@/lib/commission/client-agreement-fees"

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function svc() {
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as never
}

/** The deal's client-agreement fees as the settlement will see them (the deal's agent or tenant staff). */
export async function listClientAgreementFeesAction(input: { transactionId: string }): Promise<ActionResult<{ available: boolean; resolution: ClientFeeResolution; agreements: Array<{ kind: "listing_agreement" | "buyer_broker_agreement"; id: string }>; canVerify: boolean; feeKinds: Array<{ value: string; label: string }> }>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const db = await svc() as unknown as { from: (t: string) => any }
  const { data: txn, error } = await db.from("transactions").select("id, agent_id, buyer_agent_id, seller_agent_id").eq("id", input.transactionId).eq("brokerage_id", s.actor.brokerageId).maybeSingle()
  if (error) return { success: false, error: `Could not read the transaction: ${error.message}` }
  if (!txn) return { success: false, error: "transaction_not_found" }
  const { TENANT_ADMIN_USER_TYPES } = await import("@/lib/auth/resolve-user-role")
  const t = txn as Record<string, unknown>
  const staff = TENANT_ADMIN_USER_TYPES.has(String(s.actor.userType ?? "").toLowerCase()) || String(s.actor.userType ?? "").toLowerCase() === "compliance_officer"
  if (!staff && (!s.actor.agentId || ![t.agent_id, t.buyer_agent_id, t.seller_agent_id].includes(s.actor.agentId))) return { success: false, error: "forbidden" }
  const { loadClientAgreementFeesForTransaction, CLIENT_FEE_KINDS, CLIENT_FEE_KIND_LABEL } = await import("@/lib/commission/client-agreement-fees")
  const r = await loadClientAgreementFeesForTransaction(db, s.actor.brokerageId, input.transactionId)
  if (!r.ok) return { success: false, error: r.error }
  const { isBrokerageFinanceAdmin } = await import("@/lib/auth/resolve-user-role")
  const canVerify = isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal }) || String(s.actor.userType ?? "").toLowerCase() === "compliance_officer"
  // the fee vocabulary the card renders — the ONE list and its labels (m859), never re-typed in the UI (CLAUDE.md §6)
  const feeKinds = CLIENT_FEE_KINDS.map((k) => ({ value: k, label: CLIENT_FEE_KIND_LABEL[k] }))
  return { success: true, available: r.available, resolution: r.resolution, agreements: r.agreements, canVerify, feeKinds }
}

/** The agreement's agent (or staff) enters a fee the client's agreement states — awaiting verification. */
export async function enterClientAgreementFeeAction(input: ClientFeeEntry): Promise<ActionResult<{ feeId: string }>> {
  if (input?.listingAgreementId && !UUID.test(String(input.listingAgreementId))) return { success: false, error: "invalid_agreement" }
  if (input?.buyerBrokerAgreementId && !UUID.test(String(input.buyerBrokerAgreementId))) return { success: false, error: "invalid_agreement" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { enterClientAgreementFee } = await import("@/lib/commission/client-agreement-fees")
  const r = await enterClientAgreementFee(await svc(), s.actor, input)
  if (!r.ok) return { success: false, error: r.error }
  return { success: true, feeId: r.feeId }
}

/** A finance admin / the compliance officer verifies an entered fee against the executed agreement + brokerage policy. */
export async function verifyClientAgreementFeeAction(input: { feeId: string; brokeragePolicyPermits: boolean; brokeragePolicyRef: string }): Promise<ActionResult<object>> {
  if (!UUID.test(String(input?.feeId ?? ""))) return { success: false, error: "invalid_fee" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { verifyClientAgreementFee } = await import("@/lib/commission/client-agreement-fees")
  const r = await verifyClientAgreementFee(await svc(), s.actor, { feeId: input.feeId, brokeragePolicyPermits: input.brokeragePolicyPermits === true, brokeragePolicyRef: String(input.brokeragePolicyRef ?? "") })
  if (!r.ok) return { success: false, error: r.error }
  return { success: true }
}

/** An executed amendment changes a client fee: a new row supersedes the live one (kept), citing the executed document. */
export async function amendClientAgreementFeeAction(input: { supersedesFeeId: string; amendmentDocumentId: string; entry: Omit<ClientFeeEntry, "listingAgreementId" | "buyerBrokerAgreementId" | "kind"> }): Promise<ActionResult<{ feeId: string }>> {
  if (!UUID.test(String(input?.supersedesFeeId ?? "")) || !UUID.test(String(input?.amendmentDocumentId ?? ""))) return { success: false, error: "invalid_input" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { amendClientAgreementFee } = await import("@/lib/commission/client-agreement-fees")
  const r = await amendClientAgreementFee(await svc(), s.actor, input)
  if (!r.ok) return { success: false, error: r.error }
  return { success: true, feeId: r.feeId }
}
