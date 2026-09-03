"use server"

/**
 * Revenue Protection — agent + broker read actions.
 *
 *   - getAgentRevenueProtection({ agentId })
 *   - getBrokerageRevenueProtection({ brokerageId })
 *   - rescanRevenueProtectionAction({ agentId?, brokerageId })
 *
 * Reads the latest snapshot from revenue_protection_snapshots. RLS gates
 * by brokerage_id (migration 1034 + Sprint 1 tenant safety). The rescan
 * action is admin/agent-self triggered and POSTs to the rollup cron
 * endpoint with CRON_SECRET.
 *
 * IDENTITY CLASS. revenue_protection_snapshots.agent_id FKs agents(id)
 * (scripts/schema-fk-map.ts:635). The public door of getAgentRevenueProtection
 * keeps taking the SESSION's users id — that is what app/dashboard/agent/page.tsx
 * holds — and resolves it to the agents row inside, under the cookie client so
 * RLS bounds the lookup to the caller's tenant. Filtering the snapshot table by
 * the users id (what this file did before 2026-09-03) matched nothing, ever.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { resolveActorNamesEitherClass } from "@/lib/kernel/actor-attribution"
import { revalidatePath } from "next/cache"

export interface AgentRevenueProtection {
  agentId:            string
  brokerageId:        string
  periodStart:        string
  periodEnd:          string
  snapshotType:       string
  protectedGci:       number
  atRiskDealCount:    number
  atRiskListingCount: number
  criticalGci:        number
  atRiskBySeverity:   { critical: number; at_risk: number; watch: number }
  savedGci:           number
  savesCount:         number
  avgSaveValue:       number
  noAiBaselineGci:    number
  aiLiftPct:          number
  perCategory:        Array<{ category: string; gci: number; count: number }>
  protectedGciDelta:  number | null
  savesGciDelta:      number | null
  computedAt:         string
}

export interface BrokerageRevenueProtection extends Omit<AgentRevenueProtection, "agentId"> {
  perAgent: Array<{
    agentId:      string
    agentName:    string | null
    protectedGci: number
    savedGci:     number
    savesCount:   number
  }>
}

function rowToAgentResult(row: Record<string, unknown>): AgentRevenueProtection {
  return {
    agentId:            row.agent_id as string,
    brokerageId:        row.brokerage_id as string,
    periodStart:        row.period_start as string,
    periodEnd:          row.period_end as string,
    snapshotType:       row.snapshot_type as string,
    protectedGci:       Number(row.protected_gci ?? 0),
    atRiskDealCount:    Number(row.at_risk_deal_count ?? 0),
    atRiskListingCount: Number(row.at_risk_listing_count ?? 0),
    criticalGci:        Number(row.critical_gci ?? 0),
    atRiskBySeverity:   (row.at_risk_by_severity as { critical: number; at_risk: number; watch: number }) ?? { critical: 0, at_risk: 0, watch: 0 },
    savedGci:           Number(row.saved_gci ?? 0),
    savesCount:         Number(row.saves_count ?? 0),
    avgSaveValue:       Number(row.avg_save_value ?? 0),
    noAiBaselineGci:    Number(row.no_ai_baseline_gci ?? 0),
    aiLiftPct:          Number(row.ai_lift_pct ?? 0),
    perCategory:        (row.per_category as Array<{ category: string; gci: number; count: number }>) ?? [],
    protectedGciDelta:  row.protected_gci_delta == null ? null : Number(row.protected_gci_delta),
    savesGciDelta:      row.saves_gci_delta == null ? null : Number(row.saves_gci_delta),
    computedAt:         row.computed_at as string,
  }
}

export async function getAgentRevenueProtection(params: {
  /** A USERS id (the session's user.id). Resolved to the agents row here. */
  agentId: string
}): Promise<{ success: boolean; error?: string; data?: AgentRevenueProtection | null }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent id" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // users.id → agents.id, through the cookie client: RLS on `agents` bounds
  // this to the caller's tenant, so a users id from another brokerage resolves
  // to nothing rather than to a row. The error is read — a refused lookup is
  // not "this user has no agent record".
  const { data: agentRow, error: agentError } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", params.agentId)
    .maybeSingle()
  if (agentError) return { success: false, error: agentError.message }
  // No agents row → no per-agent snapshot can exist (the scorer refuses to
  // write one). `data: null` is the honest "no snapshot yet" the hero renders.
  if (!agentRow?.id) return { success: true, data: null }

  const { data, error } = await supabase
    .from("revenue_protection_snapshots")
    .select("*")
    .eq("agent_id", agentRow.id as string)
    .eq("snapshot_type", "quarterly")
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  return { success: true, data: data ? rowToAgentResult(data) : null }
}

export async function getBrokerageRevenueProtection(params: {
  brokerageId: string
}): Promise<{ success: boolean; error?: string; data?: BrokerageRevenueProtection | null }> {
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage id" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Brokerage-wide snapshot (agent_id IS NULL). A refused read is an error,
  // not "no rollup yet" — the widget would otherwise render the empty state
  // over a refusal forever.
  const { data: brokerageRow, error: brokerageError } = await supabase
    .from("revenue_protection_snapshots")
    .select("*")
    .eq("brokerage_id", params.brokerageId)
    .eq("snapshot_type", "quarterly")
    .is("agent_id", null)
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (brokerageError) return { success: false, error: brokerageError.message }

  if (!brokerageRow) return { success: true, data: null }

  // Per-agent snapshots from the same period
  const { data: perAgentRows, error: perAgentError } = await supabase
    .from("revenue_protection_snapshots")
    .select("agent_id, protected_gci, saved_gci, saves_count")
    .eq("brokerage_id", params.brokerageId)
    .eq("snapshot_type", "quarterly")
    .eq("period_end", brokerageRow.period_end)
    .not("agent_id", "is", null)
    .order("protected_gci", { ascending: false })
    .limit(20)
  if (perAgentError) return { success: false, error: perAgentError.message }

  // Hydrate agent names. `agent_id` here is an AGENTS id (the snapshot table
  // FKs agents), so a name is two hops away: agents.id → agents.user_id →
  // users. This used to query `users .in("id", agentIds)` directly — the
  // users-class assumption — and could never have named anyone. The survivor
  // for the two-hop shape is lib/kernel/actor-attribution.ts; a refused hop
  // yields an EMPTY map plus the reason, never a partial one, and the render
  // fallback (null → the widget's own "unnamed" state) stays here.
  const agentIds = ((perAgentRows ?? []) as Array<{ agent_id: string }>).map((r) => r.agent_id)
  const { names: nameMap, error: nameError } = await resolveActorNamesEitherClass(
    supabase,
    agentIds,
    { brokerageId: params.brokerageId },
  )
  if (nameError) {
    console.error(`[revenue-protection] per-agent name hydration refused for brokerage ${params.brokerageId}:`, nameError)
  }

  const base = rowToAgentResult(brokerageRow)
  const result: BrokerageRevenueProtection = {
    brokerageId:        base.brokerageId,
    periodStart:        base.periodStart,
    periodEnd:          base.periodEnd,
    snapshotType:       base.snapshotType,
    protectedGci:       base.protectedGci,
    atRiskDealCount:    base.atRiskDealCount,
    atRiskListingCount: base.atRiskListingCount,
    criticalGci:        base.criticalGci,
    atRiskBySeverity:   base.atRiskBySeverity,
    savedGci:           base.savedGci,
    savesCount:         base.savesCount,
    avgSaveValue:       base.avgSaveValue,
    noAiBaselineGci:    base.noAiBaselineGci,
    aiLiftPct:          base.aiLiftPct,
    perCategory:        base.perCategory,
    protectedGciDelta:  base.protectedGciDelta,
    savesGciDelta:      base.savesGciDelta,
    computedAt:         base.computedAt,
    perAgent: ((perAgentRows ?? []) as Array<{ agent_id: string; protected_gci: number; saved_gci: number; saves_count: number }>).map((r) => ({
      agentId:      r.agent_id,
      agentName:    nameMap.get(r.agent_id) ?? null,
      protectedGci: Number(r.protected_gci ?? 0),
      savedGci:     Number(r.saved_gci ?? 0),
      savesCount:   Number(r.saves_count ?? 0),
    })),
  }
  return { success: true, data: result }
}

/**
 * Trigger an on-demand rescan. The agent dashboard "Refresh" button uses
 * this. Calls the rollup endpoint server-to-server with CRON_SECRET.
 */
export async function rescanRevenueProtectionAction(params: {
  brokerageId: string
  agentId?:    string | null
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage id" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const secret = process.env.CRON_SECRET
  if (!secret) return { success: false, error: "CRON_SECRET not configured" }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  const url = base
    ? `${base.startsWith("http") ? base : `https://${base}`}/api/cron/revenue-protection-rollup`
    : "/api/cron/revenue-protection-rollup"

  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body:    JSON.stringify({
        brokerage_id:  params.brokerageId,
        agent_id:      params.agentId ?? null,
        snapshot_type: "quarterly",
      }),
      cache: "no-store",
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) return { success: false, error: data?.error ?? `Rescan returned ${r.status}` }
    revalidatePath("/dashboard/agent")
    revalidatePath("/dashboard/admin")
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Rescan failed" }
  }
}
