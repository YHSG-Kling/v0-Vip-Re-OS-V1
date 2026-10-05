// lib/education/skill-freshness-radar.ts
//
// SKILL-FRESHNESS RADAR (recruiting_manager) — the live side of the continuing-competency loop. Per
// active agent it reads the REAL last-practice signal for each skill (objection_training_sessions,
// agent_quiz_attempts, learning_assignments — the canonical agent-module completion rail), scores
// freshness, and when a skill has gone STALE (or a tenured
// agent has never proven it) proposes ONE gated, short "refresher" nudge to the agent so their edge
// doesn't dull. Reuses the gated proposal rail (nothing auto-sends); deduped per (agent, skill, month).
// Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import {
  computeSkillFreshness, scoreCompetency, SKILL_LABEL,
  type CompetencyEvidence, type CompetencyProfile, type SkillArea, type SkillSignal,
} from "@/lib/education/skill-freshness"
import { daysSince } from "@/lib/format/dates"
import { evaluateLicenseReadiness } from "@/lib/compliance/license-readiness"
import { ceProgress } from "@/lib/education/ce-provider"

type Svc = ReturnType<typeof createServiceClient>

/** A tenured agent (past onboarding) who has NEVER proven a skill is worth a first nudge; a brand-new
 *  agent is left alone (they're still onboarding — untested is expected, not a gap). */
export const UNTESTED_TENURE_DAYS = 45

// TOMBSTONE: local daysSince merged onto lib/format/dates.ts daysSince
// (imported above) — §1/§6 SAME BODY census round 3, 2026-09-09.

/** Gather the last-practice signal for one agent across the three skill areas (best-effort).
 *  EXPORTED (wave 103, lane 103A): the command-center board carried a byte-identical copy of these
 *  three reads (lib/intelligence/skill-freshness-board.ts) — merged onto this one gatherer so the
 *  radar, the briefing, the board and the competency model can never read different signals. */
export async function gatherSkillSignals(svc: Svc, agent: { id: string; user_id: string | null }, now: Date): Promise<SkillSignal[]> {
  const [obj, quiz, course] = await Promise.all([
    agent.user_id
      ? svc.from("objection_training_sessions").select("completed_at, total_score").eq("agent_user_id", agent.user_id).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    svc.from("agent_quiz_attempts").select("created_at, score, passed").eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    // Coursework = the agent's most recent COMPLETED learning_modules assignment (the canonical
    // agent-education rail). The legacy agent_courses table had no runtime writer, so this signal was
    // permanently null; learning_assignments is the live, writeable completion source.
    agent.user_id
      ? svc.from("learning_assignments").select("completed_at, quiz_score").eq("agent_user_id", agent.user_id).eq("status", "completed").is("contact_id", null).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const objData = (obj as any).data
  const quizData = (quiz as any).data
  const courseData = (course as any).data
  return [
    { area: "objection_handling", lastPracticedDays: daysSince(objData?.completed_at, now), lastScore: objData?.total_score ?? null },
    // A failed quiz counts as a weak score even if recent.
    { area: "product_knowledge", lastPracticedDays: daysSince(quizData?.created_at, now), lastScore: quizData ? (quizData.passed === false ? Math.min(quizData.score ?? 0, 50) : quizData.score ?? null) : null },
    { area: "coursework", lastPracticedDays: daysSince(courseData?.completed_at, now), lastScore: courseData?.quiz_score ?? null },
  ]
}

/** ACADEMY → BRIEFING LOOP: one agent's freshness report, for the morning
 *  briefing's skill line. Same signals the radar uses (objection drills,
 *  quizzes, COMPLETED modules) — the briefing and the radar can never disagree. */
export async function loadAgentSkillFreshness(
  svc: Svc, agent: { id: string; user_id: string | null }, now: Date = new Date(),
) {
  const { computeSkillFreshness } = await import("./skill-freshness")
  return computeSkillFreshness(await gatherSkillSignals(svc, agent, now))
}

// ── THE COMPETENCY EVIDENCE LOADER (wave 103, lane 103A) ──────────────────────────────────────
// Reads every evidence rail the pure model scores (lib/education/skill-freshness.ts:scoreCompetency)
// for ONE agent. Every read destructures its error (CLAUDE.md §3); a refused rail is reported as
// NO evidence for that skill (null → unproven), never as a zero that reads like a bad agent.
// Windows: outcomes/coaching 90 days (the coaching horizon in lib/kernel/agent-coaching.ts),
// drills 180 days, closings 365 days (the career-architect window).

const COMPETENCY_OUTCOME_WINDOW_DAYS = 90
const COMPETENCY_DRILL_WINDOW_DAYS = 180
const COMPETENCY_CLOSING_WINDOW_DAYS = 365
const ACTIVE_TXN_STATUSES = ["active", "under_contract", "closing"]
const APPT_STATUSES = ["scheduled", "confirmed", "completed", "no_show"]
const STRENGTH_INSIGHT_TYPES = new Set(["strength"])

export interface CompetencyAgentRef { id: string; user_id: string | null; brokerage_id: string }

/** Gather the competency evidence for one agent (best-effort per rail; refused rails are published).
 *  Module-private: loadAgentCompetency below is the one door. */
async function gatherCompetencyEvidence(
  svc: Svc, agent: CompetencyAgentRef, now: Date = new Date(),
): Promise<{ evidence: CompetencyEvidence; refusedRails: string[] }> {
  const refused: string[] = []
  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
  const outcomeSince = since(COMPETENCY_OUTCOME_WINDOW_DAYS)
  const uid = agent.user_id

  const freshness = await gatherSkillSignals(svc, agent, now)

  const [drills, insights, closed, active, tours, offers, appts, routed, agentRow, certs, modules] = await Promise.all([
    uid ? svc.from("objection_training_sessions").select("scenario_key, total_score").eq("agent_user_id", uid).not("completed_at", "is", null).gte("started_at", since(COMPETENCY_DRILL_WINDOW_DAYS)).limit(500) : Promise.resolve({ data: [], error: null }),
    svc.from("call_coaching_insights").select("insight_type").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).eq("dismissed", false).gte("created_at", outcomeSince).limit(1000),
    svc.from("transactions").select("id").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).eq("status", "closed").gte("close_date", since(COMPETENCY_CLOSING_WINDOW_DAYS).slice(0, 10)).limit(500),
    svc.from("transactions").select("id").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).in("status", ACTIVE_TXN_STATUSES).limit(200),
    svc.from("tours").select("id").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).gte("created_at", outcomeSince).limit(2000),
    svc.from("offers").select("id").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).gte("created_at", outcomeSince).limit(2000),
    uid ? svc.from("calendar_events").select("status").eq("brokerage_id", agent.brokerage_id).eq("agent_user_id", uid).in("status", APPT_STATUSES).gte("start_at", outcomeSince).limit(2000) : Promise.resolve({ data: [], error: null }),
    svc.from("assignment_log").select("claimed, claimed_at, created_at").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).gte("created_at", outcomeSince).limit(2000),
    svc.from("agents").select("license_expiry, ce_hours_required, ce_hours_completed, ce_cycle_end_date, ethics_due_date").eq("id", agent.id).maybeSingle(),
    svc.from("agent_certifications").select("expires_at").eq("agent_id", agent.id).limit(100),
    uid ? svc.from("learning_assignments").select("status, quiz_score").eq("agent_user_id", uid).is("contact_id", null).limit(1000) : Promise.resolve({ data: [], error: null }),
  ])
  const rail = <T>(name: string, r: { data: T | null; error: { message: string } | null }): T | null => {
    if (r.error) { refused.push(`${name}: ${r.error.message}`); return null }
    return r.data
  }

  // Objection simulator — the SIMULATION WRITES INTO THE MODEL through these rows (total_score +
  // completed_at are set by app/actions/objection-training.ts endPracticeSession).
  const drillRows = rail("objection_training_sessions", drills as any) as Array<{ scenario_key: string | null; total_score: number | null }> | null
  const byScenario = new Map<string, { n: number; sum: number }>()
  let drillN = 0, drillSum = 0
  for (const d of drillRows ?? []) {
    if (typeof d.total_score !== "number") continue
    drillN++; drillSum += d.total_score
    const k = d.scenario_key ?? "unknown"
    const e = byScenario.get(k) ?? { n: 0, sum: 0 }
    e.n++; e.sum += d.total_score; byScenario.set(k, e)
  }

  const insightRows = rail("call_coaching_insights", insights as any) as Array<{ insight_type: string }> | null
  let strengths = 0, improvements = 0
  for (const i of insightRows ?? []) { if (STRENGTH_INSIGHT_TYPES.has(i.insight_type)) strengths++; else improvements++ }

  const closedRows = rail("transactions.closed", closed as any) as Array<{ id: string }> | null
  const activeRows = rail("transactions.active", active as any) as Array<{ id: string }> | null
  // Deal health in a second read (no bare embed — transactions↔deal_health_scores is a PGRST201 risk).
  const healths: number[] = []
  if (activeRows && activeRows.length > 0) {
    const { data: hs, error: hErr } = await svc.from("deal_health_scores").select("overall_score")
      .in("transaction_id", activeRows.map((t) => t.id)).limit(200)
    if (hErr) refused.push(`deal_health_scores: ${hErr.message}`)
    for (const h of (hs ?? []) as Array<{ overall_score: number | null }>) if (typeof h.overall_score === "number") healths.push(h.overall_score)
  }
  const tourRows = rail("tours", tours as any) as Array<{ id: string }> | null
  const offerRows = rail("offers", offers as any) as Array<{ id: string }> | null
  const apptRows = rail("calendar_events", appts as any) as Array<{ status: string | null }> | null
  const routedRows = rail("assignment_log", routed as any) as Array<{ claimed: boolean | null; claimed_at: string | null; created_at: string }> | null
  const claimMinutes: number[] = []
  let claimed = 0
  for (const r of routedRows ?? []) {
    if (!r.claimed) continue
    claimed++
    if (r.claimed_at) {
      const m = (Date.parse(r.claimed_at) - Date.parse(r.created_at)) / 60_000
      if (Number.isFinite(m) && m >= 0) claimMinutes.push(m)
    }
  }
  claimMinutes.sort((a, b) => a - b)
  const mid = Math.floor(claimMinutes.length / 2)
  const medianClaim = claimMinutes.length === 0 ? null : claimMinutes.length % 2 ? claimMinutes[mid] : (claimMinutes[mid - 1] + claimMinutes[mid]) / 2

  // Compliance — the ONE readiness verdict (lib/compliance/license-readiness.ts) feeds the model.
  const a = rail("agents", agentRow as any) as { license_expiry: string | null; ce_hours_required: number | null; ce_hours_completed: number | null; ce_cycle_end_date: string | null; ethics_due_date: string | null } | null
  const readiness = a ? evaluateLicenseReadiness({ licenseExpiry: a.license_expiry, ceHoursRequired: a.ce_hours_required, ceHoursCompleted: a.ce_hours_completed, ceCycleEndDate: a.ce_cycle_end_date, ethicsDueDate: a.ethics_due_date }, now) : null
  const ce = a && (a.ce_hours_required ?? 0) > 0 ? ceProgress(a.ce_hours_required, a.ce_hours_completed) : null
  const certRows = rail("agent_certifications", certs as any) as Array<{ expires_at: string | null }> | null
  const activeCerts = (certRows ?? []).filter((c) => !c.expires_at || Date.parse(c.expires_at) > now.getTime()).length

  const moduleRows = rail("learning_assignments", modules as any) as Array<{ status: string | null; quiz_score: number | null }> | null
  const quiz = (moduleRows ?? []).map((m) => m.quiz_score).filter((q): q is number => typeof q === "number")

  const evidence: CompetencyEvidence = {
    freshness,
    objection: {
      sessions: drillN, avgScore: drillN ? drillSum / drillN : null,
      byScenario: [...byScenario.entries()].map(([key, e]) => ({ key, sessions: e.n, avgScore: e.sum / e.n })),
    },
    coaching: { strengths, improvements },
    outcomes: {
      closings: (closedRows ?? []).length, activeDeals: (activeRows ?? []).length,
      avgHealthScore: healths.length ? Math.round(healths.reduce((x, y) => x + y, 0) / healths.length) : null,
      tours: (tourRows ?? []).length, offers: (offerRows ?? []).length,
      appointments: (apptRows ?? []).length, noShows: (apptRows ?? []).filter((e) => e.status === "no_show").length,
      leadsAssigned: (routedRows ?? []).length, leadsClaimed: claimed, medianClaimMinutes: medianClaim,
    },
    compliance: {
      ready: readiness?.ready ?? true, blockers: readiness?.blockers.length ?? 0, warnings: readiness?.warnings.length ?? 0,
      cePct: ce ? ce.pct : null, activeCertifications: activeCerts,
    },
    modules: { assigned: (moduleRows ?? []).length, completed: (moduleRows ?? []).filter((m) => m.status === "completed").length, avgQuizScore: quiz.length ? quiz.reduce((x, y) => x + y, 0) / quiz.length : null },
  }
  return { evidence, refusedRails: refused }
}

/** THE ONE per-agent competency read: evidence → pure profile. Consumers: the learning router
 *  (resolve-agent-learning-context), the coaching brief (agent-coaching), the team-lead brief, the board. */
export async function loadAgentCompetency(
  svc: Svc, agent: CompetencyAgentRef, now: Date = new Date(),
): Promise<CompetencyProfile & { refusedRails: string[] }> {
  const { evidence, refusedRails } = await gatherCompetencyEvidence(svc, agent, now)
  return { ...scoreCompetency(evidence), refusedRails }
}

export interface SkillRadarResult { scanned: number; nudged: number; staleSkills: number }

/**
 * The refresher CTA for each skill area — a TOTAL map, not an if/else chain.
 *
 * This was written as `skill.area === "objection_handling" ? … : skill.area ===
 * "product_knowledge" ? … : <coursework copy>`, which types as `string` no matter
 * what `SkillArea` says. Add a fourth area to the union
 * (lib/education/skill-freshness.ts:13) and every agent in it silently receives
 * the COURSEWORK line — a nudge about the wrong skill, sent to a real agent,
 * with nothing anywhere to report it. `Record<SkillArea, string>` makes the
 * compiler refuse the build until the new area has its own copy, which is what
 * CLAUDE.md §6 means by one vocabulary per function: the union and the copy
 * cannot drift apart because they are checked against each other.
 */
const SKILL_REFRESH_CTA: Record<SkillArea, string> = {
  objection_handling: "Run a 5-minute objection drill — I've queued a fresh scenario for you.",
  product_knowledge: "Take a quick knowledge check to lock it back in.",
  coursework: "Revisit the course refresher — a short review keeps it current.",
}

/** Score a brokerage's active agents' skill freshness and propose gated refreshers on decayed skills. */
export async function runSkillFreshnessRadar(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<SkillRadarResult> {
  const out: SkillRadarResult = { scanned: 0, nudged: 0, staleSkills: 0 }
  const now = params.now ?? new Date()
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`

  const { data: agents } = await svc.from("agents")
    .select("id, user_id, created_at").eq("brokerage_id", params.brokerageId).eq("is_active", true).not("user_id", "is", null).limit(1000)

  for (const a of (agents ?? []) as any[]) {
    out.scanned++
    const tenureDays = daysSince(a.created_at, now)
    const signals = await gatherSkillSignals(svc, a, now)
    const report = computeSkillFreshness(signals)

    // Which skills warrant a nudge: any STALE skill, plus UNTESTED skills for a tenured agent.
    const toNudge = report.skills.filter(
      (s) => s.status === "stale" || (s.status === "untested" && (tenureDays ?? 0) >= UNTESTED_TENURE_DAYS),
    )
    out.staleSkills += report.skills.filter((s) => s.status === "stale").length
    if (toNudge.length === 0) continue

    // One nudge per (agent, skill, month) — a decayed skill doesn't re-spam within the month.
    for (const skill of toNudge) {
      const dedupeTag = `SKILL REFRESH — agent:${a.id} — ${skill.area} — ${monthKey}`
      const { data: prior } = await svc.from("agent_client_messages").select("id")
        .eq("brokerage_id", params.brokerageId).eq("entity_type", "agent").eq("entity_id", a.id)
        .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
      if (prior) continue

      const label = SKILL_LABEL[skill.area]
      const cta = SKILL_REFRESH_CTA[skill.area]
      try {
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const res = await proposeClientMessage({
          brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: a.id,
          recipientContactId: null, audience: "agent",
          subject: `Keep your edge: ${label.toLowerCase()} refresher`,
          body: [`${skill.reason}`, `${cta} A few minutes now keeps you sharp when it counts on a live call.`].join("\n\n"),
          rationale: `${dedupeTag} — ${skill.status}; review before it reaches the agent.`,
          channel: "portal",
        }, svc)
        if (res.ok) out.nudged++
      } catch { /* best-effort */ }
    }
  }
  return out
}

/** Autonomous: sweep every brokerage's skill freshness (rides the daily onboarding-reminders cron). */
export async function runSkillFreshnessRadarAll(svc: Svc, now?: Date): Promise<{ brokerages: number; nudged: number }> {
  const out = { brokerages: 0, nudged: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runSkillFreshnessRadar(svc, { brokerageId: b.id, now }); out.nudged += r.nudged } catch { /* keep going */ }
  }
  return out
}
