// lib/intelligence/career-architect.ts
//
// AGENT CAREER & BRAND ARCHITECT (recruiting_manager) — the OS as a career
// partner, not just a task machine: once a quarter, each producing agent gets
// a gated "where your business is actually pointing" brief grounded ONLY in
// their own ledger — geographic concentration (a farm they already half-own),
// execution speed (a brand claim they can prove), and side mix. HONEST: fewer
// than MIN_CLOSINGS closed deals in the window → no brief (career advice off
// thin data is noise); every suggestion cites the number behind it. Rides the
// weekly recruit-outreach cron, idempotent per (agent, quarter), through the
// gate like every internal brief. Retention play: an agent whose OS shows
// them a career path doesn't churn to a competitor that shows them a CRM.

import type { SupabaseClient } from "@supabase/supabase-js"
import { zipFromAddress } from "@/lib/intelligence/negotiation-bands"

type Svc = SupabaseClient<any, any, any>

export const MIN_CLOSINGS = 3
export const CAREER_WINDOW_DAYS = 365

export interface CareerProfile {
  agentId: string
  closings: number
  volume: number
  topZip: { zip: string; count: number } | null
  decisionMedianHours: number | null
}

export interface CareerSuggestion { key: string; line: string }

/** PURE: only defensible, number-cited suggestions. Null profile = no brief. */
export function composeCareerSuggestions(p: CareerProfile): CareerSuggestion[] {
  if (p.closings < MIN_CLOSINGS) return []
  const out: CareerSuggestion[] = []

  if (p.topZip && p.topZip.count / p.closings >= 0.4) {
    out.push({
      key: "geographic_farm",
      line: `${p.topZip.count} of your ${p.closings} closings this year were in ${p.topZip.zip} — you are already ${Math.round((p.topZip.count / p.closings) * 100)}% of the way to owning that farm. Claiming it outright (farm mailers, the neighborhood guide, open houses there every month) is cheaper than finding a new lane, because the proof is already yours.`,
    })
  }

  if (p.decisionMedianHours != null && p.decisionMedianHours <= 24) {
    out.push({
      key: "speed_brand",
      line: `Your median time from a client's decision to execution is ${Math.round(p.decisionMedianHours * 10) / 10} hours — that is a marketable brand claim almost no agent can prove. Put the number in your listing presentation; the OS tracks it on every decision, so it stays honest.`,
    })
  }

  if (p.volume > 0) {
    const avg = p.volume / p.closings
    out.push({
      key: "price_band",
      line: `Your average closed price is $${Math.round(avg).toLocaleString("en-US")} across ${p.closings} deals. Deliberately listing one tier above that band — with the book program and your closed-deal proof — is the classic path to raising it without changing how you work.`,
    })
  }

  return out
}

/** Load a producing agent's career profile from the ledgers. */
export async function loadCareerProfiles(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<CareerProfile[]> {
  const since = new Date(now.getTime() - CAREER_WINDOW_DAYS * 86_400_000).toISOString()
  const [{ data: closed }, { data: decisions }] = await Promise.all([
    svc.from("transactions").select("agent_id, purchase_price, property_address")
      .eq("brokerage_id", brokerageId).eq("status", "closed").gte("close_date", since.slice(0, 10)).limit(2000),
    svc.from("tasks").select("assigned_to_agent_id, created_at, completed_at")
      .eq("brokerage_id", brokerageId).in("source", ["client_offer_decision", "vendor_request", "lender_condition"])
      .not("completed_at", "is", null).gte("created_at", since).limit(2000),
  ])

  const byAgent = new Map<string, { closings: number; volume: number; zips: Map<string, number>; dec: number[] }>()
  for (const t of ((closed ?? []) as any[])) {
    if (!t.agent_id) continue
    const e = byAgent.get(t.agent_id) ?? { closings: 0, volume: 0, zips: new Map(), dec: [] }
    e.closings += 1
    e.volume += Number(t.purchase_price ?? 0)
    const zip = zipFromAddress(t.property_address)
    if (zip) e.zips.set(zip, (e.zips.get(zip) ?? 0) + 1)
    byAgent.set(t.agent_id, e)
  }
  for (const d of ((decisions ?? []) as any[])) {
    if (!d.assigned_to_agent_id || !d.created_at || !d.completed_at) continue
    const e = byAgent.get(d.assigned_to_agent_id)
    if (!e) continue
    const h = (new Date(d.completed_at).getTime() - new Date(d.created_at).getTime()) / 3_600_000
    if (Number.isFinite(h) && h >= 0) e.dec.push(h)
  }

  return [...byAgent.entries()].map(([agentId, e]) => {
    const top = [...e.zips.entries()].sort((a, b) => b[1] - a[1])[0]
    const sorted = [...e.dec].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return {
      agentId,
      closings: e.closings,
      volume: e.volume,
      topZip: top ? { zip: top[0], count: top[1] } : null,
      decisionMedianHours: sorted.length >= 3 ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null,
    }
  })
}

const quarterTag = (now: Date) => `career_architect:${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`

/** Quarterly gated brief per producing agent. Idempotent per (agent, quarter). */
export async function runCareerArchitect(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<{ briefed: number }> {
  const profiles = await loadCareerProfiles(svc, brokerageId, now)
  let briefed = 0
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  for (const p of profiles) {
    const suggestions = composeCareerSuggestions(p)
    if (suggestions.length === 0) continue
    const tag = `${quarterTag(now)}:${p.agentId}`
    const { data: dup } = await svc.from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).ilike("rationale", `%${tag}%`).limit(1).maybeSingle()
    if (dup) continue
    await proposeClientMessage({
      brokerageId,
      agentKind: "recruiting_manager",
      entityType: "agent",
      entityId: p.agentId,
      audience: "agent",
      subject: "Where your business is actually pointing — your quarterly career brief",
      body: suggestions.map((s, i) => `${i + 1}. ${s.line}`).join("\n\n"),
      rationale: `${tag} — career/brand suggestions grounded ONLY in this agent's own ${CAREER_WINDOW_DAYS}-day ledger (${p.closings} closings).`,
      channel: "portal",
    }).then(() => { briefed++ }, () => {})
  }
  return { briefed }
}

/** Autonomous: every brokerage (weekly cron, quarter-idempotent). */
export async function runCareerArchitectAll(svc: Svc): Promise<{ brokerages: number; briefed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(500)
  let briefed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runCareerArchitect(svc, b.id).catch(() => null)
    if (r) briefed += r.briefed
  }
  return { brokerages: (brokerages ?? []).length, briefed }
}
