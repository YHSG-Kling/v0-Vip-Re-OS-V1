// lib/intelligence/brokerage-pnl.ts
//
// BROKERAGE OWNER'S REPORT — the financials capstone. Where the Manager Weekly P&L
// shows per-manager production, this is the OWNER's view: the brokerage's economics
// for a period, assembled from the loops the audit made trustworthy —
//   · GCI + company dollar (transactions.commission_amount + commission_splits, m214)
//   · production by agent
//   · recruiting economics (recruiting_roi — cost vs lifetime brokerage net; the
//     Recruiting Manager keeps this pipeline producing)
//   · referral value (referral_partners.total_value_generated — credited automatically
//     by the referral closing loop)
// No model narration in the numbers — pure SUM()/COUNT() over real columns.

import { createServiceClient } from "@/lib/supabase/service"

export interface BrokerageRevenue {
  /** Gross commission income on deals that closed in the window. */
  gci: number
  /** Company dollar — the brokerage's share (commission_splits.brokerage_amount). */
  brokerageNet: number
  /** Paid out to agents (commission_splits.agent_amount). */
  agentPayouts: number
  closings: number
  avgCommission: number
}

export interface AgentProduction {
  agentId: string
  name: string
  gci: number
  closings: number
}

export interface RecruitingEconomics {
  recruitedAgentCount: number
  totalRecruitingCost: number
  lifetimeBrokerageNet: number
  /** Blended ROI % = (lifetimeNet − cost) / cost × 100; null when no cost recorded. */
  blendedRoiPct: number | null
}

export interface ReferralEconomics {
  activePartners: number
  partnerValueGenerated: number
}

export interface BrokeragePnl {
  brokerageId: string
  since: string
  until: string
  revenue: BrokerageRevenue
  byAgent: AgentProduction[]
  recruiting: RecruitingEconomics
  referrals: ReferralEconomics
}

/** Pure: fold commission-split rows into the company-dollar / payout split. */
export function rollupSplits(rows: Array<{ brokerage_amount: number | null; agent_amount: number | null }>): { brokerageNet: number; agentPayouts: number } {
  let brokerageNet = 0, agentPayouts = 0
  for (const r of rows) {
    brokerageNet += Number(r.brokerage_amount ?? 0)
    agentPayouts += Number(r.agent_amount ?? 0)
  }
  return { brokerageNet, agentPayouts }
}

/** Pure: blended recruiting ROI %, null when no cost basis. */
export function blendedRoi(totalCost: number, lifetimeNet: number): number | null {
  if (totalCost <= 0) return null
  return Math.round(((lifetimeNet - totalCost) / totalCost) * 100)
}

export interface BrokeragePnlParams {
  brokerageId: string
  /** Window on transactions.close_date. Defaults: year-to-date. */
  sinceIso?: string
  untilIso?: string
}

export async function generateBrokeragePnl(
  params: BrokeragePnlParams,
  client?: ReturnType<typeof createServiceClient>,
): Promise<BrokeragePnl> {
  const supabase = client ?? createServiceClient()
  const since = params.sinceIso ?? new Date(new Date().getFullYear(), 0, 1).toISOString()
  const until = params.untilIso ?? new Date().toISOString()
  const sinceDate = since.slice(0, 10)
  const untilDate = until.slice(0, 10)

  // Closed deals in the window → GCI + per-agent production.
  const { data: txns } = await supabase
    .from("transactions")
    .select("id, agent_id, commission_amount, close_date")
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "closed")
    .gte("close_date", sinceDate).lt("close_date", untilDate)
    .limit(5000)
  const transactions = (txns ?? []) as Array<{ id: string; agent_id: string | null; commission_amount: number | null }>

  const gci = transactions.reduce((s, t) => s + Number(t.commission_amount ?? 0), 0)
  const closings = transactions.length
  const avgCommission = closings > 0 ? Math.round(gci / closings) : 0

  // Company dollar / agent payouts for those transactions.
  const txnIds = transactions.map((t) => t.id)
  let brokerageNet = 0, agentPayouts = 0
  if (txnIds.length > 0) {
    const { data: splits } = await supabase
      .from("commission_splits")
      .select("brokerage_amount, agent_amount")
      .eq("brokerage_id", params.brokerageId)
      .in("transaction_id", txnIds)
    const rolled = rollupSplits((splits ?? []) as Array<{ brokerage_amount: number | null; agent_amount: number | null }>)
    brokerageNet = rolled.brokerageNet
    agentPayouts = rolled.agentPayouts
  }

  // Per-agent production.
  const byAgentMap = new Map<string, { gci: number; closings: number }>()
  for (const t of transactions) {
    if (!t.agent_id) continue
    const a = byAgentMap.get(t.agent_id) ?? { gci: 0, closings: 0 }
    a.gci += Number(t.commission_amount ?? 0)
    a.closings += 1
    byAgentMap.set(t.agent_id, a)
  }
  const agentIds = Array.from(byAgentMap.keys())
  const nameById = new Map<string, string>()
  if (agentIds.length > 0) {
    const { data: agentRows } = await supabase
      .from("agents").select("id, user_id").in("id", agentIds)
    const userIds = ((agentRows ?? []) as Array<{ id: string; user_id: string | null }>)
    const uidByAgent = new Map(userIds.map((a) => [a.id, a.user_id]))
    const uids = userIds.map((a) => a.user_id).filter(Boolean) as string[]
    if (uids.length > 0) {
      const { data: users } = await supabase.from("users").select("id, first_name, last_name").in("id", uids)
      const nameByUid = new Map(((users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>)
        .map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "Agent"]))
      for (const a of agentIds) {
        const uid = uidByAgent.get(a)
        nameById.set(a, (uid && nameByUid.get(uid)) || "Agent")
      }
    }
  }
  const byAgent: AgentProduction[] = agentIds
    .map((id) => ({ agentId: id, name: nameById.get(id) ?? "Agent", gci: byAgentMap.get(id)!.gci, closings: byAgentMap.get(id)!.closings }))
    .sort((a, b) => b.gci - a.gci)

  // Recruiting economics — latest ROI snapshot per recruited agent.
  const { data: roiRows } = await supabase
    .from("recruiting_roi")
    .select("recruited_agent_id, total_recruiting_cost, lifetime_brokerage_net")
    .eq("brokerage_id", params.brokerageId)
  const latestByAgent = new Map<string, { cost: number; net: number }>()
  for (const r of (roiRows ?? []) as Array<{ recruited_agent_id: string; total_recruiting_cost: number | null; lifetime_brokerage_net: number | null }>) {
    latestByAgent.set(r.recruited_agent_id, { cost: Number(r.total_recruiting_cost ?? 0), net: Number(r.lifetime_brokerage_net ?? 0) })
  }
  let totalRecruitingCost = 0, lifetimeBrokerageNet = 0
  for (const v of latestByAgent.values()) { totalRecruitingCost += v.cost; lifetimeBrokerageNet += v.net }
  const recruiting: RecruitingEconomics = {
    recruitedAgentCount: latestByAgent.size,
    totalRecruitingCost,
    lifetimeBrokerageNet,
    blendedRoiPct: blendedRoi(totalRecruitingCost, lifetimeBrokerageNet),
  }

  // Referral value generated (lifetime, credited by the closing loop).
  const { data: partners } = await supabase
    .from("referral_partners")
    .select("total_value_generated, active")
    .eq("brokerage_id", params.brokerageId)
  const partnerRows = (partners ?? []) as Array<{ total_value_generated: number | null; active: boolean | null }>
  const referrals: ReferralEconomics = {
    activePartners: partnerRows.filter((p) => p.active).length,
    partnerValueGenerated: partnerRows.reduce((s, p) => s + Number(p.total_value_generated ?? 0), 0),
  }

  return {
    brokerageId: params.brokerageId,
    since, until,
    revenue: { gci, brokerageNet, agentPayouts, closings, avgCommission },
    byAgent,
    recruiting,
    referrals,
  }
}
