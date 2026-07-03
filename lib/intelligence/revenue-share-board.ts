// lib/intelligence/revenue-share-board.ts
//
// THE REVENUE-SHARE BOARD — the agent-to-agent recruiting growth engine, made visible. The commission
// waterfall already COMPUTES multi-level revenue share to sponsors on every closing (09-revenue-share →
// commission_distributions rows of distribution_type 'residual', keyed to the sponsor agent) and the
// downline lives in agent_relationships (sponsor_agent_id + depth_level + revenue_share_percent). But
// nothing SURFACED it — a recruiting agent couldn't see their downline or the passive income it throws
// off, which is the entire eXp/REAL growth flywheel. This rolls the brokerage's revenue-share activity
// into a board for the one Command Center: how much passive income the network paid out, who's earning
// it, and how deep each earner's downline runs. Read-only; best-effort; no model narration in the numbers.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface RevenueShareEarner {
  agentId: string
  name: string
  earned: number
  /** Active agents this earner personally sponsors (their downline size). */
  downlineSize: number
}

export interface RevenueShareBoard {
  /** Total revenue share paid across the network in the window. */
  totalShared: number
  paidShared: number
  pendingShared: number
  /** Active sponsor→agent relationships in the network. */
  activeRelationships: number
  /** Distinct agents earning revenue share in the window. */
  earnerCount: number
  /** Top earners, highest passive income first (capped for the card). */
  earners: RevenueShareEarner[]
}

interface ResidualRow { agent_id: string | null; calculated_amount: number | null; status: string | null }
interface RelRow { sponsor_agent_id: string | null; is_active: boolean | null }

/** PURE: fold residual distributions + the downline map + names into the board (top earners first). */
export function summarizeRevenueShareBoard(
  distributions: ResidualRow[], relationships: RelRow[], names: Map<string, string>, cap = 8,
): RevenueShareBoard {
  let totalShared = 0, paidShared = 0, pendingShared = 0
  const earnedByAgent = new Map<string, number>()
  for (const d of distributions) {
    if (!d.agent_id) continue
    const amt = Number(d.calculated_amount ?? 0)
    if (!(amt > 0)) continue
    totalShared += amt
    if (d.status === "paid") paidShared += amt
    else pendingShared += amt
    earnedByAgent.set(d.agent_id, (earnedByAgent.get(d.agent_id) ?? 0) + amt)
  }

  let activeRelationships = 0
  const downlineBySponsor = new Map<string, number>()
  for (const r of relationships) {
    if (r.is_active === false || !r.sponsor_agent_id) continue
    activeRelationships++
    downlineBySponsor.set(r.sponsor_agent_id, (downlineBySponsor.get(r.sponsor_agent_id) ?? 0) + 1)
  }

  const earners: RevenueShareEarner[] = Array.from(earnedByAgent.entries())
    .map(([agentId, earned]) => ({
      agentId,
      name: names.get(agentId) || "An agent",
      earned: Math.round(earned * 100) / 100,
      downlineSize: downlineBySponsor.get(agentId) ?? 0,
    }))
    .sort((a, b) => b.earned - a.earned || a.name.localeCompare(b.name))

  return {
    totalShared: Math.round(totalShared * 100) / 100,
    paidShared: Math.round(paidShared * 100) / 100,
    pendingShared: Math.round(pendingShared * 100) / 100,
    activeRelationships,
    earnerCount: earnedByAgent.size,
    earners: earners.slice(0, cap),
  }
}

/** Build the board for a brokerage (trailing 12 months of residual distributions). Best-effort → null. */
export async function generateRevenueShareBoard(
  brokerageId: string, client?: Svc,
): Promise<RevenueShareBoard | null> {
  const supabase = client ?? createServiceClient()
  try {
    // Revenue share is a broker opt-in — hide the board entirely for brokerages that don't offer it.
    const { data: brk } = await supabase.from("brokerages").select("revenue_share_enabled").eq("id", brokerageId).maybeSingle()
    if (!(brk as any)?.revenue_share_enabled) return null

    const since = new Date(Date.now() - 365 * 86_400_000).toISOString()
    const [distRes, relRes] = await Promise.all([
      supabase.from("commission_distributions")
        .select("agent_id, calculated_amount, status")
        .eq("brokerage_id", brokerageId).eq("distribution_type", "residual").gte("created_at", since).limit(5000),
      supabase.from("agent_relationships")
        .select("sponsor_agent_id, is_active").eq("brokerage_id", brokerageId).eq("is_active", true).limit(5000),
    ])
    const distributions = (distRes.data ?? []) as ResidualRow[]
    const relationships = (relRes.data ?? []) as RelRow[]
    if (distributions.length === 0 && relationships.length === 0) {
      return { totalShared: 0, paidShared: 0, pendingShared: 0, activeRelationships: 0, earnerCount: 0, earners: [] }
    }

    // Names for the earners (agents.id → users embed).
    const ids = Array.from(new Set(distributions.map((d) => d.agent_id).filter(Boolean))) as string[]
    const names = new Map<string, string>()
    if (ids.length) {
      const { data: agentRows } = await supabase.from("agents").select("id, users(first_name, last_name)").in("id", ids)
      for (const a of (agentRows ?? []) as any[]) {
        const u = Array.isArray(a.users) ? a.users[0] : a.users
        const nm = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim()
        if (nm) names.set(a.id, nm)
      }
    }

    return summarizeRevenueShareBoard(distributions, relationships, names)
  } catch (err) {
    console.error("[revenue-share-board] failed:", err)
    return null
  }
}
