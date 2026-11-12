// app/actions/ai-isa/speed-to-lead-metrics.ts
//
// Real-data metrics for the Speed-to-Lead KPI strip on the AI-ISA console.
// Reads the m228 first_touched_at / first_touch_channel truth on leads + contacts:
//   · how many leads/contacts are AWAITING their first touch right now,
//   · median time-to-first-touch + the share that met the under-5-min SLA,
//     overall AND per channel (lane 90C — 89D P2-8's "per lead per channel"),
//   · channel breakdown of recent first touches,
// and (lane 90C) the three PROOF NUMBERS competitors publish and this OS only
// recorded — response rate (isa_outreach_log), connect rate (voice_calls) and
// days of follow-up (isa_outreach_log span per lead) — over a 30-day window.
// All brokerage-scoped, real rows, no fabrication. Pure math lives in the policy
// module. EVERY read destructures `error` (CLAUDE.md §3): a refused ledger is
// reported in `refused` and rendered as such, never as a clean zero.

"use server"

import { createClient } from "@/lib/supabase/server"
import {
  summarizeFirstTouchLatency,
  summarizeIsaProofNumbers,
  type FirstTouchLatencySummary,
  type IsaProofNumbers,
} from "@/lib/ai-isa/speed-to-lead-policy"

export interface SpeedToLeadMetrics {
  awaitingLeads: number
  awaitingContacts: number
  recent: FirstTouchLatencySummary
  /** ISO timestamp of the lookback window start. */
  since: string
  /** Lane 90C — the published proof numbers (30-day window). */
  proof: IsaProofNumbers
  proofSince: string
  /** Lane 90C — ledger reads that were REFUSED (message per read); the panel says so. */
  refused: string[]
}

const LOOKBACK_DAYS = 7
/** The proof numbers use the same 30-day window getQualificationOutcomes uses. */
const PROOF_LOOKBACK_DAYS = 30

export async function getSpeedToLeadMetrics(brokerageId: string): Promise<SpeedToLeadMetrics> {
  const supabase = await createClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const proofSince = new Date(Date.now() - PROOF_LOOKBACK_DAYS * 86_400_000).toISOString()
  const refused: string[] = []

  const [awaitLeads, awaitContacts, touchedLeads, touchedContacts, outreach, calls] = await Promise.all([
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
    // The ISA's own send/reply ledger — response rate + days of follow-up.
    supabase
      .from("isa_outreach_log")
      .select("lead_id, contact_id, channel, sent_at, replied_at, status")
      .eq("brokerage_id", brokerageId)
      .gte("sent_at", proofSince)
      .limit(5000),
    // The ISA's outbound dials — connect rate.
    supabase
      .from("voice_calls")
      .select("status, direction")
      .eq("brokerage_id", brokerageId)
      .eq("call_type", "ai_isa_call")
      .eq("direction", "outbound")
      .gte("created_at", proofSince)
      .limit(5000),
  ])

  for (const [label, res] of [
    ["leads awaiting first touch", awaitLeads],
    ["contacts awaiting first touch", awaitContacts],
    ["leads first-touched", touchedLeads],
    ["contacts first-touched", touchedContacts],
    ["isa_outreach_log", outreach],
    ["voice_calls", calls],
  ] as const) {
    if (res.error) refused.push(`${label}: ${res.error.message}`)
  }

  const rows = [...(touchedLeads.data ?? []), ...(touchedContacts.data ?? [])].map((r: any) => ({
    createdAt: r.created_at,
    firstTouchedAt: r.first_touched_at,
    channel: r.first_touch_channel,
  }))

  const proof = summarizeIsaProofNumbers({
    outreach: ((outreach.data ?? []) as any[]).map((r) => ({
      leadId: r.lead_id ?? null,
      contactId: r.contact_id ?? null,
      channel: r.channel ?? null,
      sentAt: r.sent_at ?? null,
      repliedAt: r.replied_at ?? null,
      status: r.status ?? null,
    })),
    calls: ((calls.data ?? []) as any[]).map((c) => ({ status: c.status ?? null, direction: c.direction ?? null })),
  })

  return {
    awaitingLeads: awaitLeads.count ?? 0,
    awaitingContacts: awaitContacts.count ?? 0,
    recent: summarizeFirstTouchLatency(rows),
    since,
    proof,
    proofSince,
    refused,
  }
}
