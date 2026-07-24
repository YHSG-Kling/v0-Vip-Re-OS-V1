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
import { computeSkillFreshness, SKILL_LABEL, type SkillArea, type SkillSignal } from "@/lib/education/skill-freshness"

type Svc = ReturnType<typeof createServiceClient>

/** A tenured agent (past onboarding) who has NEVER proven a skill is worth a first nudge; a brand-new
 *  agent is left alone (they're still onboarding — untested is expected, not a gap). */
export const UNTESTED_TENURE_DAYS = 45

const daysSince = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/** Gather the last-practice signal for one agent across the three skill areas (best-effort). */
async function gatherSkillSignals(svc: Svc, agent: { id: string; user_id: string | null }, now: Date): Promise<SkillSignal[]> {
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

export interface SkillRadarResult { scanned: number; nudged: number; staleSkills: number }

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
      const cta = skill.area === "objection_handling"
        ? "Run a 5-minute objection drill — I've queued a fresh scenario for you."
        : skill.area === "product_knowledge"
          ? "Take a quick knowledge check to lock it back in."
          : "Revisit the course refresher — a short review keeps it current."
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
