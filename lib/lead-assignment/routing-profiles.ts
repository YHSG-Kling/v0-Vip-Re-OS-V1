// lib/lead-assignment/routing-profiles.ts
// ─────────────────────────────────────────────────────────────────────────────
// The agent facts the EXPERTISE and GEOGRAPHIC assignment methods route on.
//
// Both were `pool[0]` until the assignment methods were made real, so neither
// had ever needed data. They do now, and it already exists:
//
//   agents.specializations   the expertise tags an agent sets on their profile
//   farm_territories         the ZIP farms a brokerage assigns to an agent
//                            (agent_id, zip_codes[], is_active) — the real farm
//                            table, not a column invented for routing
//
// One loader, used by Engine 2 and by the contact resolver, so the two cannot
// come to different conclusions about the same agent.

import type { createServiceClient } from "@/lib/supabase/service"
import { toRoutingProfiles, ROUTING_PROFILE_COLUMNS, type AgentProfileForRouting } from "./rule-matcher"

export async function loadRoutingProfiles(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  pool: string[],
): Promise<Record<string, AgentProfileForRouting>> {
  if (pool.length === 0) return {}

  const [agentsRes, farmsRes] = await Promise.all([
    supabase
      .from("agents")
      .select(ROUTING_PROFILE_COLUMNS)
      .eq("brokerage_id", brokerageId)
      .in("id", pool),
    supabase
      .from("farm_territories")
      .select("agent_id, zip_codes")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .in("agent_id", pool),
  ])

  // An agent can farm more than one territory; the ZIPs union.
  const zipsByAgent = new Map<string, string[]>()
  for (const f of (farmsRes.data ?? []) as Array<{ agent_id: string | null; zip_codes: string[] | null }>) {
    if (!f.agent_id) continue
    const existing = zipsByAgent.get(f.agent_id) ?? []
    zipsByAgent.set(f.agent_id, [...existing, ...(f.zip_codes ?? [])])
  }

  return toRoutingProfiles(
    ((agentsRes.data ?? []) as Array<{ id: string; specializations?: string[] | null; location_id?: string | null }>)
      .map((a) => ({ ...a, zip_codes: zipsByAgent.get(a.id) ?? null })),
  )
}
