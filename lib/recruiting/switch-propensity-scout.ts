// lib/recruiting/switch-propensity-scout.ts
//
// SWITCH-PROPENSITY SCOUT (recruiting_manager) — the live side of the marquee recruiting play. Weekly it
// scores the active pipeline by switch-propensity and proposes ONE gated "prioritize these agents"
// brief to the broker/recruiter, so finite attention goes to the highest-value, most-switchable talent
// FIRST instead of a flat list. Reuses the gated proposal rail (nothing auto-sends). Idempotent per
// (brokerage, ISO week).

import { createServiceClient } from "@/lib/supabase/service"
import { rankRecruitsByPropensity, type ScoredRecruit } from "@/lib/recruiting/switch-propensity"

type Svc = ReturnType<typeof createServiceClient>

/** The non-terminal recruit stages worth prioritizing. */
const ACTIVE_STAGES = ["prospect", "contacted", "interviewing", "offer_extended"]

/** Year-week bucket for the weekly idempotency key (UTC; pure enough for a dedupe tag). */
export function isoWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** PURE: the broker brief body from the ranked recruits (top N hot/warm targets). */
export function buildPriorityBrief(ranked: ScoredRecruit[], topN = 5): { subject: string; body: string } | null {
  const targets = ranked.filter((r) => r.tier !== "cool").slice(0, topN)
  if (targets.length === 0) return null
  const lines = [
    `This week's highest switch-propensity talent — worth your attention first:`,
    ...targets.map((t, i) => `${i + 1}. ${t.name} — ${Math.round(t.score * 100)}% (${t.tier}). ${t.reasons[0] ?? ""}`),
    `Reach out to the top of this list while the signal is fresh; I'll keep the outreach cadence warm for the rest.`,
  ]
  return { subject: `Top ${targets.length} agents to prioritize recruiting this week`, body: lines.join("\n\n") }
}

export interface ScoutResult { scored: number; hot: number; briefProposed: boolean }

/** Score a brokerage's active recruits and propose one gated weekly priority brief. Best-effort. */
export async function runSwitchPropensityScout(
  svc: Svc, params: { brokerageId: string; now?: Date },
): Promise<ScoutResult> {
  const out: ScoutResult = { scored: 0, hot: 0, briefProposed: false }
  const now = params.now ?? new Date()

  const { data: recruits } = await svc
    .from("recruits")
    .select("id, first_name, last_name, referral_source, annual_volume, years_experience, status")
    .eq("brokerage_id", params.brokerageId).in("status", ACTIVE_STAGES).limit(500)
  if (!recruits || recruits.length === 0) return out

  const ranked = rankRecruitsByPropensity(recruits as any[])
  out.scored = ranked.length
  out.hot = ranked.filter((r) => r.tier === "hot").length

  const brief = buildPriorityBrief(ranked)
  if (!brief) return out

  const dedupeTag = `RECRUIT PRIORITY BRIEF — ${isoWeekKey(now)}`
  const { data: prior } = await svc
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`)
    .limit(1).maybeSingle()
  if (prior) return out

  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: brief.subject, body: brief.body,
      rationale: `${dedupeTag} — ${out.hot} hot / ${out.scored} scored; review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: score every brokerage's pipeline (rides the weekly recruit-outreach cron). */
export async function runSwitchPropensityScoutAll(svc: Svc, now?: Date): Promise<{ brokerages: number; briefs: number; hot: number }> {
  const out = { brokerages: 0, briefs: 0, hot: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runSwitchPropensityScout(svc, { brokerageId: b.id, now }); if (r.briefProposed) out.briefs++; out.hot += r.hot } catch { /* keep going */ }
  }
  return out
}
