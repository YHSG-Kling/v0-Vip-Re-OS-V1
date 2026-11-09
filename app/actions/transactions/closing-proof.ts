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
import { noCdaClosingProof, resolveCdaMode, type NoCdaClosingProof } from "@/lib/transactions/cda-closing-policy"
import { LIFETIME_HOLD_ACTIVITY_TYPE } from "@/lib/kernel/lifetime-conversion"

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
  const cdaMode = resolveCdaMode({ offersCda: b.offers_cda ?? null, nonCdaPayoutDefault: b.non_cda_payout_default ?? null })

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
