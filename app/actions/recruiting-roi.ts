"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"

/**
 * TENANT FROM THE SESSION (§4). Every export here took `brokerageId` as a PARAMETER
 * and filtered on it. The reads run on the RLS client, so a foreign id could not
 * return foreign rows — but the shape was still wrong in two ways: (1) the write
 * (`addRecruitingCost`) stamped the caller-supplied id onto recruiting_costs and
 * lifecycle_events and then handed it to a SERVICE-client recompute
 * (upsertRecruitingRoi) that bypasses RLS; (2) every caller resolved the tenant from
 * the session and then threw it away into a parameter this file re-trusted — the
 * "passed and never verified" shape scripts/inert-argument-sweep-simulator.ts exists
 * for. The parameter is GONE from all six exports; the tenant is the caller's own
 * users.brokerage_id, and because recruiting ROI is brokerage-wide money (§5:
 * commission and spend are off agent-facing display), the caller must administer
 * that tenant (resolveTenantAdmin — the ONE roster). Refusals THROW, matching how
 * every function here already surfaced a database error; the callers that must
 * degrade already `.catch()`.
 */
async function requireRecruitingCaller(): Promise<{ client: Awaited<ReturnType<typeof createClient>>; userId: string; brokerageId: string }> {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: u, error } = await client
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (error) throw new Error(`Could not resolve your profile: ${error.message}`)
  if (!u?.brokerage_id) throw new Error("Your account is not linked to a brokerage")
  const admin = await resolveTenantAdmin(client, user.id, { user_type: u.user_type, brokerage_id: u.brokerage_id })
  if (!admin.ok) throw new Error(`Could not verify your role: ${admin.error}`)
  if (!admin.isTenantAdmin) throw new Error("Forbidden: recruiting ROI is a brokerage admin surface")
  return { client, userId: user.id, brokerageId: u.brokerage_id as string }
}

export async function getRecruitingROISummary() {
  const { client, brokerageId } = await requireRecruitingCaller()

  const { data: summary, error } = await client
    .from("recruiting_roi")
    .select("total_recruiting_cost, lifetime_brokerage_net, roi_pct, breakeven_month")
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  const totalInvested = summary?.reduce((sum, r) => sum + (r.total_recruiting_cost || 0), 0) || 0
  const totalGenerated = summary?.reduce((sum, r) => sum + (r.lifetime_brokerage_net || 0), 0) || 0
  const avgROI = summary?.length ? summary.reduce((sum, r) => sum + (r.roi_pct || 0), 0) / summary.length : 0
  const activeRecruits = summary?.length || 0
  const profitableRecruits = summary?.filter(r => (r.roi_pct || 0) > 0).length || 0

  return {
    totalInvested,
    totalGenerated,
    avgROI,
    activeRecruits,
    profitableRecruits,
  }
}

export async function getRecruitROIByRecruit() {
  const { client, brokerageId } = await requireRecruitingCaller()

  const { data: rois, error: roiError } = await client
    .from("recruiting_roi")
    .select(`
      id,
      recruited_agent_id,
      total_recruiting_cost,
      lifetime_brokerage_net,
      roi_pct,
      breakeven_month,
      agents!recruited_agent_id(created_at, is_active, users(first_name, last_name))
    `)
    .eq("brokerage_id", brokerageId)
    .order("roi_pct", { ascending: false })

  if (roiError) throw roiError
  return rois || []
}

export async function getRecruitingCostBreakdown() {
  const { client, brokerageId } = await requireRecruitingCaller()

  const { data: costs, error } = await client
    .from("recruiting_costs")
    .select("cost_type, amount")
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  const breakdown = {
    training: 0,
    marketing: 0,
    technology: 0,
    bonuses: 0,
    guarantees: 0,
    other: 0,
  }

  costs?.forEach((cost: any) => {
    const type = cost.cost_type?.toLowerCase() || "other"
    if (type in breakdown) {
      breakdown[type as keyof typeof breakdown] += cost.amount || 0
    } else {
      breakdown.other += cost.amount || 0
    }
  })

  return breakdown
}

export async function getBreakEvenAnalysis() {
  const { client, brokerageId } = await requireRecruitingCaller()

  const { data: rois, error } = await client
    .from("recruiting_roi")
    .select("breakeven_month")
    .eq("brokerage_id", brokerageId)
    .not("breakeven_month", "is", null)

  if (error) throw error

  const breakEvenMonths = (rois || [])
    .map(r => r.breakeven_month)
    .filter(m => typeof m === "number")

  const avgBreakEvenMonth = breakEvenMonths.length
    ? breakEvenMonths.reduce((a, b) => a + b, 0) / breakEvenMonths.length
    : 0

  return {
    avgBreakEvenMonth,
    breakEvenMonths,
  }
}

export async function getRecruitingAnalyticsByYear(recruitedAgentId: string) {
  const { client, brokerageId } = await requireRecruitingCaller()

  const { data: analytics, error } = await client
    .from("recruiting_analytics")
    .select("year_number, gross_commission_generated, brokerage_net_from_agent, transaction_count")
    .eq("brokerage_id", brokerageId)
    .eq("recruited_agent_id", recruitedAgentId)
    .order("year_number", { ascending: true })

  if (error) throw error
  return analytics || []
}

export async function addRecruitingCost(
  recruitedAgentId: string,
  costType: string,
  amount: number,
  notes?: string
) {
  const { client, brokerageId } = await requireRecruitingCaller()

  // The recruit must be one of THIS tenant's agents: the cost row, the kernel event
  // and the service-client recompute below all key on it, so a foreign agents.id
  // would otherwise be stamped into this brokerage's books.
  const { data: recruit, error: recruitError } = await client
    .from("agents")
    .select("id")
    .eq("id", recruitedAgentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (recruitError) throw new Error(`Could not verify the recruit: ${recruitError.message}`)
  if (!recruit) throw new Error("Recruit not found in your brokerage")

  const { data, error } = await client
    .from("recruiting_costs")
    .insert({
      brokerage_id: brokerageId,
      recruited_agent_id: recruitedAgentId,
      cost_type: costType,
      amount,
      incurred_date: new Date().toISOString(),
      notes,
    })
    .select()

  if (error) throw error

  // Emit kernel event
  await client
    .from("lifecycle_events")
    .insert({
      brokerage_id: brokerageId,
      event_type: "RECRUITING_COST_ADDED",
      entity_type: "recruiting_cost",
      entity_id: data?.[0]?.id,
      metadata: {
        recruited_agent_id: recruitedAgentId,
        cost_type: costType,
        amount,
      },
      created_at: new Date().toISOString(),
    })

  // Recompute the recruited agent's ROI now that spend changed — keeps the recruiting_roi row (and the
  // dashboard's headline KPIs) live. Best-effort; a recompute hiccup never blocks the cost entry.
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { upsertRecruitingRoi } = await import("@/lib/recruiting/recruiting-roi-writer")
    await upsertRecruitingRoi(createServiceClient(), { brokerageId, recruitedAgentId })
  } catch (e) {
    console.error("[recruiting-roi] recompute after cost entry failed:", e)
  }

  return data?.[0]
}
