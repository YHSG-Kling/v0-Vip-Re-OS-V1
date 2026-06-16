// lib/intelligence/steer-my-day-runner.ts
//
// Loader for STEER MY DAY — fuses the agent's lead-warmth + lifetime-health work lists and the
// dry-run cockpit into one digest across the WHOLE funnel, scoped to the agent's OWN leads/contacts
// (never broker oversight). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getHealthPrioritizedContacts } from "./health-prioritizer-runner"
import { getWarmthPrioritizedLeads } from "./lead-warmth-runner"
import { getPlannedDay } from "./dry-run-cockpit-runner"
import { assembleSteerMyDay, type SteerMyDay } from "./steer-my-day"

type Svc = ReturnType<typeof createServiceClient>

export async function getSteerMyDay(
  svc: Svc, brokerageId: string, opts?: { agentId?: string; topN?: number },
): Promise<SteerMyDay> {
  const [healthRanked, leadRanked, plannedDay] = await Promise.all([
    getHealthPrioritizedContacts(svc, brokerageId, { agentId: opts?.agentId, limit: 300 }),
    getWarmthPrioritizedLeads(svc, brokerageId, { agentId: opts?.agentId, limit: 300 }),
    getPlannedDay(svc, brokerageId, 24),
  ])
  return assembleSteerMyDay({ healthRanked, leadRanked, plannedDay, topN: opts?.topN })
}
