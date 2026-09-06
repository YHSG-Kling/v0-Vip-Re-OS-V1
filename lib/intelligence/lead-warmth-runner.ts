// lib/intelligence/lead-warmth-runner.ts
//
// Live side of LEAD WARMTH — score and rank the brokerage's (or AI-ISA's) leads coldest-first, so
// the team works the lead about to go cold before it dies. Read-only; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { scoreLeadWarmth, type LeadWarmth } from "./lead-warmth"
import { NOT_CONVERTED_FILTER } from "@/lib/lead-pipeline/lead-lifecycle"

type Svc = ReturnType<typeof createServiceClient>
const DAY = 86_400_000

export interface RankedLead extends LeadWarmth { leadId: string }

export async function getWarmthPrioritizedLeads(
  svc: Svc, brokerageId: string, opts?: { limit?: number; agentId?: string; now?: string },
): Promise<RankedLead[]> {
  const nowMs = new Date(opts?.now ?? new Date().toISOString()).getTime()
  let q = svc.from("leads")
    .select("id, last_contacted_at, last_enriched_at, lead_temperature")
    .eq("brokerage_id", brokerageId)
    .or(NOT_CONVERTED_FILTER)
    .not("status", "in", '("archived","inactive","dead")')
    .limit(opts?.limit ?? 300)
  if (opts?.agentId) q = q.eq("agent_id", opts.agentId)
  const { data: leads } = await q

  const daysSince = (iso: string | null | undefined): number | null => {
    if (!iso) return null
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? Math.floor((nowMs - t) / DAY) : null
  }

  return ((leads ?? []) as any[])
    .map((l) => ({
      leadId: l.id as string,
      ...scoreLeadWarmth({
        daysSinceLastTouch: daysSince(l.last_contacted_at),
        enrichmentAgeDays: daysSince(l.last_enriched_at),
        leadTemperature: l.lead_temperature ?? null,
      }),
    }))
    .sort((a, b) => (b.priority - a.priority) || (a.score - b.score))
}
