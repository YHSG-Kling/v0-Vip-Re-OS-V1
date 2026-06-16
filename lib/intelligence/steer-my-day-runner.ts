// lib/intelligence/steer-my-day-runner.ts
//
// Loader for STEER MY DAY — fuses the agent's health-ranked work list and dry-run cockpit into one
// digest, scoped to the agent's OWN contacts (never broker oversight). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getHealthPrioritizedContacts } from "./health-prioritizer-runner"
import { getPlannedDay } from "./dry-run-cockpit-runner"
import { assembleSteerMyDay, type SteerMyDay } from "./steer-my-day"

type Svc = ReturnType<typeof createServiceClient>

export async function getSteerMyDay(
  svc: Svc, brokerageId: string, opts?: { agentId?: string; topN?: number },
): Promise<SteerMyDay> {
  const [healthRanked, plannedDay] = await Promise.all([
    getHealthPrioritizedContacts(svc, brokerageId, { agentId: opts?.agentId, limit: 300 }),
    getPlannedDay(svc, brokerageId, 24),
  ])
  return assembleSteerMyDay({ healthRanked, plannedDay, topN: opts?.topN })
}
