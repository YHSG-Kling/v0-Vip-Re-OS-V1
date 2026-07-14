// lib/intelligence/time-to-value-radar.ts
//
// TIME-TO-VALUE RADAR (shine #8 — genuinely unbuilt) — the ADOPTION story the
// ROI ledger doesn't tell. ROI = dollars the AI earned (the broker's renewal
// case); this = HOURS the AI SAVED each agent (the agent's "why I keep using
// it" case). Different audience, different unit, no drift.
//
// HONEST by construction: hours are COUNTED work-units × CONSERVATIVE, stated
// per-unit minute constants (documented below, deliberately low so we never
// oversell); every number traces to a real ledger row in the window, and the
// methodology is shown, not hidden. Benchmarked against the studied ~6.4
// hrs/week median AI productivity gain so an agent sees where they stand. A
// zero-activity agent gets an honest zero (with the nudge), never a fabricated
// number.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const RADAR_WINDOW_DAYS = 30
/** ~6.4 hrs/week industry median → the 30-day benchmark to compare against. */
export const BENCHMARK_HOURS_30D = 27

// CONSERVATIVE per-unit minute constants (intentionally low — undersell, never over).
export const MINUTES_PER = {
  draft_sent: 8,        // an AI reply/message the agent sent instead of writing
  call_answered: 6,     // an inbound call the AI handled (no callback, no notes)
  task_autocreated: 3,  // a follow-up/task the OS created so the agent didn't plan it
  doc_extracted: 12,    // a document the OS parsed + filed instead of manual entry
} as const

export interface TimeSavedCounts {
  draftsSent: number
  callsAnswered: number
  tasksAutocreated: number
  docsExtracted: number
}

export interface TimeToValueRead {
  windowDays: number
  counts: TimeSavedCounts
  minutesSaved: number
  hoursSaved: number
  benchmarkHours: number
  /** vs the studied median: 'ahead' | 'on_track' | 'behind' (behind = an adoption nudge, not a scold). */
  standing: "ahead" | "on_track" | "behind"
  methodology: string
}

/** PURE: fold counted work-units into hours saved with the stated constants. */
export function computeTimeToValue(counts: TimeSavedCounts, windowDays = RADAR_WINDOW_DAYS): TimeToValueRead {
  const minutesSaved =
    counts.draftsSent * MINUTES_PER.draft_sent +
    counts.callsAnswered * MINUTES_PER.call_answered +
    counts.tasksAutocreated * MINUTES_PER.task_autocreated +
    counts.docsExtracted * MINUTES_PER.doc_extracted
  const hoursSaved = Math.round((minutesSaved / 60) * 10) / 10
  const benchmark = Math.round((BENCHMARK_HOURS_30D / 30) * windowDays)
  const standing: TimeToValueRead["standing"] =
    hoursSaved >= benchmark * 1.1 ? "ahead" : hoursSaved >= benchmark * 0.6 ? "on_track" : "behind"
  return {
    windowDays,
    counts,
    minutesSaved,
    hoursSaved,
    benchmarkHours: benchmark,
    standing,
    methodology: `Counted from your own activity: ${counts.draftsSent} sent AI drafts (${MINUTES_PER.draft_sent}m each), ${counts.callsAnswered} calls answered (${MINUTES_PER.call_answered}m), ${counts.tasksAutocreated} tasks the OS created (${MINUTES_PER.task_autocreated}m), ${counts.docsExtracted} documents auto-filed (${MINUTES_PER.doc_extracted}m). Conservative estimates, every unit a real ledger row.`,
  }
}

/** PURE: the one agent-facing line (charter tone — substance, encouraging, never scary). */
export function composeTimeToValueLine(r: TimeToValueRead): string {
  if (r.hoursSaved <= 0) {
    return `Your AI team hasn't saved you measurable time yet this month — the fastest win is approving a few of its drafted messages from the queue; each one it sends is time back in your day.`
  }
  const vs = r.standing === "ahead"
    ? `That's ahead of the typical ${r.benchmarkHours} hours — you're working the AI team hard.`
    : r.standing === "on_track"
    ? `Right around the typical ${r.benchmarkHours} hours other agents are saving.`
    : `Below the ${r.benchmarkHours} hours most agents save — there's more the AI team can take off your plate; approving more from the queue is the fastest lever.`
  return `Your AI team saved you about ${r.hoursSaved} hours in the last ${r.windowDays} days. ${vs}`
}

/** Load one agent's time-saved counts from the live ledgers. */
export async function loadTimeToValue(svc: Svc, brokerageId: string, agentUserId: string, agentsId: string | null, now: Date = new Date()): Promise<TimeToValueRead> {
  const since = new Date(now.getTime() - RADAR_WINDOW_DAYS * 86_400_000).toISOString()
  const cnt = async (q: any) => ((await q) as any)?.count ?? 0
  // Column-map is live-schema exact: ai_message_drafts keys on agent_user_id (users.id);
  // voice_calls + tasks key on the AGENTS id; doc extractions are brokerage-scoped
  // (parsed docs help the agent working the deal — counted at the tenant level, only
  // when the agent has a resolvable agents row so a solo agent still sees their share).
  const [drafts, calls, tasks, docs] = await Promise.all([
    cnt(svc.from("ai_message_drafts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_user_id", agentUserId).in("status", ["accepted", "sent", "edited"]).gte("created_at", since)),
    agentsId
      ? cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("agent_id", agentsId).eq("direction", "inbound").gte("started_at", since))
      : Promise.resolve(0),
    agentsId
      ? cnt(svc.from("tasks").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("assigned_to_agent_id", agentsId).not("source", "is", null).gte("created_at", since))
      : Promise.resolve(0),
    cnt(svc.from("document_field_extractions").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).gte("created_at", since)),
  ])
  return computeTimeToValue({ draftsSent: drafts, callsAnswered: calls, tasksAutocreated: tasks, docsExtracted: docs })
}
