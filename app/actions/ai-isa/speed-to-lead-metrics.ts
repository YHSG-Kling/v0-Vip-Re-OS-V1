// app/actions/ai-isa/speed-to-lead-metrics.ts
//
// Real-data metrics for the Speed-to-Lead KPI strip on the AI-ISA console.
// Reads the m228 first_touched_at / first_touch_channel truth on leads + contacts:
//   · how many leads/contacts are AWAITING their first touch right now,
//   · median time-to-first-touch + the share that met the under-5-min SLA,
//   · channel breakdown of recent first touches.
// All brokerage-scoped, real rows, no fabrication. Pure math lives in the policy module.

"use server"

import { createClient } from "@/lib/supabase/server"
import {
  summarizeFirstTouchLatency,
  type FirstTouchLatencySummary,
} from "@/lib/ai-isa/speed-to-lead-policy"

export interface SpeedToLeadMetrics {
  awaitingLeads: number
  awaitingContacts: number
  recent: FirstTouchLatencySummary
  /** ISO timestamp of the lookback window start. */
  since: string
}

const LOOKBACK_DAYS = 7

export async function getSpeedToLeadMetrics(brokerageId: string): Promise<SpeedToLeadMetrics> {
  const supabase = await createClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  const [awaitLeads, awaitContacts, touchedLeads, touchedContacts] = await Promise.all([
    // Leads owned by the ISA that have not yet been first-touched.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("ai_isa_owner", true)
      .is("first_touched_at", null),
    // Assigned contacts the agent hasn't reached and the ISA hasn't first-touched.
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .not("agent_id", "is", null)
      .is("first_touched_at", null)
      .is("last_contacted_at", null),
    // Recently first-touched leads (for latency + channel mix).
    supabase
      .from("leads")
      .select("created_at, first_touched_at, first_touch_channel")
      .eq("brokerage_id", brokerageId)
      .not("first_touched_at", "is", null)
      .gte("first_touched_at", since)
      .limit(500),
    supabase
      .from("contacts")
      .select("created_at, first_touched_at, first_touch_channel")
      .eq("brokerage_id", brokerageId)
      .not("first_touched_at", "is", null)
      .gte("first_touched_at", since)
      .limit(500),
  ])

  const rows = [...(touchedLeads.data ?? []), ...(touchedContacts.data ?? [])].map((r: any) => ({
    createdAt: r.created_at,
    firstTouchedAt: r.first_touched_at,
    channel: r.first_touch_channel,
  }))

  return {
    awaitingLeads: awaitLeads.count ?? 0,
    awaitingContacts: awaitContacts.count ?? 0,
    recent: summarizeFirstTouchLatency(rows),
    since,
  }
}
