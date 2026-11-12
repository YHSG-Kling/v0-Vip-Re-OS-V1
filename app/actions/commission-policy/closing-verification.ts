"use server"

/**
 * app/actions/commission-policy/closing-verification.ts — ASK AT CLOSING (wave 145, lane 145C; owner rulings 6 and 7).
 *
 * The five layers (signed agreements → current effective terms → offer/counter/addenda → settlement → waterfall) for one deal,
 * and the agent's answer to "is any executed change unrecorded?" — lib/commission/closing-verification.ts holds the rules and the
 * one write (a transaction_compliance_log row). Every export is a public endpoint (CLAUDE.md §4): async, tenant from the
 * SESSION; the deal's agent, its transaction coordinator or brokerage staff only; the service client after that gate. A "yes"
 * changes nothing but the attestation row: the executed evidence is recorded through its own door, then the agent attests again.
 */

import { revalidatePath } from "next/cache"
import { resolveSessionActor } from "@/lib/agreements/session-actor"
import type { ClosingAttestationAnswer } from "@/lib/commission/closing-verification"
import type { VerificationLayer } from "@/lib/commission/closing-verification-core"

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function gate(transactionId: string) {
  const s = await resolveSessionActor()
  if (!s.ok) return { ok: false as const, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const db = createServiceClient() as unknown as { from: (t: string) => any }
  const { data: txn, error } = await db.from("transactions").select("id, agent_id, buyer_agent_id, seller_agent_id, coordinator_id").eq("id", transactionId).eq("brokerage_id", s.actor.brokerageId).maybeSingle()
  if (error) return { ok: false as const, error: `transaction_read_refused: ${error.message}` }
  if (!txn) return { ok: false as const, error: "transaction_not_found" }
  const t = txn as Record<string, any>
  let coordinatorUserId: string | null = null
  if (t.coordinator_id) {
    const { data: tc, error: tcErr } = await db.from("transaction_coordinators").select("user_id").eq("id", t.coordinator_id).eq("brokerage_id", s.actor.brokerageId).maybeSingle()
    if (tcErr) return { ok: false as const, error: `coordinator_read_refused: ${tcErr.message}` }
    coordinatorUserId = (tc as { user_id?: string | null } | null)?.user_id ?? null
  }
  const { mayAttestClosing } = await import("@/lib/commission/closing-verification")
  if (!mayAttestClosing(s.actor, { agentIds: [t.agent_id, t.buyer_agent_id, t.seller_agent_id], coordinatorUserId })) return { ok: false as const, error: "forbidden" }
  return { ok: true as const, actor: s.actor, db }
}

/** The five layers + the attestation's state for one deal. */
export async function getClosingVerificationAction(input: { transactionId: string }): Promise<ActionResult<{ layers: VerificationLayer[]; digest: string; findingsCount: number; attestation: { status: string | null; reason: string | null } }>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const g = await gate(input.transactionId)
  if (!g.ok) return { success: false, error: g.error }
  const { buildClosingVerification, closingAttestationState } = await import("@/lib/commission/closing-verification")
  const v = await buildClosingVerification(g.db, g.actor.brokerageId, input.transactionId)
  if (!v.ok) return { success: false, error: v.error }
  const a = await closingAttestationState(g.db, { brokerageId: g.actor.brokerageId, transactionId: input.transactionId })
  if (!a.ok) return { success: false, error: a.error }
  return { success: true, layers: v.layers, digest: v.digest, findingsCount: v.findingsCount, attestation: { status: a.status, reason: a.reason } }
}

/** The agent (or the deal's TC / brokerage staff) answers: is any executed change unrecorded? */
export async function recordClosingAttestationAction(input: { transactionId: string; answer: ClosingAttestationAnswer; description?: string | null }): Promise<ActionResult<{ status: "pass" | "fail"; digest: string }>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const g = await gate(input.transactionId)
  if (!g.ok) return { success: false, error: g.error }
  const { recordClosingAttestation } = await import("@/lib/commission/closing-verification")
  const r = await recordClosingAttestation(g.db, g.actor, { transactionId: input.transactionId, answer: input.answer, description: input.description ?? null })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(`/dashboard/transactions/${input.transactionId}/cda`)
  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true, status: r.status, digest: r.digest }
}
