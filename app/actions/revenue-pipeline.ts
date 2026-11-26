"use server"

/**
 * app/actions/revenue-pipeline.ts
 *
 * Revenue pipeline projection — 30 / 60 / 90 day GCI forecast for the
 * brokerage (and per agent), weighted by deal stage probability and
 * estimated close date. Rendered on the broker dashboard
 * (/dashboard/financials/pipeline).
 *
 * Thin DB wrapper: reads the existing `transactions` rows and delegates the
 * weighting/windowing to the PURE projectPipeline() in
 * lib/financials/revenue-projection.ts (no new tables — a derived view).
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { projectPipeline, type ProjectionWindow, type PerAgentProjection } from "@/lib/financials/revenue-projection"

export interface RevenuePipelineProjection {
  asOf: string
  brokerageId: string
  windows: ProjectionWindow[]
  perAgent: PerAgentProjection[]
}

export async function getRevenuePipelineProjectionAction(input?: {
  agentId?: string // optionally scope to one agent
}): Promise<{ success: true; projection: RevenuePipelineProjection } | { success: false; error: string }> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  // transactions live schema: `stage`, `commission_amount` (negotiated GCI),
  // `estimated_commission` (intake forecast), `commission_percentage` (rate).
  // `agents` has NO first_name / last_name (verified against
  // information_schema) — a person's name lives on `users`, reached through
  // agents_user_id_fkey, the only agents→users FK, so an OBJECT embed. Naming
  // them here made PostgREST reject the ENTIRE query, so the pipeline forecast
  // on /dashboard/financials/pipeline returned an error for every read.
  let q = supabase
    .from("transactions")
    .select(
      `id, agent_id, stage, status, close_date, contract_date,
       purchase_price, commission_amount, estimated_commission, commission_percentage,
       agent:agent_id (id, users:user_id (first_name, last_name))`,
    )
    .eq("brokerage_id", auth.brokerageId)
    .not("status", "in", "(closed,cancelled,failed,withdrawn,expired)")

  if (input?.agentId) q = q.eq("agent_id", input.agentId)

  const { data: transactions, error } = await q
  if (error) return { success: false, error: error.message }

  // Flattened to the PipelineTxn shape projectPipeline already declares
  // (lib/financials/revenue-projection.ts:36 — agent?: {id, first_name,
  // last_name}), so the pure projector is untouched.
  const rows = (transactions ?? []).map((t: any) => {
    const a = t?.agent ?? null
    const u = a?.users ?? null
    return {
      ...t,
      agent: a
        ? { id: a.id, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null }
        : null,
    }
  })

  const now = new Date()
  const { windows, perAgent } = projectPipeline(rows as never[], now)

  return {
    success: true,
    projection: { asOf: now.toISOString(), brokerageId: auth.brokerageId, windows, perAgent },
  }
}
