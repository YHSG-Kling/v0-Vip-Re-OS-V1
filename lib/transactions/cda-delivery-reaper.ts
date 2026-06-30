// ─── CDA-DELIVERY REAPER (Deal Coordinator) ──────────────────────────────────
// Nothing-falls-through guard for fund disbursement: a CDA approved but never
// delivered to title (the best-effort send failed silently) is escalated to the
// responsible agent so title gets the disbursement authorization before closing —
// otherwise funds can't split correctly and the closing stalls. Pure policy in
// cda-delivery-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyUndeliveredCda } from "./cda-delivery-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface CdaDeliveryReapResult {
  scanned: number
  escalated: number
}

export async function reapUndeliveredCdas(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<CdaDeliveryReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: CdaDeliveryReapResult = { scanned: 0, escalated: 0 }

  const { data: rows } = await svc
    .from("closing_disclosure_agreement")
    .select("id, status, sent_to_title_at, uses_cda, updated_at, transaction_id, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "approved")
    .is("sent_to_title_at", null)
    .limit(opts?.limit ?? 200)

  for (const row of (rows ?? []) as Array<{
    id: string; status: string | null; sent_to_title_at: string | null
    uses_cda: boolean | null; updated_at: string | null; transaction_id: string | null; agent_id: string | null
  }>) {
    result.scanned++
    if (classifyUndeliveredCda({ status: row.status, sentToTitleAt: row.sent_to_title_at, usesCda: row.uses_cda, updatedAt: row.updated_at, now }) !== "escalate") {
      continue
    }

    // Idempotent: one open alert per CDA.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "cda_undelivered")
      .eq("entity_id", row.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
    const agentUserId = await resolveResponsibleAgentUserId(svc, {
      recipient_contact_id: null,
      entity_type: "transaction",
      entity_id: row.transaction_id,
    })
    // Fall back to the CDA's own agent_id (treated as a user id) if no responsible agent resolves.
    const userId = agentUserId ?? row.agent_id
    if (!userId) continue

    await svc.from("notifications").insert({
      user_id: userId,
      brokerage_id: brokerageId,
      type: "cda_undelivered",
      title: "💵 An approved CDA never reached title",
      body: "A Commission Disbursement Authorization was approved but never delivered to the title/escrow company — the send may have failed. Re-send it so funds can disburse correctly at closing.",
      entity_type: "closing_disclosure_agreement",
      entity_id: row.id,
      priority: "high",
      is_read: false,
    })
    result.escalated++
  }

  return result
}
