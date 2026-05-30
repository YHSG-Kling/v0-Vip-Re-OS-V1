"use server"

/**
 * Deal Risk Radar — agent-facing reads.
 *
 * The deal-health-scan cron runs every 6 hours and writes deal_health_scores
 * per transaction. This module surfaces those scores to the responsible
 * agent (buyer_agent_id OR seller_agent_id OR agent_id on the transaction).
 *
 * Returns at-risk + critical transactions ranked by severity for the agent's
 * dashboard widget.
 */

import { createClient } from "@/lib/supabase/server"

export interface AgentDealRisk {
  transactionId: string
  propertyAddress: string | null
  contactName: string | null
  riskLevel: "healthy" | "watch" | "at_risk" | "critical"
  healthScore: number
  scoreDelta: number | null
  topConcerns: Array<{ category: string; severity: string; message: string }>
  scoredAt: string
  openInterventions: number
}

export async function getAgentAtRiskTransactions(params: {
  agentId: string
  brokerageId?: string
  limit?: number
}): Promise<AgentDealRisk[]> {
  const supabase = await createClient()
  const limit = params.limit ?? 5

  // 1. Most recent scores per transaction where this agent is involved
  const { data: rows } = await supabase
    .from("deal_health_scores")
    .select(
      "transaction_id, overall_score, previous_score, score_delta, risk_level, score_components, scored_at, " +
        "transactions!inner(property_address, agent_id, buyer_agent_id, seller_agent_id, contact_id, contacts(first_name, last_name))"
    )
    .in("risk_level", ["watch", "at_risk", "critical"])
    .order("scored_at", { ascending: false })
    .limit(50)

  if (!rows) return []

  // Filter to this agent + dedupe to most recent score per transaction
  const seenTxn = new Set<string>()
  const out: AgentDealRisk[] = []

  for (const row of rows as unknown as Array<{
    transaction_id: string
    overall_score: number
    previous_score: number | null
    score_delta: number | null
    risk_level: "healthy" | "watch" | "at_risk" | "critical"
    score_components: Array<{ category?: string; severity?: string; message?: string }> | null
    scored_at: string
    transactions: {
      property_address: string | null
      agent_id: string | null
      buyer_agent_id: string | null
      seller_agent_id: string | null
      contact_id: string | null
      contacts: { first_name: string | null; last_name: string | null } | null
    } | null
  }>) {
    if (!row.transactions) continue
    const isOwnTxn =
      row.transactions.agent_id === params.agentId ||
      row.transactions.buyer_agent_id === params.agentId ||
      row.transactions.seller_agent_id === params.agentId
    if (!isOwnTxn) continue
    if (seenTxn.has(row.transaction_id)) continue
    seenTxn.add(row.transaction_id)

    const components = row.score_components ?? []
    const topConcerns = components
      .filter((c) => c.severity === "high" || c.severity === "critical")
      .slice(0, 3)
      .map((c) => ({
        category: c.category ?? "general",
        severity: c.severity ?? "high",
        message: c.message ?? "",
      }))

    const contactName = row.transactions.contacts
      ? `${row.transactions.contacts.first_name ?? ""} ${row.transactions.contacts.last_name ?? ""}`.trim()
      : null

    out.push({
      transactionId: row.transaction_id,
      propertyAddress: row.transactions.property_address,
      contactName,
      riskLevel: row.risk_level,
      healthScore: row.overall_score,
      scoreDelta: row.score_delta,
      topConcerns,
      scoredAt: row.scored_at,
      openInterventions: 0, // populated below
    })

    if (out.length >= limit) break
  }

  if (out.length === 0) return []

  // 2. Count open interventions per surfaced transaction
  const txnIds = out.map((r) => r.transactionId)
  const { data: interventions } = await supabase
    .from("proactive_interventions")
    .select("transaction_id")
    .in("transaction_id", txnIds)
    .eq("resolved", false)

  const interventionCount = new Map<string, number>()
  for (const i of (interventions as Array<{ transaction_id: string }>) ?? []) {
    interventionCount.set(i.transaction_id, (interventionCount.get(i.transaction_id) ?? 0) + 1)
  }
  for (const r of out) {
    r.openInterventions = interventionCount.get(r.transactionId) ?? 0
  }

  // Rank: critical first, then at_risk, then watch — within each, lowest score first
  const order = { critical: 0, at_risk: 1, watch: 2, healthy: 3 } as const
  out.sort((a, b) => {
    const lvl = order[a.riskLevel] - order[b.riskLevel]
    if (lvl !== 0) return lvl
    return a.healthScore - b.healthScore
  })

  return out.slice(0, limit)
}
