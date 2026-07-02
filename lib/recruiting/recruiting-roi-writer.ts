// lib/recruiting/recruiting-roi-writer.ts
//
// Live side of the RECRUITING ROI WRITER (recruiting_manager). Reads a recruited agent's real cost +
// production rows and upserts ONE recruiting_roi row (idempotent per recruited agent, via the m257
// unique index). Called on the two events that change ROI — the agent's first close and a cost entry —
// plus a brokerage-wide refresh the recruiting cron rides. Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { computeRecruitingRoi } from "./recruiting-roi-compute"

type Svc = ReturnType<typeof createServiceClient>

/** Recompute + upsert one recruited agent's ROI row from their real cost + production data. */
export async function upsertRecruitingRoi(
  svc: Svc,
  params: { brokerageId: string; recruitedAgentId: string },
): Promise<{ ok: boolean; roiPct: number | null }> {
  if (!params.brokerageId || !params.recruitedAgentId) return { ok: false, roiPct: null }

  const [{ data: costs }, { data: analytics }] = await Promise.all([
    svc.from("recruiting_costs").select("amount").eq("brokerage_id", params.brokerageId).eq("recruited_agent_id", params.recruitedAgentId),
    svc.from("recruiting_analytics").select("brokerage_net_from_agent, gross_commission_generated, year_number").eq("brokerage_id", params.brokerageId).eq("recruited_agent_id", params.recruitedAgentId),
  ])

  const roi = computeRecruitingRoi((costs ?? []) as any, (analytics ?? []) as any)
  const row = {
    brokerage_id: params.brokerageId,
    recruited_agent_id: params.recruitedAgentId,
    total_recruiting_cost: roi.total_recruiting_cost,
    lifetime_brokerage_net: roi.lifetime_brokerage_net,
    roi_pct: roi.roi_pct,
    breakeven_month: roi.breakeven_month,
    ltv_estimate: roi.ltv_estimate,
    computed_at: new Date().toISOString(),
  }

  const { data: existing } = await svc
    .from("recruiting_roi").select("id")
    .eq("brokerage_id", params.brokerageId).eq("recruited_agent_id", params.recruitedAgentId)
    .maybeSingle()
  if (existing) {
    await svc.from("recruiting_roi").update(row).eq("id", (existing as any).id)
  } else {
    await svc.from("recruiting_roi").insert(row)
  }
  return { ok: true, roiPct: roi.roi_pct }
}

/**
 * AUTONOMOUS — refresh ROI for every recruited agent in a brokerage that has production or cost on file.
 * Rides the weekly recruiting cron so ROI stays current even without a triggering event. Idempotent.
 */
export async function refreshAllRecruitingRoi(
  svc: Svc,
  params: { brokerageId: string },
): Promise<{ agents: number; written: number }> {
  const out = { agents: 0, written: 0 }
  const ids = new Set<string>()
  const [{ data: a }, { data: c }] = await Promise.all([
    svc.from("recruiting_analytics").select("recruited_agent_id").eq("brokerage_id", params.brokerageId).not("recruited_agent_id", "is", null).limit(1000),
    svc.from("recruiting_costs").select("recruited_agent_id").eq("brokerage_id", params.brokerageId).not("recruited_agent_id", "is", null).limit(1000),
  ])
  for (const r of [...(a ?? []), ...(c ?? [])] as Array<{ recruited_agent_id: string }>) ids.add(r.recruited_agent_id)
  for (const id of ids) {
    out.agents++
    const r = await upsertRecruitingRoi(svc, { brokerageId: params.brokerageId, recruitedAgentId: id })
    if (r.ok) out.written++
  }
  return out
}
