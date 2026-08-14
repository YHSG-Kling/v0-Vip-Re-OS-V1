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

/**
 * Production and company dollar for ONE office of a multi-location brokerage.
 *
 * THE OFFICE IS DERIVED, NOT STORED — and that is the decision, not an
 * accident. `commission_splits`, `agent_commissions` and
 * `transaction_commissions` carry `brokerage_id` and no `location_id`; the only
 * office anchor in the schema is `agents.location_id`. So an office total is a
 * JOIN through the producing agent, computed at read time.
 *
 * What that buys: no migration, no backfill, and no second place for the number
 * to drift from. What it costs, stated plainly because it is a real trade: an
 * agent who TRANSFERS offices retroactively moves their whole commission
 * history with them, because the join asks where they are NOW, not where they
 * were when the deal closed. If closings must stay with the office that earned
 * them, `location_id` has to be stamped on the split at write time — both
 * writers (app/actions/agents.ts:625, lib/kernel/financial.ts:1165) already
 * resolve the agent, so that is a small change when the answer is needed. It is
 * deliberately NOT made now: with no closed deals on the platform yet there is
 * no history to preserve, and stamping a column nobody reads is how the last
 * three writer-less columns got here.
 */
export interface OfficeProduction {
  /** `locations.id`, or null for the bucket of agents with no office set. */
  locationId: string | null
  name: string
  gci: number
  closings: number
  /** Company dollar attributed to this office (commission_splits.brokerage_amount). */
  brokerageNet: number
  /** Paid to this office's agents (commission_splits.agent_amount). */
  agentPayouts: number
  agentCount: number
}

export interface BrokeragePnl {
  brokerageId: string
  since: string
  until: string
  revenue: BrokerageRevenue
  byAgent: AgentProduction[]
  /**
   * Empty array when the brokerage has no `locations` rows — a single-office
   * brokerage gets no office breakdown rather than one meaningless "Main
   * Office" row covering 100% of everything. Callers should render this section
   * only when it is non-empty.
   */
  byOffice: OfficeProduction[]
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
  // `agent_id` is selected so the same rows can be folded a second time BY
  // OFFICE below. One read, two rollups — re-querying commission_splits per
  // office would give the office totals a chance to disagree with the
  // brokerage total they are supposed to sum to.
  let splitRows: Array<{ agent_id: string | null; brokerage_amount: number | null; agent_amount: number | null }> = []
  if (txnIds.length > 0) {
    const { data: splits } = await supabase
      .from("commission_splits")
      .select("agent_id, brokerage_amount, agent_amount")
      .eq("brokerage_id", params.brokerageId)
      .in("transaction_id", txnIds)
    splitRows = (splits ?? []) as typeof splitRows
    const rolled = rollupSplits(splitRows)
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
  // Office of every agent who appears EITHER as a producer or on a split. The
  // two sets are not identical — a split can name an agent whose transaction
  // fell outside the window's producer set — and an agent missing from this map
  // would silently drop their money out of the office totals.
  const officeByAgent = new Map<string, string | null>()
  const splitAgentIds = splitRows.map((s) => s.agent_id).filter((x): x is string => !!x)
  const agentIdsForOffice = Array.from(new Set([...agentIds, ...splitAgentIds]))
  if (agentIdsForOffice.length > 0) {
    const { data: officeRows, error: officeErr } = await supabase
      .from("agents").select("id, location_id").in("id", agentIdsForOffice)
    if (officeErr) {
      // A refused read here would otherwise file EVERY agent under "No office"
      // and read as a real finding on the report.
      console.error("[brokerage-pnl] agent office read FAILED:", officeErr.message)
    }
    for (const a of (officeRows ?? []) as Array<{ id: string; location_id: string | null }>) {
      officeByAgent.set(a.id, a.location_id ?? null)
    }
  }
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

  // ── BY OFFICE ──────────────────────────────────────────────────────────────
  // Only for a brokerage that actually HAS offices. A single-office brokerage
  // gets an empty array, not one row labelled "Main Office" restating the
  // brokerage total — a breakdown that never breaks anything down is noise the
  // reader has to learn to ignore.
  const byOffice: OfficeProduction[] = []
  const { data: officeList, error: officeListErr } = await supabase
    .from("locations")
    .select("id, name")
    .eq("brokerage_id", params.brokerageId)
    .order("name")
  if (officeListErr) {
    console.error("[brokerage-pnl] locations read FAILED:", officeListErr.message)
  }
  const offices = (officeList ?? []) as Array<{ id: string; name: string | null }>
  if (offices.length > 0) {
    const nameByLocation = new Map<string | null, string>(offices.map((o) => [o.id, o.name || "Office"]))
    // The null bucket is NAMED, not hidden. Agents with no office set still
    // produce, and their money has to land somewhere the reader can see — an
    // office report whose parts do not sum to the brokerage total is worse than
    // no office report.
    nameByLocation.set(null, "No office assigned")

    const acc = new Map<string | null, OfficeProduction>()
    const seenAgents = new Map<string | null, Set<string>>()
    const bucket = (loc: string | null): OfficeProduction => {
      let b = acc.get(loc)
      if (!b) {
        b = {
          locationId: loc,
          name: nameByLocation.get(loc) ?? "Office",
          gci: 0, closings: 0, brokerageNet: 0, agentPayouts: 0, agentCount: 0,
        }
        acc.set(loc, b)
        seenAgents.set(loc, new Set())
      }
      return b
    }

    for (const [agentId, prod] of byAgentMap) {
      const loc = officeByAgent.get(agentId) ?? null
      const b = bucket(loc)
      b.gci += prod.gci
      b.closings += prod.closings
      seenAgents.get(loc)!.add(agentId)
    }
    for (const s of splitRows) {
      const loc = s.agent_id ? (officeByAgent.get(s.agent_id) ?? null) : null
      const b = bucket(loc)
      b.brokerageNet += Number(s.brokerage_amount ?? 0)
      b.agentPayouts += Number(s.agent_amount ?? 0)
      if (s.agent_id) seenAgents.get(loc)!.add(s.agent_id)
    }
    for (const [loc, ids] of seenAgents) {
      const b = acc.get(loc)
      if (b) b.agentCount = ids.size
    }
    byOffice.push(...Array.from(acc.values()).sort((a, b) => b.gci - a.gci))
  }

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
    byOffice,
    recruiting,
    referrals,
  }
}
