"use server"

// app/actions/agent-pl.ts
// AGENT P&L SELF-SERVICE — the agent sees THEIR OWN monthly profit-and-loss (the agent_pl_snapshot the
// nightly rollup already computes), which was previously visible only to broker-admins. An agent gets
// their production (GCI), take-home (payout), deal count, and — the differentiator — the cost + ROI of
// their AI tools, so they can see the platform paying for itself. User-auth scoped to the caller's own
// agent_id; no broker gate.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export interface MyPLMonth {
  monthYear: string
  gciGross: number
  agentPayout: number
  transactionCount: number
  aiCostCents: number
  roiMultiple: number | null
}

export interface MyPLResult {
  rows: MyPLMonth[]
  ytd: {
    gciGross: number
    agentPayout: number
    transactionCount: number
    aiCostCents: number
    /** GCI produced per $1 of AI-tool cost this year (production ROI on the platform). */
    aiRoiMultiple: number | null
  }
}

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return null
  return { agentId, brokerageId }
}

export async function getMyPLTrendAction(input?: { months?: number }): Promise<
  { success: true; data: MyPLResult } | { success: false; error: string }
> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const months = Math.max(1, Math.min(36, input?.months ?? 12))
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("agent_pl_snapshot")
    .select("month_year, gci_gross, agent_payout, transaction_count, ai_cost_cents, roi_multiple")
    .eq("agent_id", c.agentId)
    .order("month_year", { ascending: false })
    .limit(months)
  if (error) return { success: false, error: error.message }

  const rows: MyPLMonth[] = (data ?? []).map((r: any) => ({
    monthYear: r.month_year,
    gciGross: Number(r.gci_gross ?? 0),
    agentPayout: Number(r.agent_payout ?? 0),
    transactionCount: Number(r.transaction_count ?? 0),
    aiCostCents: Number(r.ai_cost_cents ?? 0),
    roiMultiple: r.roi_multiple != null ? Number(r.roi_multiple) : null,
  }))

  const thisYear = `${new Date().getUTCFullYear()}-`
  const ytdRows = rows.filter((r) => r.monthYear.startsWith(thisYear))
  const gciGross = ytdRows.reduce((s, r) => s + r.gciGross, 0)
  const agentPayout = ytdRows.reduce((s, r) => s + r.agentPayout, 0)
  const transactionCount = ytdRows.reduce((s, r) => s + r.transactionCount, 0)
  const aiCostCents = ytdRows.reduce((s, r) => s + r.aiCostCents, 0)
  const aiRoiMultiple = aiCostCents > 0 ? Math.round((gciGross / (aiCostCents / 100)) * 10) / 10 : null

  return {
    success: true,
    data: {
      rows: rows.slice().reverse(), // chronological for charting
      ytd: { gciGross, agentPayout, transactionCount, aiCostCents, aiRoiMultiple },
    },
  }
}
