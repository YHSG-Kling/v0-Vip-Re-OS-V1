// lib/finance/auto-dispute.ts
//
// AUTONOMOUS DISPUTE DETECTION — the Finance Manager catches a commission error instead of waiting for
// a human to notice. When the CDA the agent submitted carries a BLOCKER contract discrepancy (the
// implied split doesn't match the agent's brokerage contract, or the gross is off), the manager acts,
// routed by platform membership:
//   • brokerage ON-platform  → auto-file the dispute so it lands in the broker's dispute queue.
//   • brokerage OFF-platform → the broker isn't in-app; flag the AGENT to raise it with their external
//                              brokerage (never fabricate an in-app resolver that doesn't exist).
// Deduped, best-effort. The pure summarizer is unit-tested.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { CdaDiscrepancy } from "@/lib/commission/cda-discrepancy"
import type { DispositionRoute } from "@/lib/platform/disposition-route"

type Svc = SupabaseClient<any, any, any>

const FIELD_LABEL: Record<string, string> = { agent_split: "agent split", gross_commission: "gross commission", agent_net: "agent net" }

/** PURE: a human reason from the BLOCKER discrepancies, or null when none block. */
export function summarizeBlockerDiscrepancies(discrepancies: CdaDiscrepancy[] | null | undefined): string | null {
  const blockers = (discrepancies ?? []).filter((d) => d.severity === "blocker")
  if (blockers.length === 0) return null
  const parts = blockers.map((d) => {
    const label = FIELD_LABEL[d.field] ?? d.field
    const pct = d.field === "agent_split"
    const fmt = (n: number) => (pct ? `${n}%` : `$${n.toLocaleString()}`)
    return `${label}: CDA shows ${fmt(d.actual)} vs contract ${fmt(d.expected)}`
  })
  return `AI-detected contract mismatch — ${parts.join("; ")}`
}

/**
 * If the CDA submission has a blocker contract discrepancy, act on it (route-aware). Idempotent
 * (skips an already-disputed commission / a recent agent flag). Best-effort — never blocks the submit.
 */
export async function autoDetectCommissionDispute(
  svc: Svc,
  params: {
    transactionId: string
    brokerageId: string
    discrepancies: CdaDiscrepancy[] | null | undefined
    dispositionRoute: DispositionRoute
  },
): Promise<{ acted: "auto_disputed" | "agent_flagged" | "none"; reason: string | null }> {
  const reason = summarizeBlockerDiscrepancies(params.discrepancies)
  if (!reason) return { acted: "none", reason: null }

  // The disputable earnings record for this transaction (pending/approved only).
  const { data: comm } = await svc
    .from("agent_commissions")
    .select("id, agent_id, status")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle()
  if (!comm) return { acted: "none", reason }
  const commissionId = (comm as any).id as string
  const agentId = (comm as any).agent_id as string

  const now = new Date().toISOString()

  if (params.dispositionRoute === "in_app") {
    // Auto-file the dispute so the on-platform broker resolves it. System-initiated (not a user action).
    await svc
      .from("agent_commissions")
      .update({ status: "disputed", dispute_reason: reason, disputed_at: now, disputed_by: "system:ai_finance", dispute_resolution: null, dispute_resolved_at: null, updated_at: now })
      .eq("id", commissionId)
      .in("status", ["pending", "approved"]) // idempotent — no-op if already disputed
    await svc.from("lifecycle_events").insert({
      entity_type: "agent_commission", entity_id: commissionId,
      event_type: "commission_disputed", metadata: { reason, auto: true, source: "cda_contract_discrepancy" }, created_at: now,
    }).then(() => {}, () => {})
    return { acted: "auto_disputed", reason }
  }

  // OFF-platform brokerage: no in-app broker to resolve — flag the AGENT to raise it externally. Dedupe.
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: agent } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  const userId = (agent as { user_id?: string | null } | null)?.user_id ?? null
  if (userId) {
    const { data: existing } = await svc
      .from("notifications")
      .select("id").eq("user_id", userId).eq("type", "cda_contract_mismatch").eq("entity_id", commissionId).gte("created_at", since).limit(1)
    if (!existing || existing.length === 0) {
      await svc.from("notifications").insert({
        user_id: userId, brokerage_id: params.brokerageId, type: "cda_contract_mismatch",
        title: "Check your CDA before your brokerage signs",
        body: `${reason}. Because your brokerage isn't on the platform, raise this with them directly through your form platform before it's finalized.`,
        entity_type: "agent_commission", entity_id: commissionId, priority: "high", channel: "in_app",
      }).then(() => {}, () => {})
    }
  }
  return { acted: "agent_flagged", reason }
}
