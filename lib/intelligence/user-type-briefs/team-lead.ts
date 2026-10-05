// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published generateTeamLeadBrief({ userId, brokerageId }) and
// isTeamLead(userId, brokerageId) as public HTTP doors with no gate: a service
// client over a caller-supplied brokerageId — section 4's named IDOR shape.
// Every caller is in-process server code (re-verified 2026-09-03):
//   · lib/intelligence/user-type-briefs/index.ts:16 and :25 (the barrel), whose
//     value importers are app/actions/briefing-actions.ts:12 ("use server") and
//     the server pages app/dashboard/{coordinator,brokerage,compliance}/page.tsx,
//     app/vendor/dashboard/page.tsx, app/lender/dashboard/page.tsx; the two
//     "use client" importers of the barrel take TYPES only (erased)
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
// brokerageId / userId are now an IN-PROCESS CONTRACT: with the door closed,
// the server caller that supplies them is the gate.
import "server-only"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

/**
 * Team Lead brief — agents who lead a team get the agent brief PLUS
 * team-level signals (their team members' pipeline, fatigue, performance).
 *
 * Identification: a user is a team lead if any row in `teams` has
 * team_lead_id = users.id. They keep user_type='agent' but see expanded data.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import type { UserTypeBrief, BriefPriority, BriefMetric } from "./types"
import { parseMarketPulseMetrics as parseMarketPulse } from "./types"

export async function generateTeamLeadBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)

  // Cache check
  if (!params.forceRegenerate) {
    const { data: cached } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("user_id", params.userId)
      .eq("briefing_date", today)
      .maybeSingle()
    if (cached) {
      const c = cached as unknown as {
        agent_id: string; brokerage_id: string; briefing_date: string;
        summary: string; top_priority_actions: BriefPriority[]; market_pulse: string; generated_at: string
      }
      return {
        userId: c.agent_id,
        userType: "team_lead",
        brokerageId: c.brokerage_id,
        briefingDate: c.briefing_date,
        summary: c.summary,
        priorities: c.top_priority_actions ?? [],
        metrics: parseMarketPulse(c.market_pulse),
        generatedAt: c.generated_at,
        cached: true,
      }
    }
  }

  // Find which team(s) this user leads (live teams only)
  const { data: teams } = await supabase
    .from("teams")
    .select("id, name")
    .eq("team_lead_id", params.userId)
    .eq("brokerage_id", params.brokerageId)
    .is("deleted_at", null)

  const teamIds = (teams ?? []).map((t: { id: string }) => t.id)

  // Team membership lives on agents.team_id — the SAME source assignment routing
  // uses (the old users.team_id query returned users.id, which never matched
  // contacts.agent_id (agents.id) → team hot contacts always read 0, and the
  // deal-risk embed joined transactions→users through the wrong FK).
  const teamAgentIds = await getTeamAgentIds(teamIds)
  const teamMemberCount = teamAgentIds.length

  // Deals at risk for the team: transactions.agent_id is agents.id — two clean
  // steps instead of a fragile nested embed.
  let dealsAtRisk: Array<{ transaction_id: string; overall_score: number; risk_level: string; property_address: string | null }> = []
  let teamHotContacts = 0
  let isaHandoffs: Array<{ agent_id: string; claimed: boolean }> = []
  if (teamAgentIds.length > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const [txRes, hotRes, handoffRes] = await Promise.all([
      supabase
        .from("transactions")
        .select("id, property_address")
        .in("agent_id", teamAgentIds)
        .not("stage", "in", '("closed","cancelled")')
        .limit(100),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .in("agent_id", teamAgentIds)
        // 'hot' is a TEMPERATURE, not a status — nothing ever wrote it to
        // contacts.status, so this team count was permanently 0; the flag lives
        // on contacts.lead_temperature (live CHECK: cold/hot/warm).
        .eq("lead_temperature", "hot"),
      // AI ISA manager: overnight qualified handoffs INTO this team (tier-scoped).
      supabase
        .from("assignment_log")
        .select("agent_id, claimed")
        .in("agent_id", teamAgentIds)
        .gte("created_at", since),
    ])
    teamHotContacts = (hotRes as { count: number | null }).count ?? 0
    isaHandoffs = ((handoffRes.data ?? []) as Array<{ agent_id: string; claimed: boolean }>)
    const txRows = (txRes.data ?? []) as Array<{ id: string; property_address: string | null }>
    if (txRows.length > 0) {
      const { data: healthRows } = await supabase
        .from("deal_health_scores")
        .select("transaction_id, overall_score, risk_level")
        .in("transaction_id", txRows.map((t) => t.id))
        .in("risk_level", ["critical", "at_risk"])
        .order("overall_score", { ascending: true })
        .limit(5)
      dealsAtRisk = ((healthRows ?? []) as Array<{ transaction_id: string; overall_score: number; risk_level: string }>)
        .map((h) => ({
          ...h,
          property_address: txRows.find((t) => t.id === h.transaction_id)?.property_address ?? null,
        }))
    }
  }

  const priorities: BriefPriority[] = []

  // WAVE 103 (lane 103B) — EXCEPTIONS FIRST: team members over / at capacity (the ONE kernel
  // answer, capacityFor) and the guardian's open reassignment suggestions lead the brief, ahead
  // of handoffs and deal risk — a lead handed to an agent with no headroom is the next stale
  // contact. Best-effort: a refused read leaves the brief without the row, never "all clear".
  if (teamAgentIds.length > 0) {
    try {
      const { capacityFor, resolveBrokerageMaxLoad } = await import("@/lib/lead-assignment/capacity-pick")
      const { hasHeadroom, AGENT_REASSIGNMENT_SUGGESTED_SIGNAL } = await import("@/lib/kernel/capacity-guardian")
      const maxLoad = await resolveBrokerageMaxLoad(supabase, params.brokerageId)
      const exceptions: Array<{ agentId: string; band: string; load: number; reasons: string[] }> = []
      for (const agentId of teamAgentIds.slice(0, 50)) {
        const cap = await capacityFor(supabase, params.brokerageId, agentId, { maxLoad })
        if (!hasHeadroom(cap.band)) exceptions.push({ agentId, band: cap.band, load: cap.load, reasons: cap.reasons })
      }
      const { data: suggested, error: suggestedErr } = await supabase
        .from("manager_signals").select("entity_id, payload")
        .eq("brokerage_id", params.brokerageId).eq("signal_type", AGENT_REASSIGNMENT_SUGGESTED_SIGNAL)
        .eq("status", "open").in("entity_id", teamAgentIds).limit(20)
      if (suggestedErr) console.error(`[team-lead-brief] reassignment suggestions read refused: ${suggestedErr.message}`)
      const suggestions = (suggested ?? []) as Array<{ entity_id: string | null; payload: { daysOver?: number } | null }>
      if (exceptions.length > 0 || suggestions.length > 0) {
        const over = exceptions.filter((e) => e.band === "over")
        const top = over[0] ?? exceptions[0]
        priorities.push({
          id: "team-capacity-exceptions",
          title: exceptions.length > 0
            ? `${exceptions.length} team member${exceptions.length === 1 ? "" : "s"} ${over.length > 0 ? "over" : "at"} capacity`
            : `${suggestions.length} books reassignment${suggestions.length === 1 ? "" : "s"} awaiting your approval`,
          body: [
            top ? `Heaviest: ${top.load} active items (${top.band.replace("_", " ")})${top.reasons.length ? ` — ${top.reasons.slice(0, 2).join("; ")}` : ""}` : null,
            suggestions.length > 0 ? `${suggestions.length} temporary cover suggestion${suggestions.length === 1 ? "" : "s"} proposed (over ${suggestions[0].payload?.daysOver ?? "several"} days running) — approve to rebalance the book` : null,
          ].filter(Boolean).join(". "),
          severity: over.length > 0 || suggestions.length > 0 ? "high" : "medium",
          manager: "recruiting_manager",
          ctas: [{ label: "Rebalance books", href: "/dashboard/team" }],
        })
      }
    } catch (e) {
      console.error(`[team-lead-brief] capacity exceptions failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // AI ISA manager — unclaimed qualified handoffs into the team lead the brief
  // (canonical process: qualification converted them to team members' contacts).
  const unclaimedHandoffs = isaHandoffs.filter((h) => !h.claimed).length
  if (isaHandoffs.length > 0) {
    priorities.push({
      id: "team-isa-handoffs",
      title: `AI ISA handed your team ${isaHandoffs.length} qualified lead${isaHandoffs.length === 1 ? "" : "s"} overnight`,
      body: unclaimedHandoffs > 0
        ? `${unclaimedHandoffs} awaiting first touch — chase speed-to-first-touch this morning`
        : "All claimed — follow up on first-touch quality",
      severity: unclaimedHandoffs > 0 ? "high" : "medium",
      manager: "ai_isa",
      // /dashboard/team-lead never had a page.tsx. The team console is
      // app/dashboard/team/page.tsx, whose boardScopeFor() gives user_type
      // 'team_lead' the TEAM tier — their own board, exactly this brief's reader.
      // (ROUTE_ALIASES already maps the other misspelling, /dashboard/teams → it.)
      ctas: [{ label: "Open team pipeline", href: "/dashboard/team" }],
    })
  }

  if (dealsAtRisk.length > 0) {
    priorities.push({
      id: `team-deals-risk`,
      title: `${dealsAtRisk.length} team deal${dealsAtRisk.length === 1 ? "" : "s"} at risk`,
      body: `Most critical: ${dealsAtRisk[0].property_address ?? "unknown"} (score ${Math.round(dealsAtRisk[0].overall_score)})`,
      severity: dealsAtRisk[0].risk_level === "critical" ? "critical" : "high",
      manager: "deal_coordinator",
      ctas: [{ label: "Open team pipeline", href: "/dashboard/team" }],
    })
  }

  if (teamMemberCount > 0) {
    priorities.push({
      id: "team-coaching",
      title: `${teamMemberCount} team member${teamMemberCount === 1 ? "" : "s"}`,
      body: teamHotContacts > 0
        ? `${teamHotContacts} hot contacts across the team — schedule 1:1s with members carrying the most`
        : `Pipeline stable — good time for skill-building 1:1s`,
      severity: "medium",
      ctas: [{ label: "View team", href: "/dashboard/team" }],
    })
  }

  // WAVE 103 (lane 103A) — THE TEAM'S COMPETENCY GAPS. The ONE competency model
  // (lib/education/skill-freshness.ts:scoreCompetency via loadAgentCompetency) read for each team
  // member; the lead sees who scores at or below the gap line and on what, so the 1:1 above has a
  // subject. Capped to 25 members (a brief, not a census); a refused read leaves the line out.
  let competencyGapAgents: Array<{ name: string; gaps: string[] }> = []
  if (teamAgentIds.length > 0) {
    try {
      const { loadAgentCompetency } = await import("@/lib/education/skill-freshness-radar")
      const { data: members } = await supabase
        .from("agents").select("id, user_id, users(first_name, last_name)")
        .in("id", teamAgentIds.slice(0, 25)).eq("brokerage_id", params.brokerageId)
      for (const m of (members ?? []) as any[]) {
        const p = await loadAgentCompetency(supabase, { id: m.id, user_id: m.user_id ?? null, brokerage_id: params.brokerageId })
        if (p.gaps.length === 0) continue
        const u = Array.isArray(m.users) ? m.users[0] : m.users
        const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "A team member"
        competencyGapAgents.push({ name, gaps: p.gaps.slice(0, 2).map((g) => `${g.label} ${g.score}/100`) })
      }
    } catch (e) {
      console.error("[team-lead-brief] competency read failed (line left out):", (e as Error).message)
    }
  }
  if (competencyGapAgents.length > 0) {
    priorities.push({
      id: "team-competency",
      title: `${competencyGapAgents.length} team member${competencyGapAgents.length === 1 ? " has" : "s have"} a competency gap`,
      body: competencyGapAgents.slice(0, 3).map((a) => `${a.name}: ${a.gaps.join(", ")}`).join(" · ") + " — the Academy has queued a module for each gap; make it the 1:1 topic",
      severity: "medium",
      manager: "recruiting_manager",
      ctas: [{ label: "View team", href: "/dashboard/team" }],
    })
  }
  // Points tiers across the team (wave 103, lane 103C): the team lead sees the
  // team board (ruling #191) and the brief carries its tier mix. A refused read
  // reads as "—".
  let teamTiersLine = "—"
  if (teamAgentIds.length > 0) {
    const { data: tierRows, error: tierErr } = await supabase
      .from("agents")
      .select("gamification_points")
      .in("id", teamAgentIds)
      .limit(5000)
    if (tierErr) console.error(`[TeamLeadBrief] team tier read refused: ${tierErr.message}`)
    else {
      const { tierDistributionLine } = await import("@/lib/gamification/tiers")
      teamTiersLine = tierDistributionLine(((tierRows ?? []) as Array<{ gamification_points: number | null }>).map((r) => r.gamification_points))
    }
  }

  const metrics: BriefMetric[] = [
    { label: "Team members", value: teamMemberCount },
    { label: "Team deals at risk", value: dealsAtRisk.length },
    { label: "Team hot contacts", value: teamHotContacts },
    { label: "Team tiers", value: teamTiersLine, href: "/dashboard/intelligence" },
    ...(isaHandoffs.length > 0 ? [{ label: "ISA handoffs (24h)", value: isaHandoffs.length }] : []),
    ...(teamMemberCount > 0 ? [{ label: "Competency gaps", value: competencyGapAgents.length }] : []),
  ]

  let summary = "Team running normally — focus on coaching and pipeline review."
  if (priorities.length > 0) {
    try {
      const { text } = await generateTextRouted({
        brokerageId: params.brokerageId,
        userId: params.userId,
        feature: "coaching_insight",
        prompt:
          `One-sentence morning brief for a real estate team lead. ` +
          `Priorities: ${priorities.map((p) => p.title).join(" · ")}. ` +
          `Tone: direct. Under 25 words.`,
        temperature: 0.4,
        maxTokens: 80,
      })
      summary = text.trim().replace(/^["']|["']$/g, "")
    } catch {
      summary = priorities.map((p) => p.title).slice(0, 2).join("; ")
    }
  }

  // ai_daily_briefings has no unique constraint on (agent_id, briefing_date) — the
  // previous onConflict upsert errored (42P10) and the team-lead brief NEVER cached
  // (full regeneration + AI spend every view). Select-then-write, keyed on user_id.
  const briefRow = {
    user_id: params.userId,
    brokerage_id: params.brokerageId,
    briefing_date: today,
    summary,
    top_priority_actions: priorities,
    market_pulse: JSON.stringify(metrics),
    ai_model_used: "claude-sonnet-routed",
    generated_at: new Date().toISOString(),
  }
  const { data: existingBrief } = await supabase
    .from("ai_daily_briefings")
    .select("id")
    .eq("user_id", params.userId)
    .eq("briefing_date", today)
    .maybeSingle()
  if (existingBrief?.id) {
    await sentinelWrite(supabase, supabase.from("ai_daily_briefings").update(briefRow).eq("id", existingBrief.id), { table: "ai_daily_briefings", flow: "ai_daily_briefings_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
  } else {
    await sentinelWrite(supabase, supabase.from("ai_daily_briefings").insert(briefRow), { table: "ai_daily_briefings", flow: "ai_daily_briefings_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
  }

  return {
    userId: params.userId,
    userType: "team_lead",
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

async function getTeamAgentIds(teamIds: string[]): Promise<string[]> {
  if (teamIds.length === 0) return []
  const supabase = createServiceClient()
  // agents.team_id is the authoritative membership (same source assignment uses);
  // returns agents.id — the ID space contacts.agent_id / transactions.agent_id key on.
  const { data } = await supabase
    .from("agents").select("id").in("team_id", teamIds).eq("is_active", true)
  return ((data ?? []) as Array<{ id: string }>).map((a) => a.id)
}

// TOMBSTONE: local parseMarketPulse merged onto
// lib/intelligence/user-type-briefs/types.ts parseMarketPulseMetrics
// (imported above as `parseMarketPulse`) — §1/§6 SAME BODY census round 3,
// 2026-09-09.

/** Detect whether a user is a team lead (leads any team in their brokerage) */
export async function isTeamLead(userId: string, brokerageId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("teams")
    .select("id")
    .eq("team_lead_id", userId)
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
  return !!data
}
