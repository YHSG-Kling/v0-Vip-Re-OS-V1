// lib/recruiting/retention-radar.ts
//
// Live side of the AGENT RETENTION RADAR (recruiting_manager). Daily, per active agent, it gathers the
// REAL engagement signals the app already tracks, computes the pure retention score, upserts the day's
// agent_retention_scores row, and — the moment an agent FRESHLY crosses into at-risk — proposes a gated
// broker "save play" (targeted to the driving signals) so a slipping agent is caught before they leave.
// Nothing auto-sends. Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { computeRetentionScore, isAtRisk, scoreTrendOf, type RetentionSignals } from "@/lib/recruiting/retention-score"

type Svc = ReturnType<typeof createServiceClient>

const daysSince = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/** Gather the real signals for one agent (best-effort; missing → null → neutral in the scorer). */
async function gatherSignals(svc: Svc, agent: { id: string; created_at?: string | null }, now: Date): Promise<RetentionSignals> {
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const [act, lastClose, pipeline, onboarding, points] = await Promise.all([
    svc.from("agent_assistant_sessions").select("started_at").eq("agent_id", agent.id).order("started_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transactions").select("close_date").eq("agent_id", agent.id).eq("status", "closed").not("close_date", "is", null).order("close_date", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).in("stage", ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING_PENDING", "CLOSING_PREP"]),
    svc.from("agent_onboarding").select("completion_percentage").eq("agent_id", agent.id).maybeSingle(),
    svc.from("agent_points_log").select("points").eq("agent_id", agent.id).gte("created_at", since30).limit(2000),
  ])
  const points30d = Array.isArray(points.data) ? (points.data as Array<{ points: number | null }>).reduce((s, r) => s + (Number(r.points) || 0), 0) : null
  return {
    daysSinceActivity: daysSince((act.data as any)?.started_at ?? null, now),
    daysSinceClosing: daysSince((lastClose.data as any)?.close_date ?? null, now),
    activePipeline: (pipeline as any)?.count ?? null,
    onboardingPct: (onboarding.data as any)?.completion_percentage ?? null,
    tenureDays: daysSince(agent.created_at ?? null, now),
    gamificationPoints30d: points30d,
  }
}

/**
 * Propose ONE gated retention save-play for an at-risk agent (idempotent per agent — an open save-play
 * isn't re-proposed). Shared by the daily radar (on a fresh breach) and the on-demand voice/broker
 * "draft save-plays" command, so both use the same dedupe tag + copy. Returns true when a NEW one lands.
 */
export async function proposeRetentionSavePlay(
  svc: Svc, p: { brokerageId: string; agentId: string; agentName: string; score: number; drivers: string[] },
): Promise<boolean> {
  const dedupeTag = `RETENTION SAVE-PLAY — agent:${p.agentId}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", p.brokerageId).eq("entity_type", "agent").eq("entity_id", p.agentId)
    .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).in("status", ["proposed", "approved"]).limit(1).maybeSingle()
  if (prior) return false
  try {
    // SIGNAL-SPECIFIC intervention — the save-play is tailored to the dominant driving signal (quiet vs
    // drought vs stalled pipeline vs onboarding), not one generic template.
    const { buildSavePlayCopy } = await import("@/lib/recruiting/retention-intervention")
    const copy = buildSavePlayCopy({ agentName: p.agentName, score: p.score, drivers: p.drivers })
    const driverText = p.drivers.filter(Boolean).join("; ") || "engagement is slipping across the board"

    // RETENTION LEVER — the broker-marked benefit offerings (residual income / medical /
    // retirement, m574 + m264). An at-risk agent weighing a competing offer should be reminded of
    // the FULL package they'd walk away from, so the save-play tells the broker which marked
    // offerings to put back on the table. FAIL-CLOSED: loader errors / unset marks → no line at
    // all — an unoffered benefit must never appear in a retention conversation.
    let benefitsLever = ""
    try {
      const { loadBenefitOfferings, offeredBenefitLabels } = await import("@/lib/recruiting/benefit-offerings")
      const labels = offeredBenefitLabels(await loadBenefitOfferings(svc, p.brokerageId))
      if (labels.length > 0) {
        benefitsLever = `\n\nRetention lever — what ${p.agentName} would be walking away from here:\n${labels.map((l) => `· ${l}`).join("\n")}\nWork these into the conversation as part of the full picture of staying.`
      }
    } catch { /* the save-play stands without it */ }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: p.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: p.agentId,
      recipientContactId: null, audience: "agent",
      subject: copy.subject,
      body: copy.body + benefitsLever,
      rationale: `${dedupeTag} — score ${p.score}, intervention ${copy.interventionKey}, drivers: ${driverText}; review before it reaches the agent/broker.`,
      channel: "portal",
    }, svc)
    return res.ok
  } catch { return false }
}

export interface RetentionRadarResult { scanned: number; scored: number; atRisk: number; savePlaysProposed: number }

/** Score a brokerage's active agents, persist today's scores, and propose a save-play on a fresh breach. */
export async function runRetentionRadar(
  svc: Svc, params: { brokerageId: string; now?: Date },
): Promise<RetentionRadarResult> {
  const out: RetentionRadarResult = { scanned: 0, scored: 0, atRisk: 0, savePlaysProposed: 0 }
  const now = params.now ?? new Date()
  const today = now.toISOString().slice(0, 10)

  const { data: agents } = await svc
    .from("agents")
    .select("id, user_id, created_at, users(first_name, last_name)")
    .eq("brokerage_id", params.brokerageId).not("user_id", "is", null).limit(500)

  for (const a of (agents ?? []) as any[]) {
    out.scanned++
    const sig = await gatherSignals(svc, a, now)
    const rs = computeRetentionScore(sig)

    // Previous score (yesterday-or-earlier) for trend + fresh-breach detection.
    const { data: prev } = await svc.from("agent_retention_scores")
      .select("composite_score").eq("agent_id", a.id).lt("score_date", today)
      .order("score_date", { ascending: false }).limit(1).maybeSingle()
    const previousScore = (prev as any)?.composite_score ?? null

    await svc.from("agent_retention_scores").upsert({
      brokerage_id: params.brokerageId, agent_id: a.id, score_date: today,
      composite_score: rs.score, previous_score: previousScore, tier: rs.tier,
      score_trend: scoreTrendOf(rs.score, previousScore), driving_signals: rs.drivingSignals, signal_breakdown: rs.breakdown as any,
    }, { onConflict: "agent_id,score_date" })
    out.scored++
    if (!isAtRisk(rs.score)) continue
    out.atRisk++

    // FRESH breach only — crossed into at-risk (no prior score, or prior was healthy). A persistent
    // low doesn't re-spam; the score keeps updating silently until they recover or the broker acts.
    const freshBreach = previousScore == null || previousScore >= 40
    if (!freshBreach) continue

    const u = Array.isArray(a.users) ? a.users[0] : a.users
    const agentName = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "An agent"
    if (await proposeRetentionSavePlay(svc, { brokerageId: params.brokerageId, agentId: a.id, agentName, score: rs.score, drivers: rs.drivingSignals })) out.savePlaysProposed++

    // Also surface directly (deduped per open, like the license sweep). TIER-SAFE — a broker/admin gets
    // the flag in a team/brokerage org; a SOLO agent (no separate broker) gets it themselves, so a
    // one-person shop's red-flag is never dropped for lack of a broker recipient.
    try {
      const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
      const recipientIds = await resolveOrgRecipients(svc, params.brokerageId)
      for (const mId of recipientIds) {
        const { data: seen } = await svc.from("notifications").select("id").eq("user_id", mId).eq("entity_type", "agent").eq("entity_id", a.id).eq("type", "agent_retention_risk").gte("created_at", new Date(now.getTime() - 7 * 86_400_000).toISOString()).limit(1).maybeSingle()
        if (seen) continue
        const driverText = rs.drivingSignals.length ? rs.drivingSignals.join("; ") : "engagement is slipping across the board"
        await svc.from("notifications").insert({ user_id: mId, brokerage_id: params.brokerageId, type: "agent_retention_risk", title: `${agentName} is at retention risk (${rs.score}/100)`, body: driverText, entity_type: "agent", entity_id: a.id, priority: "high", is_read: false })
      }
    } catch { /* best-effort */ }
  }
  return out
}

/**
 * ON-DEMAND — draft gated save-plays for every CURRENTLY at-risk agent that doesn't already have one
 * open (invoked by the voice command "draft save-plays for my at-risk agents" or a broker button). Reads
 * the retention board (latest scores) and reuses proposeRetentionSavePlay, so it shares the radar's
 * dedupe + copy. Returns how many were drafted. Best-effort.
 */
export async function draftSavePlaysForAtRiskAgents(svc: Svc, params: { brokerageId: string }): Promise<{ atRisk: number; drafted: number }> {
  const out = { atRisk: 0, drafted: 0 }
  const { generateRetentionBoard } = await import("@/lib/intelligence/retention-board")
  const board = await generateRetentionBoard(params.brokerageId, svc)
  if (!board) return out
  for (const a of board.agents) {
    if (a.tier !== "at_risk" && a.tier !== "critical") continue
    out.atRisk++
    if (await proposeRetentionSavePlay(svc, { brokerageId: params.brokerageId, agentId: a.agentId, agentName: a.name, score: a.score, drivers: a.drivers })) out.drafted++
  }
  return out
}

/** Autonomous: score every brokerage's agents (rides the daily compliance-monitoring cron). */
export async function runRetentionRadarAll(svc: Svc, now?: Date): Promise<{ brokerages: number; atRisk: number; savePlays: number }> {
  const out = { brokerages: 0, atRisk: 0, savePlays: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runRetentionRadar(svc, { brokerageId: b.id, now }); out.atRisk += r.atRisk; out.savePlays += r.savePlaysProposed } catch { /* keep going */ }
  }
  return out
}
