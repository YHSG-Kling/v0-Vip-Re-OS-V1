// lib/intelligence/skill-freshness-board.ts
//
// THE SKILL-FRESHNESS BOARD — the education loop made visible in the one Command Center. The radar nudges
// individual agents to refresh a decayed skill; this rolls the whole roster into a board so a broker sees
// team competency at a glance: how many agents have a stale skill, who's rustiest, and in what. Reads the
// same real last-practice signals the radar uses. Read-only; best-effort; no model narration in the numbers.

import { createServiceClient } from "@/lib/supabase/service"
import { computeSkillFreshness, SKILL_LABEL, type SkillArea, type SkillSignal } from "@/lib/education/skill-freshness"

type Svc = ReturnType<typeof createServiceClient>

export interface SkillBoardAgent {
  agentId: string
  name: string
  /** The stalest skill's status for this agent (stale > untested > aging). */
  worst: "stale" | "untested" | "aging"
  /** The skill areas that need attention, human-labeled. */
  areas: string[]
}

export interface SkillFreshnessBoard {
  scored: number
  /** Agents with at least one STALE skill. */
  needRefresh: number
  /** Agents whose only gaps are untested (never practiced) skills. */
  unproven: number
  /** Agents whose skills are all fresh. */
  sharp: number
  /** Worst-first, capped for the card. */
  agents: SkillBoardAgent[]
}

const WORST_RANK: Record<string, number> = { stale: 0, untested: 1, aging: 2 }

/** PURE: fold per-agent freshness reports into the board (agent id + name + its computed skills). */
export function summarizeSkillBoard(
  reports: Array<{ agentId: string; name: string; skills: ReturnType<typeof computeSkillFreshness> }>,
  cap = 8,
): SkillFreshnessBoard {
  let needRefresh = 0, unproven = 0, sharp = 0
  const agents: SkillBoardAgent[] = []
  for (const r of reports) {
    const stale = r.skills.skills.filter((s) => s.status === "stale")
    const aging = r.skills.skills.filter((s) => s.status === "aging")
    const untested = r.skills.skills.filter((s) => s.status === "untested")
    if (stale.length > 0) {
      needRefresh++
      agents.push({ agentId: r.agentId, name: r.name, worst: "stale", areas: stale.map((s) => SKILL_LABEL[s.area]) })
    } else if (r.skills.overall === "unproven") {
      unproven++
      agents.push({ agentId: r.agentId, name: r.name, worst: "untested", areas: untested.map((s) => SKILL_LABEL[s.area]) })
    } else if (aging.length > 0) {
      agents.push({ agentId: r.agentId, name: r.name, worst: "aging", areas: aging.map((s) => SKILL_LABEL[s.area]) })
      sharp++ // aging still counts as broadly sharp for the headline tally
    } else {
      sharp++
    }
  }
  agents.sort((a, b) => (WORST_RANK[a.worst] ?? 9) - (WORST_RANK[b.worst] ?? 9) || a.name.localeCompare(b.name))
  return { scored: reports.length, needRefresh, unproven, sharp, agents: agents.slice(0, cap) }
}

const daysSince = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/** Build the board for a brokerage's active agents. Best-effort → null on failure. */
export async function generateSkillFreshnessBoard(
  brokerageId: string, client?: Svc,
): Promise<SkillFreshnessBoard | null> {
  const supabase = client ?? createServiceClient()
  try {
    const now = new Date()
    const { data: agents } = await supabase.from("agents")
      .select("id, user_id, users(first_name, last_name)").eq("brokerage_id", brokerageId).eq("is_active", true).not("user_id", "is", null).limit(1000)
    const list = (agents ?? []) as any[]
    if (list.length === 0) return { scored: 0, needRefresh: 0, unproven: 0, sharp: 0, agents: [] }

    const reports = await Promise.all(list.map(async (a) => {
      const [obj, quiz, course] = await Promise.all([
        a.user_id ? supabase.from("objection_training_sessions").select("completed_at, total_score").eq("agent_user_id", a.user_id).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
        supabase.from("agent_quiz_attempts").select("created_at, score, passed").eq("agent_id", a.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("agent_courses").select("completed_at, score").eq("agent_id", a.id).eq("status", "completed").not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle(),
      ])
      const o = (obj as any).data, q = (quiz as any).data, c = (course as any).data
      const signals: SkillSignal[] = [
        { area: "objection_handling", lastPracticedDays: daysSince(o?.completed_at, now), lastScore: o?.total_score ?? null },
        { area: "product_knowledge", lastPracticedDays: daysSince(q?.created_at, now), lastScore: q ? (q.passed === false ? Math.min(q.score ?? 0, 50) : q.score ?? null) : null },
        { area: "coursework", lastPracticedDays: daysSince(c?.completed_at, now), lastScore: c?.score ?? null },
      ]
      const u = Array.isArray(a.users) ? a.users[0] : a.users
      const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "An agent"
      return { agentId: a.id, name, skills: computeSkillFreshness(signals) }
    }))

    return summarizeSkillBoard(reports)
  } catch (err) {
    console.error("[skill-freshness-board] failed:", err)
    return null
  }
}
