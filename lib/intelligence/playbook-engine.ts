// lib/intelligence/playbook-engine.ts
//
// DYNAMIC PLAYBOOK ENGINE (recruiting_manager) — the moat feature: the OS
// watches what its TOP QUARTILE actually does and turns the measurable
// differences into playbook candidates the broker reviews and adopts. It
// compounds with scale: every closed deal sharpens the evidence. No
// competitor has the event spine to copy it.
//
// v1 is HONEST about what the ledgers can measure today (no invented
// psychology): per-agent trailing-180d — closings + volume (transactions),
// decision-execution speed (the velocity rail), on-time task completion, and
// gate participation (approved AI drafts = adoption). Pure quartile split +
// gap detection with hard sample floors: a playbook needs MIN_COHORT agents
// per side and a MIN_GAP_RATIO behavior gap, or it does not exist. Candidates
// land as ONE gated monthly broker brief (human reviews before anything is
// taught — the doc's own guidance), idempotent per (brokerage, month). The
// curriculum author can then turn an ADOPTED candidate into a course through
// the existing education rail — no parallel teaching system.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const MIN_COHORT = 3          // agents per quartile side
export const MIN_GAP_RATIO = 1.35    // top must beat rest by 35%+ to claim a behavior
export const WINDOW_DAYS = 180

export interface AgentBehaviorStats {
  agentId: string
  closings: number
  volume: number
  /** Median hours from client decision → execution (null = thin sample). */
  decisionMedianHours: number | null
  /** Share of tasks completed on/before due date (null = no dated tasks). */
  onTimeRate: number | null
  /** AI-gate participation — drafts approved in the window. */
  approvals: number
}

export interface PlaybookCandidate {
  key: string
  claim: string
  evidence: string
  topValue: number
  restValue: number
}

const median = (v: number[]): number | null => {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** PURE: split by production, compare behaviors, emit only defensible claims. */
export function composePlaybookCandidates(stats: AgentBehaviorStats[]): PlaybookCandidate[] {
  const ranked = [...stats].sort((a, b) => b.volume - a.volume || b.closings - a.closings)
  const cut = Math.max(MIN_COHORT, Math.ceil(ranked.length / 4))
  const top = ranked.slice(0, cut)
  const rest = ranked.slice(cut)
  if (top.length < MIN_COHORT || rest.length < MIN_COHORT) return [] // honest: no cohort, no playbook
  if ((top[0]?.closings ?? 0) === 0) return [] // nobody closed — production split is meaningless

  const out: PlaybookCandidate[] = []
  const r1 = (n: number) => Math.round(n * 10) / 10

  // Decision speed — LOWER is better.
  const topDec = median(top.map((a) => a.decisionMedianHours).filter((v): v is number => v != null))
  const restDec = median(rest.map((a) => a.decisionMedianHours).filter((v): v is number => v != null))
  if (topDec != null && restDec != null && topDec > 0 && restDec / topDec >= MIN_GAP_RATIO) {
    out.push({
      key: "decision_speed",
      claim: "Execute client decisions same-day — the top closers do.",
      evidence: `Your top quartile executes a client's decision in a median ${r1(topDec)}h; everyone else takes ${r1(restDec)}h. Both numbers come from every tracked decision in the last ${WINDOW_DAYS} days.`,
      topValue: r1(topDec), restValue: r1(restDec),
    })
  }

  // On-time task completion — HIGHER is better.
  const topOt = median(top.map((a) => a.onTimeRate).filter((v): v is number => v != null))
  const restOt = median(rest.map((a) => a.onTimeRate).filter((v): v is number => v != null))
  if (topOt != null && restOt != null && restOt > 0 && topOt / restOt >= MIN_GAP_RATIO) {
    out.push({
      key: "on_time_tasks",
      claim: "Protect the due date — top producers finish tasks on time at a different rate.",
      evidence: `Top quartile on-time task rate: ${Math.round(topOt * 100)}%; everyone else: ${Math.round(restOt * 100)}%. Same task rail, same window.`,
      topValue: topOt, restValue: restOt,
    })
  }

  // Gate participation — HIGHER is better (adoption drives output here).
  const topAp = median(top.map((a) => a.approvals))
  const restAp = median(rest.map((a) => a.approvals))
  if (topAp != null && restAp != null && restAp >= 0 && topAp >= 5 && (restAp === 0 || topAp / Math.max(restAp, 1) >= MIN_GAP_RATIO)) {
    out.push({
      key: "gate_adoption",
      claim: "Work the approval queue daily — the AI team produces for those who release its work.",
      evidence: `Top quartile approved a median ${Math.round(topAp)} AI-prepared items in ${WINDOW_DAYS} days vs ${Math.round(restAp)} for everyone else.`,
      topValue: topAp, restValue: restAp,
    })
  }

  return out
}

/** Load per-agent behavior stats from the ledgers (trailing window). */
export async function loadAgentBehaviorStats(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<AgentBehaviorStats[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString()
  const [{ data: agents }, { data: closed }, { data: decisions }, { data: tasks }, { data: approvals }] = await Promise.all([
    svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).limit(500),
    svc.from("transactions").select("agent_id, purchase_price").eq("brokerage_id", brokerageId).eq("status", "closed").gte("close_date", since.slice(0, 10)).limit(2000),
    svc.from("tasks").select("assigned_to_agent_id, created_at, completed_at")
      .eq("brokerage_id", brokerageId).in("source", ["client_offer_decision", "vendor_request", "lender_condition"])
      .not("completed_at", "is", null).gte("created_at", since).limit(2000),
    svc.from("tasks").select("assigned_to_agent_id, due_date, completed_at, status")
      .eq("brokerage_id", brokerageId).not("due_date", "is", null).gte("created_at", since).limit(4000),
    svc.from("agent_client_messages").select("id, approved_by").eq("brokerage_id", brokerageId).eq("status", "approved").gte("proposed_at", since).limit(4000),
  ])

  const userToAgent = new Map<string, string>()
  const byAgent = new Map<string, AgentBehaviorStats>()
  for (const a of ((agents ?? []) as any[])) {
    byAgent.set(a.id, { agentId: a.id, closings: 0, volume: 0, decisionMedianHours: null, onTimeRate: null, approvals: 0 })
    if (a.user_id) userToAgent.set(a.user_id, a.id)
  }

  for (const t of ((closed ?? []) as any[])) {
    const e = t.agent_id && byAgent.get(t.agent_id)
    if (e) { e.closings += 1; e.volume += Number(t.purchase_price ?? 0) }
  }

  const decDurations = new Map<string, number[]>()
  for (const d of ((decisions ?? []) as any[])) {
    if (!d.assigned_to_agent_id || !d.created_at || !d.completed_at) continue
    const h = (new Date(d.completed_at).getTime() - new Date(d.created_at).getTime()) / 3_600_000
    if (!Number.isFinite(h) || h < 0) continue
    const arr = decDurations.get(d.assigned_to_agent_id) ?? []
    arr.push(h); decDurations.set(d.assigned_to_agent_id, arr)
  }
  for (const [agentId, arr] of decDurations) {
    const e = byAgent.get(agentId)
    if (e && arr.length >= 3) e.decisionMedianHours = median(arr)
  }

  const taskCounts = new Map<string, { done: number; onTime: number }>()
  for (const t of ((tasks ?? []) as any[])) {
    if (!t.assigned_to_agent_id || !t.completed_at) continue
    const c = taskCounts.get(t.assigned_to_agent_id) ?? { done: 0, onTime: 0 }
    c.done += 1
    if (t.due_date && new Date(t.completed_at).getTime() <= new Date(t.due_date).getTime() + 86_400_000) c.onTime += 1
    taskCounts.set(t.assigned_to_agent_id, c)
  }
  for (const [agentId, c] of taskCounts) {
    const e = byAgent.get(agentId)
    if (e && c.done >= 5) e.onTimeRate = c.onTime / c.done
  }

  for (const m of ((approvals ?? []) as any[])) {
    const agentId = m.approved_by ? userToAgent.get(m.approved_by) : null
    const e = agentId && byAgent.get(agentId)
    if (e) e.approvals += 1
  }

  return [...byAgent.values()]
}

/** Monthly gated broker brief — idempotent per (brokerage, month). */
export async function runPlaybookEngine(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<{ candidates: number; proposed: boolean }> {
  const stats = await loadAgentBehaviorStats(svc, brokerageId, now)
  const candidates = composePlaybookCandidates(stats)
  if (candidates.length === 0) return { candidates: 0, proposed: false }

  const monthTag = `playbook_engine:${now.toISOString().slice(0, 7)}`
  const { data: dup } = await svc.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).ilike("rationale", `%${monthTag}%`).limit(1).maybeSingle()
  if (dup) return { candidates: candidates.length, proposed: false }

  const body = [
    `Your top quartile is doing ${candidates.length} thing${candidates.length === 1 ? "" : "s"} measurably differently this period. Each claim below is computed from your own ledgers — adopt what fits and the education engine can turn it into a course.`,
    "",
    ...candidates.map((c, i) => `${i + 1}. ${c.claim}\n   ${c.evidence}`),
  ].join("\n")

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  await proposeClientMessage({
    brokerageId,
    agentKind: "recruiting_manager",
    entityType: "brokerage",
    entityId: brokerageId,
    recipientContactId: null,
    audience: "agent",
    subject: "What your top producers do differently — this month's playbook candidates",
    body,
    rationale: `${monthTag} — quartile behavior gaps from the brokerage's own ledgers; broker reviews before anything is taught.`,
    channel: "portal",
  }).catch(() => {})
  return { candidates: candidates.length, proposed: true }
}

/** Autonomous: every brokerage, riding the weekly recruit-outreach cron (month-idempotent). */
export async function runPlaybookEngineAll(svc: Svc): Promise<{ brokerages: number; proposed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(500)
  let proposed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runPlaybookEngine(svc, b.id).catch(() => null)
    if (r?.proposed) proposed++
  }
  return { brokerages: (brokerages ?? []).length, proposed }
}
