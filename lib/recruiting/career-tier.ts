// lib/recruiting/career-tier.ts
//
// CAREER TIER LADDER (recruiting_manager) — the progression path that answers the "no path forward" driver
// of first-year attrition. Five permanent tiers (rookie → associate → senior → team_lead → partner), each
// with production + time gates. Upgrades are automatic when earned; tiers never downgrade (a hard-won tier
// is kept). This is the AGENT career ladder — distinct from billing plan_tier and the cosmetic points tier.
//
// Pure + deterministic (testable). The runner evaluates real production/tenure/team stats and upgrades
// agents.career_tier; approaching the next tier (>=80%) proposes a gated career-coach nudge.

export type CareerTier = "rookie" | "associate" | "senior" | "team_lead" | "partner"

export const TIER_ORDER: CareerTier[] = ["rookie", "associate", "senior", "team_lead", "partner"]

export interface TierGate {
  tier: CareerTier
  label: string
  /** Lifetime closings required (0 = none). */
  closingsLifetime: number
  /** Closings in the trailing 24 months (senior). */
  closingsTrailing24m: number
  /** Closings in the trailing 36 months (team_lead). */
  closingsTrailing36m: number
  /** Months active required (OR-satisfied with production for associate). */
  monthsActive: number
  /** Team members required (team_lead). */
  teamSize: number
  /** Requires a human step (broker approval / nomination) — never auto-granted. */
  requiresApproval: boolean
}

/** The ladder gates (documented from the spec; broker-waivable pieces are noted at evaluation). */
export const TIER_GATES: Record<CareerTier, TierGate> = {
  rookie:    { tier: "rookie",    label: "Rookie",    closingsLifetime: 0,  closingsTrailing24m: 0,  closingsTrailing36m: 0,  monthsActive: 0,  teamSize: 0, requiresApproval: false },
  associate: { tier: "associate", label: "Associate", closingsLifetime: 3,  closingsTrailing24m: 0,  closingsTrailing36m: 0,  monthsActive: 12, teamSize: 0, requiresApproval: false },
  senior:    { tier: "senior",    label: "Senior",    closingsLifetime: 0,  closingsTrailing24m: 12, closingsTrailing36m: 0,  monthsActive: 24, teamSize: 0, requiresApproval: false },
  team_lead: { tier: "team_lead", label: "Team Lead", closingsLifetime: 0,  closingsTrailing24m: 0,  closingsTrailing36m: 25, monthsActive: 36, teamSize: 2, requiresApproval: true },
  partner:   { tier: "partner",   label: "Partner",   closingsLifetime: 50, closingsTrailing24m: 0,  closingsTrailing36m: 0,  monthsActive: 0,  teamSize: 0, requiresApproval: true },
}

export interface AgentTierStats {
  closingsLifetime: number
  closingsTrailing24m: number
  closingsTrailing36m: number
  monthsActive: number
  teamSize: number
  /** Whether the broker has approved a tier that requires approval (team_lead/partner). */
  approvalGranted?: boolean
}

/** PURE: is the agent eligible for a given tier by its gates? Associate is OR (production OR tenure). */
export function meetsTier(tier: CareerTier, s: AgentTierStats): boolean {
  const g = TIER_GATES[tier]
  if (g.requiresApproval && !s.approvalGranted) return false
  switch (tier) {
    case "rookie": return true
    case "associate": return s.closingsLifetime >= g.closingsLifetime || s.monthsActive >= g.monthsActive
    case "senior": return s.closingsTrailing24m >= g.closingsTrailing24m && s.monthsActive >= g.monthsActive
    case "team_lead": return s.closingsTrailing36m >= g.closingsTrailing36m && s.monthsActive >= g.monthsActive && s.teamSize >= g.teamSize
    case "partner": return s.closingsLifetime >= g.closingsLifetime
    default: return false
  }
}

/** PURE: the highest tier the agent's stats earn (auto tiers only unless approval is granted). */
export function earnedTier(s: AgentTierStats): CareerTier {
  let earned: CareerTier = "rookie"
  for (const tier of TIER_ORDER) if (meetsTier(tier, s)) earned = tier
  return earned
}

export const tierRank = (t: CareerTier): number => TIER_ORDER.indexOf(t)

export interface TierProgress {
  currentTier: CareerTier
  nextTier: CareerTier | null
  /** 0..100 toward the next tier's binding requirement. */
  pctToNext: number
  /** The single most-binding thing still needed. */
  gap: { metric: string; have: number; need: number } | null
}

/**
 * PURE: progress toward the next AUTO tier (rookie→associate→senior; team_lead/partner require a human step
 * so they show as "needs broker approval" rather than an auto pct). The pct tracks the closest-to-done of
 * the next tier's requirements so a near-miss reads accurately.
 */
export function tierProgress(current: CareerTier, s: AgentTierStats): TierProgress {
  const idx = tierRank(current)
  const nextTier = idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null
  if (!nextTier) return { currentTier: current, nextTier: null, pctToNext: 100, gap: null }

  const g = TIER_GATES[nextTier]
  // Build the requirement set for the next tier and pick the binding (least-complete) one.
  const reqs: Array<{ metric: string; have: number; need: number }> = []
  if (nextTier === "associate") {
    // OR gate — progress is the BETTER of the two paths.
    const byClosings = { metric: "lifetime closings", have: s.closingsLifetime, need: g.closingsLifetime }
    const byTenure = { metric: "months active", have: s.monthsActive, need: g.monthsActive }
    const bestPct = Math.max(pct(byClosings.have, byClosings.need), pct(byTenure.have, byTenure.need))
    const gap = pct(byClosings.have, byClosings.need) >= pct(byTenure.have, byTenure.need) ? byClosings : byTenure
    return { currentTier: current, nextTier, pctToNext: Math.min(100, Math.round(bestPct)), gap: bestPct >= 100 ? null : gap }
  }
  if (nextTier === "senior") { reqs.push({ metric: "closings (24 mo)", have: s.closingsTrailing24m, need: g.closingsTrailing24m }, { metric: "months active", have: s.monthsActive, need: g.monthsActive }) }
  if (nextTier === "team_lead") { reqs.push({ metric: "closings (36 mo)", have: s.closingsTrailing36m, need: g.closingsTrailing36m }, { metric: "months active", have: s.monthsActive, need: g.monthsActive }, { metric: "team members", have: s.teamSize, need: g.teamSize }) }
  if (nextTier === "partner") { reqs.push({ metric: "lifetime closings", have: s.closingsLifetime, need: g.closingsLifetime }) }

  // AND gate — bottleneck is the least-complete requirement.
  let binding = reqs[0]
  let minPct = 100
  for (const r of reqs) { const p = pct(r.have, r.need); if (p < minPct) { minPct = p; binding = r } }
  return { currentTier: current, nextTier, pctToNext: Math.min(100, Math.round(minPct)), gap: minPct >= 100 ? null : binding }
}

function pct(have: number, need: number): number { return need <= 0 ? 100 : Math.min(100, (have / need) * 100) }

// ─── Service layer: evaluate real stats, auto-upgrade, approach nudge ──────────
import type { createServiceClient } from "@/lib/supabase/service"
type Svc = ReturnType<typeof createServiceClient>

/** Gather an agent's real production/tenure/team stats for tier evaluation. */
export async function gatherTierStats(svc: Svc, agent: { id: string; created_at?: string | null; team_id?: string | null }, now: Date): Promise<AgentTierStats> {
  const since24 = new Date(now.getTime() - 730 * 86_400_000).toISOString().slice(0, 10)
  const since36 = new Date(now.getTime() - 1095 * 86_400_000).toISOString().slice(0, 10)
  const [lifetime, t24, t36, team] = await Promise.all([
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).eq("status", "closed"),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).eq("status", "closed").gte("close_date", since24),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).eq("status", "closed").gte("close_date", since36),
    agent.team_id ? svc.from("team_members").select("id", { count: "exact", head: true }).eq("team_id", agent.team_id) : Promise.resolve({ count: 0 } as any),
  ])
  const monthsActive = agent.created_at ? Math.max(0, Math.floor((now.getTime() - Date.parse(agent.created_at)) / (30 * 86_400_000))) : 0
  return {
    closingsLifetime: (lifetime as any).count ?? 0,
    closingsTrailing24m: (t24 as any).count ?? 0,
    closingsTrailing36m: (t36 as any).count ?? 0,
    monthsActive,
    teamSize: (team as any).count ?? 0,
    approvalGranted: false,  // team_lead/partner require an explicit broker promotion; auto-ladder tops at senior
  }
}

export interface TierEvalResult { scanned: number; upgraded: number; approachNudges: number }

/**
 * Evaluate a brokerage's active agents: AUTO-UPGRADE career_tier when a higher AUTO tier is earned (never
 * downgrades), notify the agent on an upgrade, and propose ONE gated career-coach nudge when an agent is
 * >=80% toward the next tier (deduped per agent+nextTier+ISO-2-week). Best-effort.
 */
export async function runCareerTierEvaluation(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<TierEvalResult> {
  const out: TierEvalResult = { scanned: 0, upgraded: 0, approachNudges: 0 }
  const now = params.now ?? new Date()
  const { data: agents } = await svc.from("agents").select("id, user_id, created_at, team_id, career_tier").eq("brokerage_id", params.brokerageId).eq("is_active", true).limit(2000)
  const biweek = `${now.getUTCFullYear()}-${Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / (14 * 86_400_000))}`

  for (const a of (agents ?? []) as any[]) {
    out.scanned++
    try {
      const stats = await gatherTierStats(svc, a, now)
      const current = (a.career_tier ?? "rookie") as CareerTier
      const earned = earnedTier(stats)

      // AUTO-UPGRADE (never downgrade).
      if (tierRank(earned) > tierRank(current)) {
        await svc.from("agents").update({ career_tier: earned, tier_updated_at: now.toISOString() }).eq("id", a.id)
        out.upgraded++
        if (a.user_id) {
          await svc.from("notifications").insert({ user_id: a.user_id, brokerage_id: params.brokerageId, type: "career_tier_upgrade", title: `You reached ${TIER_GATES[earned].label}!`, body: `Congratulations — your production moved you up to the ${TIER_GATES[earned].label} tier.`, entity_type: "agent", entity_id: a.id, priority: "medium", is_read: false })
        }
        continue // don't also nudge in the same run
      }

      // APPROACH NUDGE — >=80% toward the next tier.
      const prog = tierProgress(current, stats)
      if (prog.nextTier && prog.pctToNext >= 80 && prog.pctToNext < 100 && prog.gap) {
        const dedupeTag = `CAREER TIER — agent:${a.id} ${prog.nextTier} ${biweek}`
        const { data: prior } = await svc.from("agent_client_messages").select("id")
          .eq("brokerage_id", params.brokerageId).eq("entity_type", "agent").eq("entity_id", a.id)
          .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
        if (prior) continue
        const need = prog.gap.need - prog.gap.have
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const res = await proposeClientMessage({
          brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: a.id,
          recipientContactId: null, audience: "agent",
          subject: `You're ${prog.pctToNext}% of the way to ${TIER_GATES[prog.nextTier].label}`,
          body: [
            `You're close to reaching the ${TIER_GATES[prog.nextTier].label} tier — just ${need} more ${prog.gap.metric} to go.`,
            `That unlocks real perks (better lead priority, more tools, a higher split where your brokerage offers it). Let's map out how to close the gap this quarter.`,
          ].join("\n\n"),
          rationale: `${dedupeTag} — ${prog.pctToNext}% to ${prog.nextTier}, gap ${need} ${prog.gap.metric}; review before it reaches the agent.`,
          channel: "portal",
        }, svc)
        if (res.ok) out.approachNudges++
      }
    } catch { /* keep going */ }
  }
  return out
}

/** Autonomous: evaluate career tiers across every brokerage (rides the weekly recruit-outreach cron). */
export async function runCareerTierEvaluationAll(svc: Svc, now?: Date): Promise<{ brokerages: number; upgraded: number; nudges: number }> {
  const out = { brokerages: 0, upgraded: 0, nudges: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runCareerTierEvaluation(svc, { brokerageId: b.id, now }); out.upgraded += r.upgraded; out.nudges += r.approachNudges } catch { /* keep going */ }
  }
  return out
}
