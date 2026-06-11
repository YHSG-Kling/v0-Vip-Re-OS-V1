// lib/kernel/morning-standup.ts
//
// "HEY TEAM, WHAT SHOULD I DO TODAY?" — the morning stand-up. The bullpen question's
// counterpart: instead of asking about one person, the agent asks the room what matters
// RIGHT NOW, and the managers rank the day for them. A great team lead doesn't hand you
// forty open tabs — they tell you the three things that move the needle, in order:
//
//   1. FIRES (Deal Coordinator) — any fire drill in the last 24h: an uncovered deadline
//      is the most expensive thing you can ignore, so it leads the day, always.
//   2. APPROVALS AGING (Campaign Orchestrator) — client messages the team drafted and
//      that are waiting on you, oldest first; anything past the 4h SLA is "overdue" and
//      outranks fresh drafts (the client is waiting on the other side of these).
//   3. RE-ENGAGE (AI ISA) — the single highest-propensity contact who's gone cold
//      (no touch in 14+ days): the warmest relationship you're about to let cool.
//
// One spoken, ranked answer — manager-attributed, honest when the day is clear. Every
// number from a real table; nothing fabricated. READ-ONLY (the stand-up reports; acting
// is the existing voice-delegation verbs). NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** A draft is "overdue" once it's been waiting on the human longer than this. */
export const APPROVAL_SLA_HOURS = 4

export interface StandupItem {
  rank: number
  manager: ManagerKey
  /** The spoken line for this move. */
  line: string
  /** Machine tag for the UI / follow-on voice verbs. */
  kind: "fire" | "approval" | "reengage"
  entityId: string | null
}

export interface StandupInputs {
  fireDrills: Array<{ entityId: string; title: string }>
  approvals: Array<{ id: string; subject: string | null; hoursWaiting: number }>
  reengage: { contactId: string; name: string; reasons: string[]; daysCold: number } | null
}

/** Pure: rank the day. Fires first (most expensive to ignore), then aging approvals
 *  (overdue before fresh), then the warmest cooling relationship. ≤3 spoken moves. */
export function rankStandup(inputs: StandupInputs): StandupItem[] {
  const items: StandupItem[] = []
  let rank = 1

  for (const f of inputs.fireDrills.slice(0, 2)) {
    items.push({ rank: rank++, manager: "deal_coordinator", kind: "fire", entityId: f.entityId,
      line: `a fire drill is open — ${f.title}. Clear the save plan in your notifications first.` })
  }
  const overdue = inputs.approvals.filter((a) => a.hoursWaiting >= APPROVAL_SLA_HOURS)
  const fresh = inputs.approvals.filter((a) => a.hoursWaiting < APPROVAL_SLA_HOURS)
  const topApproval = overdue[0] ?? fresh[0]
  if (topApproval) {
    const total = inputs.approvals.length
    const od = overdue.length
    items.push({ rank: rank++, manager: "campaign_orchestrator", kind: "approval", entityId: topApproval.id,
      line: `${total} message${total === 1 ? "" : "s"} wait on your approval${od > 0 ? `, ${od} past the ${APPROVAL_SLA_HOURS}-hour mark` : ""} — start with "${topApproval.subject ?? "the oldest"}" (${Math.round(topApproval.hoursWaiting)}h waiting).` })
  }
  if (inputs.reengage && items.length < 3) {
    const r = inputs.reengage
    items.push({ rank: rank++, manager: "ai_isa", kind: "reengage", entityId: r.contactId,
      line: `${r.name} is your warmest cooling lead — ${r.daysCold} days quiet${r.reasons.length ? `, still reading hot (${r.reasons.slice(0, 2).join(", ")})` : ""}. Worth a touch today.` })
  }
  return items.slice(0, 3)
}

/** Pure: assemble the spoken stand-up — ranked, manager-attributed, honest when clear. */
export function composeStandup(firstName: string | null, items: StandupItem[]): string {
  const hi = `${firstName ? `${firstName}, here` : "Here"}'s your day from the team`
  if (items.length === 0) {
    return `${hi}: nothing on fire, your approval queue is clear, and no warm leads are going cold. Go list something.`
  }
  const body = items.map((i) => `${i.rank}. ${MANAGERS[i.manager].label}: ${i.line}`).join(" ")
  return `${hi}, top ${items.length === 1 ? "priority" : `${items.length} priorities`}. ${body}`
}

export interface StandupResult {
  spoken: string
  items: StandupItem[]
}

/**
 * Build the morning stand-up for one agent. Every fact from a real table; managers with
 * nothing to flag stay silent. Read-only — the stand-up reports.
 */
export async function runMorningStandup(
  brokerageId: string,
  agentUserId: string,
  opts: { now?: Date; firstName?: string | null } = {},
  client?: Svc,
): Promise<StandupResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()

  // 1) Fires — the agent's fire drills in the last 24h.
  const { data: fires } = await supabase.from("notifications")
    .select("entity_id, title")
    .eq("user_id", agentUserId).eq("type", "fire_drill")
    .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString())
    .order("created_at", { ascending: false }).limit(2)

  // The agent's own contacts (agent_id = users.id on the live schema).
  const { data: myContacts } = await supabase.from("contacts")
    .select("id, first_name, last_name, intent_score, engagement_score, last_contacted_at, nurture_status")
    .eq("brokerage_id", brokerageId).eq("agent_id", agentUserId).limit(1000)
  const contactRows = ((myContacts ?? []) as any[]).filter((c) => c.nurture_status !== "withdrawn")
  const myIds = new Set(contactRows.map((c) => c.id))

  // 2) Approvals aging — proposed client messages to THIS agent's contacts, oldest first.
  const { data: proposals } = await supabase.from("agent_client_messages")
    .select("id, subject, proposed_at, recipient_contact_id")
    .eq("brokerage_id", brokerageId).eq("status", "proposed")
    .not("proposed_at", "is", null).order("proposed_at", { ascending: true }).limit(200)
  const approvals = ((proposals ?? []) as any[])
    .filter((p) => p.recipient_contact_id && myIds.has(p.recipient_contact_id))
    .map((p) => ({ id: p.id, subject: p.subject, hoursWaiting: (now.getTime() - new Date(p.proposed_at).getTime()) / 3_600_000 }))

  // 3) Re-engage — the single warmest contact gone cold (14+ days, no touch).
  const { computeTransactionPropensity } = await import("@/lib/ai-isa/transaction-propensity")
  const daysSince = (iso: string | null) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000) : null)
  let best: { contactId: string; name: string; reasons: string[]; daysCold: number; score: number } | null = null
  for (const c of contactRows) {
    const cold = daysSince(c.last_contacted_at)
    if (cold === null || cold < 14) continue
    const prop = computeTransactionPropensity({
      intentScore: c.intent_score, engagementScore: c.engagement_score,
      equityEstimate: null, referralScore: null, lifeEventDaysAgo: null, lastActivityDaysAgo: cold,
    })
    if (!best || prop.score > best.score) {
      best = {
        contactId: c.id, score: prop.score, daysCold: cold,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "a past contact",
        reasons: prop.topReasons,
      }
    }
  }

  const items = rankStandup({
    fireDrills: ((fires ?? []) as any[]).filter((f) => f.entity_id).map((f) => ({ entityId: f.entity_id, title: f.title ?? "an uncovered deadline" })),
    approvals,
    reengage: best ? { contactId: best.contactId, name: best.name, reasons: best.reasons, daysCold: best.daysCold } : null,
  })
  return { spoken: composeStandup(opts.firstName ?? null, items), items }
}
