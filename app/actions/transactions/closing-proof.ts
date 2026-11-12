"use server"

/**
 * app/actions/transactions/closing-proof.ts — CLOSING WITHOUT A CDA: THE SMALLEST HONEST CLOSING PROOF, READ (wave 151, lane 151K).
 *
 * Owner (wave 151, binding): "L6 finish — if the brokerage doesn't use CDAs (their settings), then it can close without a CDA."
 * The RULE is pure: lib/transactions/cda-closing-policy.ts noCdaClosingProof — final settlement / closing record + the brokerage's
 * recorded receipt (who, when) + the transaction compliance status + the payout holds as they stand; funds are never read as
 * received because a closing date exists. This file is the gated READER the CDA page's closing-proof card calls. It writes
 * nothing, creates no CDA, releases no payout.
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant is the SESSION's (resolveSessionActor), the caller must be the
 * deal's agent, its transaction coordinator or tenant staff (the same roster that may answer the closing question —
 * mayAttestClosing), and the service client is used only AFTER that gate. A refused read is a returned reason (supabase-js
 * resolves refusals, CLAUDE.md §3) — never an empty "complete" proof.
 */

import { resolveSessionActor } from "@/lib/agreements/session-actor"
import { noCdaClosingProof, resolveCdaMode, settlementReconciliationForViewer, SETTLEMENT_READINESS_STATES, type NoCdaClosingProof, type SettlementReconciliation } from "@/lib/transactions/cda-closing-policy"
import { LIFETIME_HOLD_ACTIVITY_TYPE } from "@/lib/kernel/lifetime-conversion"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getNoCdaClosingProofAction(input: { transactionId: string }): Promise<ActionResult<{ proof: NoCdaClosingProof; attestation: { status: string | null; reason: string | null } }>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const brokerageId = s.actor.brokerageId
  const { createServiceClient } = await import("@/lib/supabase/service")
  const db = createServiceClient() as unknown as { from: (t: string) => any }

  const { data: txn, error: tErr } = await db.from("transactions").select("id, agent_id, buyer_agent_id, seller_agent_id, coordinator_id, status, close_date, actual_close_date, compliance_passed_at").eq("id", input.transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (tErr) return { success: false, error: `transaction_read_refused: ${tErr.message}` }
  if (!txn) return { success: false, error: "transaction_not_found" }
  const t = txn as Record<string, any>
  let coordinatorUserId: string | null = null
  if (t.coordinator_id) {
    const { data: tc, error: tcErr } = await db.from("transaction_coordinators").select("user_id").eq("id", t.coordinator_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (tcErr) return { success: false, error: `coordinator_read_refused: ${tcErr.message}` }
    coordinatorUserId = (tc as { user_id?: string | null } | null)?.user_id ?? null
  }
  const { mayAttestClosing, closingAttestationState } = await import("@/lib/commission/closing-verification")
  if (!mayAttestClosing(s.actor, { agentIds: [t.agent_id, t.buyer_agent_id, t.seller_agent_id], coordinatorUserId })) return { success: false, error: "forbidden" }

  // the ONE switch
  const { data: brk, error: bErr } = await db.from("brokerages").select("offers_cda, non_cda_payout_default").eq("id", brokerageId).maybeSingle()
  if (bErr) return { success: false, error: `brokerage_read_refused: ${bErr.message}` }
  const b = (brk ?? {}) as { offers_cda?: boolean | null; non_cda_payout_default?: string | null }
  // WAVE 152 (lane 152H): the policy that governs THIS deal — the setting in force when it opened, or a finance admin's switch of
  // the deal (cda-closing-policy.ts §6). A deal opened before an opt-in reads "no CDA" here even after the brokerage opted in.
  const { loadEffectiveCdaModes } = await import("@/lib/transactions/cda-closing-policy")
  const eff = await loadEffectiveCdaModes(db, { brokerageId, transactionIds: [input.transactionId], live: { offersCda: b.offers_cda ?? null, nonCdaPayoutDefault: b.non_cda_payout_default ?? null } })
  const governing = eff.ok ? eff.deals[input.transactionId]?.governing : undefined
  if (!governing) return { success: false, error: `cda_policy_read_refused: ${eff.ok ? "deal not found" : eff.error}` }
  const cdaMode = resolveCdaMode(governing)

  // the final settlement / closing record: the CDA row's attached final statement (with the person who attached it), else a
  // closing disclosure on the document kernel (actor not recorded there — said as null, never guessed)
  const { data: cdaRows, error: cErr } = await db.from("closing_disclosure_agreement").select("id, final_cd_document_id, final_cd_uploaded_at, final_cd_uploaded_by, uses_cda").eq("brokerage_id", brokerageId).eq("transaction_id", input.transactionId).order("updated_at", { ascending: false }).limit(1)
  if (cErr) return { success: false, error: `cda_read_refused: ${cErr.message}` }
  const cda = ((cdaRows ?? [])[0] ?? null) as { final_cd_document_id?: string | null; final_cd_uploaded_at?: string | null; final_cd_uploaded_by?: string | null } | null
  let finalSettlement: Parameters<typeof noCdaClosingProof>[0]["finalSettlement"] = null
  if (cda?.final_cd_document_id) {
    let uploadedByType: string | null = null
    const { data: td, error: tdErr } = await db.from("transaction_documents").select("id, uploaded_by, uploaded_by_type, uploaded_at").eq("id", cda.final_cd_document_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (tdErr) return { success: false, error: `document_read_refused: ${tdErr.message}` }
    const row = td as { uploaded_by?: string | null; uploaded_by_type?: string | null; uploaded_at?: string | null } | null
    if (row?.uploaded_by_type) uploadedByType = row.uploaded_by_type
    finalSettlement = { documentId: cda.final_cd_document_id, uploadedAt: cda.final_cd_uploaded_at ?? row?.uploaded_at ?? null, uploadedBy: cda.final_cd_uploaded_by ?? row?.uploaded_by ?? null, uploadedByType: uploadedByType ?? (cda.final_cd_uploaded_by ? "user" : null) }
  } else {
    const { data: docs, error: dErr } = await db.from("documents").select("id, created_at").eq("brokerage_id", brokerageId).eq("transaction_id", input.transactionId).eq("classification", "closing_disclosure").order("created_at", { ascending: false }).limit(1)
    if (dErr) return { success: false, error: `documents_read_refused: ${dErr.message}` }
    const d = ((docs ?? [])[0] ?? null) as { id: string; created_at?: string | null } | null
    if (d) finalSettlement = { documentId: d.id, uploadedAt: d.created_at ?? null, uploadedBy: null, uploadedByType: null }
  }

  // the brokerage's receipt and the payment states — the ledger's own stamps, never the closing date
  const { data: commissions, error: aErr } = await db.from("agent_commissions").select("id, status, deposit_received_at, deposit_received_by, paid_at, payment_received_at, reconciled_at, payment_initiated_at").eq("brokerage_id", brokerageId).eq("transaction_id", input.transactionId)
  if (aErr) return { success: false, error: `commission_read_refused: ${aErr.message}` }

  // transaction compliance: the open BLOCKING rows
  const { data: blocking, error: lErr } = await db.from("transaction_compliance_log").select("id, status").eq("brokerage_id", brokerageId).eq("transaction_id", input.transactionId).eq("is_blocking", true).in("status", ["fail", "pending", "needs_review"])
  if (lErr) return { success: false, error: `compliance_read_refused: ${lErr.message}` }

  // the lifetime hold ("CLOSED / PAYOUT PENDING")
  const { data: holds, error: hErr } = await db.from("activities").select("id").eq("brokerage_id", brokerageId).eq("transaction_id", input.transactionId).eq("activity_type", LIFETIME_HOLD_ACTIVITY_TYPE).eq("status", "pending").limit(1)
  if (hErr) return { success: false, error: `hold_read_refused: ${hErr.message}` }

  const proof = noCdaClosingProof({
    cdaMode,
    transaction: { status: t.status ?? null, close_date: t.close_date ?? null, actual_close_date: t.actual_close_date ?? null, compliance_passed_at: t.compliance_passed_at ?? null },
    finalSettlement,
    commissions: (commissions ?? []) as Parameters<typeof noCdaClosingProof>[0]["commissions"],
    openBlockingCompliance: ((blocking ?? []) as unknown[]).length,
    lifetimeHoldOpen: ((holds ?? []) as unknown[]).length > 0,
  })
  const a = await closingAttestationState(db, { brokerageId, transactionId: input.transactionId })
  if (!a.ok) return { success: false, error: a.error }
  return { success: true, proof, attestation: { status: a.status, reason: a.reason } }
}

/**
 * WAVE 152 (lane 152G) — THE SETTLEMENT RECONCILIATION, READ. "Contract says / latest title or lender document says" per item, the
 * responsible party, the correction-request status and the readiness (ready / needs review / awaiting a revised closing document /
 * compliance blocked) — from the LATEST versioned snapshot on the policy ledger (policy_decisions, target settlement_reconciliation;
 * written by lib/offers/closing-cost-accuracy.ts reconcileClosingSettlement at the tail of every closing check). Reads only.
 *
 * ROLE PRIVACY (directive: buyer-only vs seller-only disclosures stay separate): the session tenant, then the deal's own roster
 * (mayAttestClosing — its agents, its transaction coordinator, tenant staff); a buyer-side agent never receives a seller-only line nor a
 * seller-side agent a buyer-only one, and commission values reach brokerage staff only (settlementReconciliationForViewer). A vendor,
 * a Contact or another tenant's session is refused before any read.
 */
export async function getSettlementReconciliationAction(input: { transactionId: string }): Promise<ActionResult<{
  reconciliation: (SettlementReconciliation & { withheld: number }) | null
  snapshot: { version: number | null; at: string | null } | null
  history: Array<{ version: number | null; state: string; at: string }>
}>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const brokerageId = s.actor.brokerageId
  const { createServiceClient } = await import("@/lib/supabase/service")
  const db = createServiceClient() as unknown as { from: (t: string) => any }

  const { data: txn, error: tErr } = await db.from("transactions").select("id, agent_id, buyer_agent_id, seller_agent_id, coordinator_id, deal_type").eq("id", input.transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (tErr) return { success: false, error: `transaction_read_refused: ${tErr.message}` }
  if (!txn) return { success: false, error: "transaction_not_found" }
  const t = txn as Record<string, any>
  let coordinatorUserId: string | null = null
  if (t.coordinator_id) {
    const { data: tc, error: tcErr } = await db.from("transaction_coordinators").select("user_id").eq("id", t.coordinator_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (tcErr) return { success: false, error: `coordinator_read_refused: ${tcErr.message}` }
    coordinatorUserId = (tc as { user_id?: string | null } | null)?.user_id ?? null
  }
  const { mayAttestClosing } = await import("@/lib/commission/closing-verification")
  if (!mayAttestClosing(s.actor, { agentIds: [t.agent_id, t.buyer_agent_id, t.seller_agent_id], coordinatorUserId })) return { success: false, error: "forbidden" }

  // which side this viewer sits on — staff (the TC, the tenant roster, compliance) see both and the commission lines
  const userType = String(s.actor.userType ?? "").toLowerCase()
  const staff = TENANT_ADMIN_USER_TYPES.has(userType) || userType === "compliance_officer" || userType === "tc" || (!!coordinatorUserId && coordinatorUserId === s.actor.userId)
  const agentId = s.actor.agentId
  const side: "buyer" | "seller" | "both" = staff ? "both"
    : agentId && agentId === t.buyer_agent_id && agentId !== t.seller_agent_id ? "buyer"
    : agentId && agentId === t.seller_agent_id && agentId !== t.buyer_agent_id ? "seller"
    : agentId && agentId === t.agent_id ? (t.deal_type === "seller" ? "seller" : t.deal_type === "buyer" ? "buyer" : "both")
    : "both"

  const { data: rows, error: pErr } = await db.from("policy_decisions").select("id, created_at, decision, reasons_json, evidence_json").eq("brokerage_id", brokerageId).eq("transaction_id", input.transactionId).eq("target_type", "settlement_reconciliation").order("created_at", { ascending: false }).limit(10)
  if (pErr) return { success: false, error: `reconciliation_read_refused: ${pErr.message}` }
  const list = (rows ?? []) as Array<{ created_at: string; reasons_json: unknown; evidence_json: Record<string, any> | null }>
  const history = list.map((r) => ({ version: typeof r.evidence_json?.version === "number" ? r.evidence_json.version : null, state: String(r.evidence_json?.state ?? "unknown"), at: r.created_at }))
  const latest = list[0]
  const ev = latest?.evidence_json ?? null
  if (!latest || !ev || !(SETTLEMENT_READINESS_STATES as readonly string[]).includes(String(ev.state))) {
    return { success: true, reconciliation: null, snapshot: null, history }
  }
  const rec: SettlementReconciliation = {
    state: ev.state, record: ev.record, items: Array.isArray(ev.items) ? ev.items : [], trid: ev.trid, request: ev.request,
    blockers: ev.state === "ready" ? [] : Array.isArray(latest.reasons_json) ? (latest.reasons_json as unknown[]).map(String) : [],
    fingerprint: String(ev.fingerprint ?? ""),
  }
  return { success: true, reconciliation: settlementReconciliationForViewer(rec, { side, staff }), snapshot: { version: typeof ev.version === "number" ? ev.version : null, at: latest.created_at }, history }
}
