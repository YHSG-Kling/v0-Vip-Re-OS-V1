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
  observeWeakness, competencyDeltas, improvedCompetencies, competencyScoreMap, COMPETENCY_GAP_SCORE, COMPETENCY_GAP_TAG,
  type CompetencyEvidence, type CompetencyProfile, type SkillArea, type SkillSignal, type CompetencySkill, type ObservedWeakness,
} from "@/lib/education/skill-freshness"
import { composeAssessment } from "@/lib/training/objection-scenarios"
import { KernelEvent } from "@/lib/kernel/events"
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

  const [drills, insights, closed, active, tours, offers, appts, routed, agentRow, certs, modules, presentations, listingRows, posts, recruitRows] = await Promise.all([
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
    // Wave 106 (106D) rails: listing presentation + pricing (one listings read), marketing, recruiting.
    // listing_presentations IS the listing-appointment survivor (status draft → ready → presented → converted | abandoned).
    svc.from("listing_presentations").select("status, appointment_at, created_at").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).in("status", ["presented", "converted", "abandoned"]).gte("created_at", outcomeSince).limit(2000),
    svc.from("listings").select("list_price, sold_price, sold_date").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).is("deleted_at", null).not("sold_date", "is", null).limit(2000),
    svc.from("social_posts").select("id").eq("brokerage_id", agent.brokerage_id).eq("agent_id", agent.id).eq("status", "published").gte("published_at", outcomeSince).limit(2000),
    svc.from("recruits").select("provisioned").eq("brokerage_id", agent.brokerage_id).eq("recruiter_agent_id", agent.id).gte("created_at", since(COMPETENCY_CLOSING_WINDOW_DAYS)).limit(2000),
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

  // Listing presentation ← listing_presentations (presented + converted + abandoned = held; converted = taken);
  // pricing ← sold listings' sold/list ratio. A refused rail leaves the field absent → unproven.
  const pRows = rail("listing_presentations", presentations as any) as Array<{ status: string | null }> | null
  const listing: CompetencyEvidence["listing"] | undefined = pRows ? { appointments: pRows.length, taken: pRows.filter((p) => p.status === "converted").length } : undefined
  const lRows = rail("listings", listingRows as any) as Array<{ list_price: number | null; sold_price: number | null; sold_date: string | null }> | null
  let pricing: CompetencyEvidence["pricing"]
  if (lRows) {
    const sold = lRows.filter((l) => l.sold_date && l.sold_date >= since(COMPETENCY_CLOSING_WINDOW_DAYS).slice(0, 10) && Number(l.sold_price) > 0 && Number(l.list_price) > 0)
    pricing = { sold: sold.length, avgSoldToList: sold.length ? sold.reduce((a, l) => a + Number(l.sold_price) / Number(l.list_price), 0) / sold.length : null }
  }
  const postRows = rail("social_posts", posts as any) as Array<{ id: string }> | null
  const recRows = rail("recruits", recruitRows as any) as Array<{ provisioned: boolean | null }> | null

  const evidence: CompetencyEvidence = {
    ...(listing ? { listing } : {}), ...(pricing ? { pricing } : {}),
    ...(postRows ? { marketing: { postsPublished: postRows.length } } : {}),
    ...(recRows ? { recruiting: { recruits: recRows.length, provisioned: recRows.filter((r) => r.provisioned === true).length } } : {}),
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

// ═════════════════════════════════════════════════════════════════════════════
// THE ADAPTIVE DEVELOPMENT LOOP — live half (wave 106, lane 106D). Owner 2026-10-06: "observed
// weakness → education recommendation → AI coaching/simulation → assessment → real-world activity →
// actual outcome → competency update". ONE cycle per agent per day, every step on the survivors:
//   observe    loadAgentCompetency (the ONE evidence read) + strain (lib/gamification/strain.ts)
//              → observeWeakness (pure)
//   recommend  the learning router's catalog match (learning_modules.gap_tags ∩ the gap's tag,
//              COMPETENCY_GAP_TAG) → a learning_assignments row (status open, signal_source
//              adaptive_development) when none stands
//   assess     composeAssessment (lib/training/objection-scenarios.ts: scenario + rubric,
//              compliance-first) → the latest COMPLETED objection_training_sessions row for that
//              scenario is the assessment score; absent → ONE gated nudge through the proposal rail
//   activity + outcome   are the evidence rails themselves (listings, tours, offers, transactions —
//              the same rows roi-ledger / agent-scorecard aggregate); nothing is re-derived
//   update     competencyDeltas vs the LAST LEDGERED cycle (agent_action_ledger is the memory —
//              no competency table) → improvedCompetencies → COMPETENCY_IMPROVED per improved
//              skill (the reactor awards the IMPROVEMENT, lifecycle-awards) → has_competency edges
//              re-derived (confidence updated)
// Every step is a withActionLedger row (who: recruiting_manager; what: development.<step>;
// evidence: detail) — LAW 5. Tenant: the agent row's brokerage_id, never a parameter from a body.
// ═════════════════════════════════════════════════════════════════════════════

export const DEVELOPMENT_ACTION = {
  // domain.entity.action — the ledger's action grammar (lib/kernel/action-ledger.ts refuses anything else).
  observe: "development.competency.observe",
  recommend: "development.competency.recommend",
  assess: "development.competency.assess",
  update: "development.competency.update",
} as const
const DEVELOPMENT_SIGNAL_SOURCE = "adaptive_development"

export interface DevelopmentCycleResult {
  agentId: string
  weakest: ObservedWeakness[]
  underStrain: boolean | null
  recommended: Array<{ skill: CompetencySkill; moduleId: string; title: string; assigned: boolean }>
  assessments: Array<{ skill: CompetencySkill; scenarioKey: string; score: number | null; nudged: boolean }>
  improved: Array<{ skill: CompetencySkill; before: number; after: number }>
  overall: number | null
  refusedRails: string[]
  /** Steps whose ledger claim replayed (already ran today) — nothing re-done. */
  replayed: string[]
}

/** Seams for the proof (in-memory): emit + propose default to the kernel survivors. */
export interface DevelopmentSeams {
  emit?: (input: { event: KernelEvent; brokerageId: string; entityType: string; entityId: string; metadata: Record<string, unknown>; agentId: string; client: unknown }) => Promise<unknown>
  propose?: (input: { brokerageId: string; agentId: string; subject: string; body: string; rationale: string }, svc: Svc) => Promise<{ ok: boolean }>
}

/** Run ONE development cycle for ONE agent (tenant from the agent row). Best-effort per step; never throws into the cron. */
export async function runAdaptiveDevelopmentCycle(
  svc: Svc, agent: CompetencyAgentRef, opts: { now?: Date; seams?: DevelopmentSeams } = {},
): Promise<DevelopmentCycleResult> {
  const now = opts.now ?? new Date()
  const day = now.toISOString().slice(0, 10)
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const out: DevelopmentCycleResult = { agentId: agent.id, weakest: [], underStrain: null, recommended: [], assessments: [], improved: [], overall: null, refusedRails: [], replayed: [] }
  const ledger = <T>(step: keyof typeof DEVELOPMENT_ACTION, detail: Record<string, unknown>, run: () => Promise<T>, idle: T) =>
    withActionLedger<T>({
      brokerageId: agent.brokerage_id, action: DEVELOPMENT_ACTION[step],
      actor: { type: "manager", managerKey: "recruiting_manager" }, subject: { type: "agent", id: agent.id },
      reasonCode: "LEARNED_IMPROVEMENT", systemSource: DEVELOPMENT_SIGNAL_SOURCE, riskClass: "LOW_RISK_WRITE",
      idempotencyKey: `${DEVELOPMENT_ACTION[step]}:${agent.id}:${day}`, detail,
    }, run, { settle: () => ({ status: "executed", outcome: "accepted" }), replay: () => { out.replayed.push(step); return idle } }, { client: svc as any })

  // ── 1. OBSERVE ──
  const profile = await loadAgentCompetency(svc, agent, now)
  out.refusedRails = profile.refusedRails; out.overall = profile.overall
  const { isAgentUnderStrain } = await import("@/lib/gamification/strain")
  out.underStrain = await isAgentUnderStrain(svc as any, agent.id)
  const weakest = observeWeakness(profile, { underStrain: out.underStrain === true })
  // The last ledgered update is the prior — the ledger is the loop's memory (no competency table).
  const { data: priorRows, error: priorErr } = await svc.from("agent_action_ledger").select("detail, created_at")
    .eq("brokerage_id", agent.brokerage_id).eq("action", DEVELOPMENT_ACTION.update).eq("subject_type", "agent").eq("subject_id", agent.id).eq("status", "executed")
    .order("created_at", { ascending: false }).limit(1)
  if (priorErr) out.refusedRails.push(`agent_action_ledger: ${priorErr.message}`)
  const prior = ((priorRows ?? [])[0] as { detail?: { scores?: Partial<Record<CompetencySkill, number | null>>; assessments?: DevelopmentCycleResult["assessments"] }; created_at?: string } | undefined) ?? null
  const priorAt = prior?.created_at ?? null
  out.weakest = await ledger("observe", { weakest: weakest.map((w) => ({ skill: w.skill, score: w.score, confidence: w.confidence, evidence: w.evidence })), under_strain: out.underStrain, overall: profile.overall, unproven: profile.unproven, refused_rails: profile.refusedRails, prior_at: priorAt }, async () => weakest, weakest)
  if (weakest.length === 0) {
    // Nothing weak with evidence: still ledger the update so the NEXT cycle has a prior to compare.
    await ledger("update", { scores: competencyScoreMap(profile), improved: [], prior_at: priorAt }, async () => null, null)
    return out
  }

  // ── 2. RECOMMEND — the catalog the learning router matches (gap_tags), one module per weakness ──
  const uid = agent.user_id
  out.recommended = await ledger("recommend", { for: weakest.map((w) => w.skill) }, async () => {
    const picks: DevelopmentCycleResult["recommended"] = []
    if (!uid) return picks
    const [{ data: tenantMods, error: e1 }, { data: platformMods, error: e2 }, { data: standing, error: e3 }] = await Promise.all([
      svc.from("learning_modules").select("id, title, gap_tags, display_priority").eq("status", "published").eq("brokerage_id", agent.brokerage_id).limit(500),
      svc.from("learning_modules").select("id, title, gap_tags, display_priority").eq("status", "published").is("brokerage_id", null).limit(500),
      svc.from("learning_assignments").select("module_id, status, dismissed_at").eq("brokerage_id", agent.brokerage_id).eq("agent_user_id", uid).is("contact_id", null).limit(1000),
    ])
    for (const [n, e] of [["learning_modules", e1], ["learning_modules", e2], ["learning_assignments", e3]] as const) if (e) out.refusedRails.push(`${n}: ${e.message}`)
    if (e3) return picks // cannot see what stands → do not assign (fail closed on the write)
    const mods = [...(tenantMods ?? []), ...(platformMods ?? [])] as Array<{ id: string; title: string; gap_tags: string[] | null; display_priority: number | null }>
    const have = new Map((standing ?? []).map((a: any) => [a.module_id as string, a]))
    for (const w of weakest) {
      const tag = COMPETENCY_GAP_TAG[w.skill]
      const pick = mods.filter((m) => (m.gap_tags ?? []).includes(tag) && !(have.get(m.id)?.status === "completed") && !have.get(m.id)?.dismissed_at)
        .sort((a, b) => (b.display_priority ?? 0) - (a.display_priority ?? 0) || a.title.localeCompare(b.title))[0]
      if (!pick) continue
      let assigned = false
      if (!have.has(pick.id)) {
        const { error } = await svc.from("learning_assignments").insert({
          brokerage_id: agent.brokerage_id, agent_user_id: uid, module_id: pick.id, contact_id: null, status: "open",
          signal_source: DEVELOPMENT_SIGNAL_SOURCE, priority_score: Math.max(1, 100 - w.score),
          signal_metadata: { competency: w.skill, score: w.score, evidence: w.evidence, gap_tag: tag, cycle: day },
        })
        if (error) out.refusedRails.push(`learning_assignments.insert: ${error.message}`); else assigned = true
      }
      picks.push({ skill: w.skill, moduleId: pick.id, title: pick.title, assigned })
    }
    return picks
  }, [])

  // ── 3. ASSESS — the simulation's stored result, or ONE gated nudge to run it. A skill the LAST cycle
  //      asked to assess is read too even if it is no longer weak: the stored result is the loop's
  //      assessment evidence whether or not the activity since already lifted the score. ──
  const pendingPrior = (prior?.detail?.assessments ?? []).filter((a) => a.score == null).map((a) => a.skill)
  const toAssess: Array<ObservedWeakness | { skill: CompetencySkill; readOnly: true }> = [...weakest, ...pendingPrior.filter((s) => !weakest.some((w) => w.skill === s)).map((skill) => ({ skill, readOnly: true as const }))]
  out.assessments = await ledger("assess", { for: toAssess.map((w) => w.skill) }, async () => {
    const rows: DevelopmentCycleResult["assessments"] = []
    if (!uid) return rows
    const monthKey = day.slice(0, 7)
    for (const w of toAssess) {
      const a = composeAssessment(w.skill)
      if (!a) continue // no simulation for this competency — the recommendation stands alone (honest)
      let q = svc.from("objection_training_sessions").select("total_score, completed_at").eq("brokerage_id", agent.brokerage_id).eq("agent_user_id", uid)
        .eq("scenario_key", a.scenarioKey).not("completed_at", "is", null)
      if (priorAt) q = q.gte("completed_at", priorAt)
      const { data: done, error } = await q.order("completed_at", { ascending: false }).limit(1)
      if (error) { out.refusedRails.push(`objection_training_sessions: ${error.message}`); continue }
      const latest = (done ?? [])[0] as { total_score: number | null } | undefined
      if (latest && typeof latest.total_score === "number") { rows.push({ skill: w.skill, scenarioKey: a.scenarioKey, score: latest.total_score, nudged: false }); continue }
      if ("readOnly" in w) continue // no longer weak and nothing stored: nothing to nudge
      const dedupeTag = `DEVELOPMENT ASSESSMENT — agent:${agent.id} — ${w.skill} — ${monthKey}`
      const rationale = `${dedupeTag} — review before it reaches the agent.`
      const { data: priorNudge } = await svc.from("agent_client_messages").select("id").eq("brokerage_id", agent.brokerage_id).eq("entity_type", "agent").eq("entity_id", agent.id)
        .eq("agent_kind", "recruiting_manager").eq("rationale", rationale).limit(1).maybeSingle()
      let nudged = false
      if (!priorNudge) {
        const propose = opts.seams?.propose ?? (async (input, client) => {
          const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
          return proposeClientMessage({ brokerageId: input.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: input.agentId, recipientContactId: null, audience: "agent", subject: input.subject, body: input.body, rationale: input.rationale, channel: "portal" }, client as any)
        })
        try {
          const r = await propose({
            brokerageId: agent.brokerage_id, agentId: agent.id,
            subject: `Development focus: ${w.label.toLowerCase()} — run the "${a.label}" assessment`,
            body: [`${w.label} scores ${w.score}/100 on the evidence (${w.evidence.join("; ")}).`, `Run the "${a.label}" simulation in Training — it assesses exactly this skill against ${a.rubric.length} criteria, and the result updates your competency model.`].join("\n\n"),
            rationale,
          }, svc)
          nudged = r.ok
        } catch { /* best-effort */ }
      }
      rows.push({ skill: w.skill, scenarioKey: a.scenarioKey, score: null, nudged })
    }
    return rows
  }, [])

  // ── 4-7. ACTIVITY + OUTCOME are the evidence; UPDATE compares against the last ledgered cycle ──
  const deltas = competencyDeltas(prior?.detail?.scores ?? null, profile)
  const improved = improvedCompetencies(deltas, profile)
  out.improved = await ledger("update", { scores: competencyScoreMap(profile), improved: improved.map((d) => ({ skill: d.skill, before: d.before, after: d.after, delta: d.delta })), prior_at: priorAt, assessments: out.assessments }, async () => {
    const res: DevelopmentCycleResult["improved"] = []
    const { entityIdForKey, deriveCompetencyEdges } = await import("@/lib/kernel/relationship-graph")
    const emit = opts.seams?.emit ?? (async (input) => { const { emitKernelEvent } = await import("@/lib/kernel/emit"); return emitKernelEvent(input as any) })
    for (const d of improved) {
      try {
        await emit({ event: KernelEvent.COMPETENCY_IMPROVED, brokerageId: agent.brokerage_id, entityType: "competency", entityId: entityIdForKey("competency", d.skill), agentId: agent.id, client: svc,
          metadata: { agent_id: agent.id, skill: d.skill, before: d.before, after: d.after, delta: d.delta, prior_at: priorAt } })
        res.push({ skill: d.skill, before: d.before as number, after: d.after as number })
      } catch (e) { out.refusedRails.push(`emit: ${(e as Error).message}`) }
    }
    if (uid) {
      const r = await deriveCompetencyEdges(svc, { brokerageId: agent.brokerage_id, agentUserId: uid, skills: profile.skills.map((s) => ({ skill: s.skill, score: s.score, confidence: s.confidence })), threshold: COMPETENCY_GAP_SCORE, now })
      if (r.errors.length > 0 && !r.degraded) out.refusedRails.push(`has_competency: ${r.errors.join("; ")}`)
    }
    return res
  }, [])
  return out
}

/** Autonomous: one development cycle per active agent per brokerage (rides the daily onboarding-reminders cron, after the radar). */
export async function runAdaptiveDevelopmentAll(svc: Svc, now?: Date): Promise<{ brokerages: number; agents: number; recommended: number; nudged: number; improved: number }> {
  const out = { brokerages: 0, agents: 0, recommended: 0, nudged: 0, improved: 0 }
  const { data: rows, error } = await svc.from("brokerages").select("id").limit(1000)
  if (error) { console.error("[adaptive-development] brokerages read refused:", error.message); return out }
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    const { data: agents, error: aErr } = await svc.from("agents").select("id, user_id").eq("brokerage_id", b.id).eq("is_active", true).not("user_id", "is", null).limit(1000)
    if (aErr) { console.error(`[adaptive-development] agents read refused for ${b.id}:`, aErr.message); continue }
    for (const a of (agents ?? []) as Array<{ id: string; user_id: string | null }>) {
      try {
        const r = await runAdaptiveDevelopmentCycle(svc, { id: a.id, user_id: a.user_id, brokerage_id: b.id }, { now })
        out.agents++; out.recommended += r.recommended.filter((x) => x.assigned).length; out.nudged += r.assessments.filter((x) => x.nudged).length; out.improved += r.improved.length
      } catch (e) { console.error(`[adaptive-development] cycle failed for agent ${a.id}:`, (e as Error).message) }
    }
  }
  return out
}
