// lib/kernel/standup-action.ts
//
// "TEAM, KNOCK OUT NUMBER TWO" — the stand-up becomes one-breath delegation. The morning
// stand-up ranks the day's top 3 moves; this lets the agent ACT on one by its rank, out
// loud, without opening the app. The stand-up is stateless (re-derived from live tables),
// so "number two" re-runs the ranking and acts on whatever is #2 right now — never a
// stale snapshot.
//
// Each kind routes to the rail it belongs on, never around it:
//   · approval  → approveClientMessage AS the speaking agent (the SAME gate; consent is
//                 re-checked at approval, full proposed→approved(by human)→sent audit)
//   · reengage  → voiceFollowUp (propose→approve as the agent; the warm touch goes out)
//   · fire      → NOT auto-actioned — a save plan is human judgment; the verb points the
//                 agent at the briefing rather than faking a resolution.
//
// NOT server-only (simulator-driven); pure ordinal parser exported for the harness.

import { createServiceClient } from "@/lib/supabase/service"
import type { StandupItem } from "@/lib/kernel/morning-standup"

type Svc = ReturnType<typeof createServiceClient>

const WORD_ORDINALS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3,
}

/** Pure: parse a spoken ordinal — "number two", "the second one", "#2", "do 1", "first". */
export function parseOrdinal(text: string): number | null {
  const t = text.toLowerCase()
  const digit = t.match(/(?:number|item|#|no\.?|task)\s*([1-3])\b/) ?? t.match(/\b([1-3])\b/)
  if (digit) return Number(digit[1])
  for (const [word, n] of Object.entries(WORD_ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n
  }
  return null
}

export interface StandupActionResult {
  ok: boolean
  spoken: string
  actedKind?: StandupItem["kind"]
  entityId?: string | null
}

/** Act on ONE already-ranked stand-up item by routing to its rail. */
export async function actOnStandupItem(
  input: { brokerageId: string; agentUserId: string; item: StandupItem },
  client?: Svc,
): Promise<StandupActionResult> {
  const { item } = input

  // fire — the save plan is human judgment; never auto-resolve a deal-threatening item.
  // Resolved FIRST so a fire item needs no DB client at all.
  if (item.kind === "fire") {
    return {
      ok: false, actedKind: "fire", entityId: item.entityId,
      spoken: `That one's a fire drill — I won't auto-resolve a deal-threatening deadline. Your save plan is in notifications; want me to draft the client a calming note while you work it?`,
    }
  }

  const supabase = client ?? createServiceClient()

  if (item.kind === "approval") {
    if (!item.entityId) return { ok: false, spoken: "That approval isn't there anymore — it may already be handled." }
    const { approveClientMessage } = await import("@/lib/agents/agent-client-messages")
    const r = await approveClientMessage(item.entityId, input.agentUserId, undefined, supabase)
    if (r.status === "skipped") {
      return { ok: false, actedKind: "approval", entityId: item.entityId, spoken: "That message wasn't in an approvable state — it may have just gone out or been rejected." }
    }
    return { ok: true, actedKind: "approval", entityId: item.entityId, spoken: `Approved and sent — that one's off your plate. ${item.line.replace(/^.*?— /, "")}`.trim() }
  }

  // reengage — the warm touch goes out through the same propose→approve gate.
  if (!item.entityId) return { ok: false, spoken: "I couldn't find that contact anymore." }
  const { voiceFollowUp } = await import("@/lib/kernel/voice-delegation")
  const r = await voiceFollowUp({ brokerageId: input.brokerageId, agentUserId: input.agentUserId, contactId: item.entityId }, supabase)
  return { ok: r.ok, actedKind: "reengage", entityId: item.entityId, spoken: r.spoken }
}

/**
 * "Do number N" — re-derive the stand-up (live, never stale) and act on item N.
 * Out-of-range or empty days answer honestly.
 */
export async function runStandupAction(
  input: { brokerageId: string; agentUserId: string; ordinal: number; firstName?: string | null },
  client?: Svc,
): Promise<StandupActionResult> {
  const supabase = client ?? createServiceClient()
  const { runMorningStandup } = await import("@/lib/kernel/morning-standup")
  const { items } = await runMorningStandup(input.brokerageId, input.agentUserId, { firstName: input.firstName }, supabase)
  if (items.length === 0) {
    return { ok: false, spoken: "Your day is clear — there's nothing in the stand-up to knock out. Go list something." }
  }
  const item = items.find((i) => i.rank === input.ordinal)
  if (!item) {
    return { ok: false, spoken: `There's no number ${input.ordinal} today — you have ${items.length} priorit${items.length === 1 ? "y" : "ies"}. Want me to run the stand-up again?` }
  }
  return actOnStandupItem({ brokerageId: input.brokerageId, agentUserId: input.agentUserId, item }, supabase)
}
