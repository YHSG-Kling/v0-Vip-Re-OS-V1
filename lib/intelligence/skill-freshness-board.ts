// lib/intelligence/skill-freshness-board.ts
//
// THE SKILL-FRESHNESS BOARD — the education loop made visible in the one Command Center. The radar nudges
// individual agents to refresh a decayed skill; this rolls the whole roster into a board so a broker sees
// team competency at a glance: how many agents have a stale skill, who's rustiest, and in what. Reads the
// same real last-practice signals the radar uses. Read-only; best-effort; no model narration in the numbers.

import { createServiceClient } from "@/lib/supabase/service"
import { computeSkillFreshness, SKILL_LABEL, type CompetencyProfile } from "@/lib/education/skill-freshness"
import { gatherSkillSignals, loadAgentCompetency } from "@/lib/education/skill-freshness-radar"

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
  /** Wave 103 (103A): the roster's COMPETENCY read beside freshness — agents carrying at least one
   *  gap (score ≤ COMPETENCY_GAP_SCORE), the most common gap skill, lowest agents first. Absent
   *  (undefined) when the competency read was not made, never zero-faked. */
  competency?: { scored: number; withGaps: number; topGap: string | null; agents: Array<{ agentId: string; name: string; overall: number | null; gaps: string[] }> }
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

/** PURE: fold per-agent competency profiles into the board's competency tally (lowest overall first).
 *  @proofSeam the roster fold is asserted in-memory by scripts/competency-guard.ts (no database);
 *  its only product caller is generateSkillFreshnessBoard in this file. */
export function summarizeCompetencyBoard(
  profiles: Array<{ agentId: string; name: string; profile: CompetencyProfile }>,
  cap = 8,
): NonNullable<SkillFreshnessBoard["competency"]> {
  const gapCount = new Map<string, number>()
  const rows = profiles.map((p) => {
    for (const g of p.profile.gaps) gapCount.set(g.label, (gapCount.get(g.label) ?? 0) + 1)
    return { agentId: p.agentId, name: p.name, overall: p.profile.overall, gaps: p.profile.gaps.map((g) => `${g.label} ${g.score}/100`) }
  })
  const withGaps = rows.filter((r) => r.gaps.length > 0)
  withGaps.sort((a, b) => (a.overall ?? 101) - (b.overall ?? 101) || a.name.localeCompare(b.name))
  const top = [...gapCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return { scored: profiles.length, withGaps: withGaps.length, topGap: top ? top[0] : null, agents: withGaps.slice(0, cap) }
}

// TOMBSTONE (wave 103, lane 103A — CLAUDE.md §1.1): the local `daysSince` and the inline
// objection/quiz/coursework signal reads that lived here were a byte-identical copy of
// lib/education/skill-freshness-radar.ts:gatherSkillSignals (now exported) — merged onto it.

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

    const named = list.map((a) => {
      const u = Array.isArray(a.users) ? a.users[0] : a.users
      return { id: a.id as string, user_id: (a.user_id ?? null) as string | null, name: [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "An agent" }
    })
    const reports = await Promise.all(named.map(async (a) => ({
      agentId: a.id, name: a.name, skills: computeSkillFreshness(await gatherSkillSignals(supabase, a, now)),
    })))
    const board = summarizeSkillBoard(reports)

    // COMPETENCY beside freshness (wave 103). Per-agent reads, capped so the board stays a glance;
    // a failure leaves the field absent rather than publishing a half-scored roster.
    try {
      const profiles = await Promise.all(named.slice(0, 50).map(async (a) => ({
        agentId: a.id, name: a.name, profile: await loadAgentCompetency(supabase, { id: a.id, user_id: a.user_id, brokerage_id: brokerageId }, now),
      })))
      board.competency = summarizeCompetencyBoard(profiles)
    } catch (err) {
      console.error("[skill-freshness-board] competency read failed (field left absent):", err)
    }
    return board
  } catch (err) {
    console.error("[skill-freshness-board] failed:", err)
    return null
  }
}
