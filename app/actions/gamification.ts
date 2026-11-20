"use server"

// app/actions/gamification.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT-FACING GAMIFICATION READS + THE BADGE AWARDER.
//
// "use server" IS NEW AND IT IS NOT COSMETIC. This module is imported directly by
// CLIENT components (app/dashboard/motivation/motivation-client.tsx and
// app/academy/components/os/embedded-leaderboard-widget.tsx; the third,
// app/lib/gamification/award-on-action.ts, was retired in wave 153) while itself importing
// @/lib/supabase/server, which reaches for next/headers. Without the directive
// these are not server actions at all — the module is pulled into the client
// bundle and the import fails. The Motivation surface could not have rendered
// whatever the data said. POINT_VALUES moved to lib/gamification/award-points.ts
// because a "use server" module may only export async functions, and that is its
// right home anyway: it is award vocabulary, not a read.
//
// Everything the leaderboard reads now comes from ONE vocabulary module
// (lib/gamification/leaderboard-vocabulary.ts) shared with the populator, and the
// tier ladder from ONE module (lib/gamification/tiers.ts) shared with Agent 360
// and the Intelligence page.

import { createClient } from "@/lib/supabase/server"
import {
  isLeaderboardScope,
  isLeaderboardMetric,
  isCanonicalPeriodLabel,
  defaultPeriodLabel,
  monthLabel,
  type LeaderboardRow,
} from "@/lib/gamification/leaderboard-vocabulary"
import { tierForPoints, tierLabelForPoints, nextTierForPoints, tierProgressPercent } from "@/lib/gamification/tiers"

// The embed every board read shares. `agents` carries no name of its own — a
// person's name is on `users`, reached through the single agents_user_id_fkey, so
// the embed is an OBJECT.
const RANKING_SELECT = `
  id,
  rank_position,
  metric_type,
  metric_value,
  agent_id,
  team_id,
  brokerage_id,
  scope,
  period_label,
  computed_at,
  agents:agent_id(id, gamification_points, photo_url, profile_image_url, users:user_id(first_name, last_name))
`

function toLeaderboardRow(row: any, currentAgentId: string | null): LeaderboardRow {
  const a = row?.agents ?? null
  const u = a?.users ?? null
  const name = `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim()
  return {
    agentId: row.agent_id,
    agentName: name || "Agent",
    avatarUrl: a?.photo_url ?? a?.profile_image_url ?? null,
    rank: Number(row.rank_position) || 0,
    score: Number(row.metric_value) || 0,
    lifetimePoints: Number(a?.gamification_points) || 0,
    isCurrentAgent: !!currentAgentId && row.agent_id === currentAgentId,
  }
}

// ─── GET AGENT BADGES ─────────────────────────────────────────────────────────
/**
 * The badge catalog with this agent's awards folded in — ONE list, each row
 * carrying whether it is earned. It used to return `{ earned, all, earnedBadgeIds }`
 * where earnedBadgeIds was a `Set`, and the Motivation page consumed the whole
 * object as if it were an array (`badges.filter(...)`), so the Badges Showcase
 * rendered empty no matter what was awarded.
 */
export async function getAgentBadges(agentId: string): Promise<{
  ok: boolean
  badges: Array<{
    id: string
    badgeId: string
    name: string
    description: string | null
    icon: string | null
    tier: string | null
    category: string | null
    requiredPoints: number
    earned: boolean
    earnedAt: string | null
    /** Earned on a milestone (trigger_event), not on a points total. */
    milestone: boolean
    /** False when no live rule awards this badge's milestone — shown as unavailable, never as earnable. */
    available: boolean
  }>
  error?: string
}> {
  if (!agentId) return { ok: true, badges: [] }
  const supabase = await createClient()

  const [{ data: earnedRows, error: earnedError }, { data: catalog, error: catalogError }] = await Promise.all([
    supabase
      .from("agent_badges")
      .select("id, badge_id, awarded_at, awarded_reason")
      .eq("agent_id", agentId)
      .order("awarded_at", { ascending: false }),
    supabase
      .from("gamification_badges")
      .select("id, badge_name, badge_description, badge_icon, badge_tier, badge_category, required_points, trigger_event")
      .eq("is_active", true)
      .order("required_points", { ascending: true }),
  ])
  // WAVE 155 (155C): a milestone badge whose reason no live rule awards is shown UNAVAILABLE, never as earnable.
  const { badgeTriggerEarnable } = await import("@/lib/gamification/award-points")

  // A refused read is not an empty catalog — say which read failed.
  if (catalogError) return { ok: false, badges: [], error: `Could not load the badge catalog: ${catalogError.message}` }
  if (earnedError) return { ok: false, badges: [], error: `Could not load this agent's awarded badges: ${earnedError.message}` }

  const earnedAtByBadge = new Map<string, string | null>(
    ((earnedRows ?? []) as Array<{ badge_id: string; awarded_at: string | null }>).map((r) => [r.badge_id, r.awarded_at]),
  )

  return {
    ok: true,
    badges: ((catalog ?? []) as any[]).map((b) => ({
      id: b.id,
      badgeId: b.id,
      name: b.badge_name,
      description: b.badge_description ?? null,
      icon: b.badge_icon ?? null,
      tier: b.badge_tier ?? null,
      category: b.badge_category ?? null,
      requiredPoints: Number(b.required_points) || 0,
      earned: earnedAtByBadge.has(b.id),
      earnedAt: earnedAtByBadge.get(b.id) ?? null,
      milestone: (b.trigger_event ?? "points_threshold") !== "points_threshold",
      available: badgeTriggerEarnable(b.trigger_event ?? null),
    })),
  }
}

// ─── GET AGENT POINTS AND TIER ────────────────────────────────────────────────
export async function getAgentPointsAndTier(agentId: string) {
  const supabase = await createClient()

  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, gamification_points, users:user_id(first_name, last_name)")
    .eq("id", agentId)
    .single()

  if (error) throw error

  const points = agent?.gamification_points || 0
  const next = nextTierForPoints(points)

  // FATIGUE-AWARE (wave 103, lane 103C): the rail stands down its "N pts to go"
  // pressure for an agent the retention radar has under strain. Read from the
  // radar's stored row (lib/gamification/strain.ts), never re-derived; an unknown
  // (refused read) is treated as NOT strained so a flaky read never hides a rung.
  const { isAgentUnderStrain } = await import("@/lib/gamification/strain")
  const underStrain = (await isAgentUnderStrain(supabase, agentId)) === true

  return {
    agentId: agent?.id,
    agentName: `${(agent?.users as any)?.first_name || ""} ${(agent?.users as any)?.last_name || ""}`.trim(),
    points,
    /** Canonical id — lowercase, the spelling gamification_badges.badge_tier enforces. */
    currentTierId: tierForPoints(points),
    /** What a person reads. */
    currentTier: tierLabelForPoints(points),
    nextTier: next?.label ?? null,
    pointsToNextTier: next?.pointsToGo ?? 0,
    progressPercent: tierProgressPercent(points),
    /** True when the Motivation rail should show support instead of a push. */
    underStrain,
  }
}

// ─── AWARD BADGE — module-private wrapper RETIRED (wave 153, lane 153I) ──────
// TOMBSTONE (CLAUDE.md §1): the private `awardBadge` that wrapped lib/gamification/lifecycle-awards.ts awardBadgeToAgent for
// the threshold loop stood here. The threshold loop itself moved to lifecycle-awards.ts awardThresholdBadges (which reads the
// stored total and calls awardBadgeToAgent — still the ONE agent_badges writer), so the wrapper had no caller left.
// It was never exported, deliberately: a badge-forging endpoint is what this file must not hold (wave 103 note, preserved in
// awardBadgeToAgent's header).

// ─── CHECK AND AWARD BADGES ───────────────────────────────────────────────────
/**
 * Threshold badges for an agent, against the total the DATABASE holds. WAVE 153 (lane 153I): `currentPoints` is RETAINED
 * AND IGNORED (house pattern — the caller keeps type-checking). This is a public endpoint, and it awarded against whatever
 * number it was handed, so any seat could hand its own agents.id and 999999 and take every rung. The award now delegates to
 * lib/gamification/lifecycle-awards.ts awardThresholdBadges, which reads agents.gamification_points itself (wave 154: the service
 * client, with the SESSION tenant handed down and enforced) — calling it can only award what the agent already earned.
 */
export async function checkAndAwardBadges(agentId: string, _currentPoints?: number) {
  // WAVE 154 (154E): m968 takes agent_badges writes away from session seats (the ALL policy let any seat insert or delete
  // any badge for anyone in its tenant), so the award runs on the SERVICE client — gated first: the tenant is the
  // SESSION's and awardThresholdBadges refuses an agent whose stored brokerage disagrees. It can still only award rungs
  // the stored total already reached.
  const { requireCaller } = await import("@/lib/auth/require-caller")
  const caller = await requireCaller()
  if (!caller.ok) return []
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { awardThresholdBadges } = await import("@/lib/gamification/lifecycle-awards")
  const res = await awardThresholdBadges(createServiceClient(), { agentId, brokerageId: caller.brokerageId })
  if (res.refused.length > 0) console.error(`[checkAndAwardBadges] ${agentId}: ${res.refused.join(" | ")}`)
  return res.awarded
}

// ─── ADMIN POINTS CORRECTION (wave 154, lane 154E) ────────────────────────────
/**
 * THE ONE CORRECTION DOOR — a tenant admin's audited adjustment on the SAME ledger, never a direct overwrite of
 * agents.gamification_points (m968 refuses that from any session). Public endpoint, so:
 *   · tenant from the SESSION; the target agent is read in that tenant only;
 *   · tenant admins (resolveTenantAdmin — user_type or a pinned grant) MINUS team_lead and compliance_officer by name
 *     (a lead adjusting their own team's standings, a compliance seat keeping a score: neither) — or platform staff;
 *   · never your own record; a reason of at least 10 characters; a whole, non-zero number that cannot take the total
 *     below zero;
 *   · `correctionId` (uuid, minted once per form) is the once-key: a double submit applies once;
 *   · evidence: the agent_points_log row (reason ADMIN_ADJUSTMENT, reference = correctionId) written by
 *     award_agent_points_once, plus an agent_action_ledger row (withActionLedger — who, why, what happened);
 *   · reconciliation: the stored total is re-read against SUM(agent_points_log.points) and reported.
 * Game points never touch commission or recruiting compensation; this door writes neither.
 */
export async function correctAgentPoints(input: {
  agentId: string
  points: number
  reason: string
  correctionId: string
}): Promise<{ ok: boolean; error?: string; alreadyApplied?: boolean; newTotal?: number; ledgerSum?: number; reconciled?: boolean }> {
  const { requireCaller } = await import("@/lib/auth/require-caller")
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, error: caller.error }

  const { isUuid } = await import("@/lib/gamification/award-points")
  const points = Math.trunc(Number(input.points))
  const reason = String(input.reason ?? "").trim()
  if (!isUuid(input.agentId)) return { ok: false, error: "Choose an agent to correct." }
  if (!isUuid(input.correctionId)) return { ok: false, error: "A correction id is required." }
  if (!Number.isFinite(points) || points === 0 || points !== Number(input.points)) return { ok: false, error: "A correction is a whole, non-zero number of points." }
  if (reason.length < 10) return { ok: false, error: "Say why (at least 10 characters) — the reason is kept on the audit record." }

  const gate = await pointsCorrectionGate(caller)
  if (!gate.ok) return { ok: false, error: gate.error }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: target, error: targetErr } = await svc.from("agents").select("id, user_id, gamification_points")
    .eq("id", input.agentId).eq("brokerage_id", caller.brokerageId).maybeSingle()
  if (targetErr) return { ok: false, error: `Could not read that agent: ${targetErr.message}` }
  if (!target) return { ok: false, error: "That agent is not in your brokerage." }
  if ((target as { user_id?: string | null }).user_id === caller.userId) return { ok: false, error: "You cannot correct your own points." }
  const before = Number((target as { gamification_points?: number | null }).gamification_points) || 0
  if (before + points < 0) return { ok: false, error: `That would take the total below zero (it is ${before}).` }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const { awardAgentPointsOnce } = await import("@/lib/gamification/award-points")
  type Out = { ok: boolean; error?: string; alreadyApplied?: boolean; newTotal?: number }
  const res: Out = await withActionLedger<Out>(
    {
      brokerageId: caller.brokerageId, action: "gamification.points.correct", actor: { type: "user", userId: caller.userId },
      subject: { type: "agent", id: input.agentId }, reasonCode: "HUMAN_REQUESTED", reasonDetail: reason,
      idempotencyKey: `gamification.points.correct:${input.correctionId}`, riskClass: "LOW_RISK_WRITE",
      systemSource: "motivation_admin_correction", detail: { points, total_before: before, correction_id: input.correctionId },
    },
    async () => {
      const awarded = await awardAgentPointsOnce(svc, {
        agentId: input.agentId, points, reason: "ADMIN_ADJUSTMENT", referenceType: "points_correction",
        referenceId: input.correctionId, once: { referenceId: input.correctionId },
      })
      if (!awarded.ok) return { ok: false, error: awarded.error }
      if ("alreadyAwarded" in awarded) return { ok: true, alreadyApplied: true }
      return { ok: true, newTotal: awarded.newTotal }
    },
    {
      settle: (r) => r.ok ? { status: "executed", outcome: r.alreadyApplied ? "already_applied" : "points_corrected" } : { status: "failed", outcome: "refused", error: r.error ?? null },
      // CLAIM-AWARE (wave 154, lane 154A3; test:action-evidence-census II.2): only an EXECUTED winner is "already applied".
      // A refused claim (the ledger could not record the at-most-once key) acted on nothing and says so; an in-flight or
      // unknown claim is neither applied nor safe to repeat blindly. The raw ledger error stays in the server log, never in
      // the sentence the admin reads.
      replay: (claim) => {
        if (claim.kind === "replay") return { ok: true, alreadyApplied: true }
        if (claim.kind === "refused") {
          console.error(`[correctAgentPoints] action ledger refused the claim for ${input.correctionId}: ${claim.error}`)
          return { ok: false, error: "The correction could not be recorded, so nothing was changed. Try again in a moment." }
        }
        if (claim.kind === "in_flight") return { ok: false, error: "This correction is already being applied — refresh in a moment to see it." }
        return { ok: false, error: "This correction was attempted and its result is not confirmed. Check the agent's points history before submitting it again." }
      },
    },
  )
  if (!res.ok) return res

  // THE BOARD FOLLOWS THE CORRECTION (wave 154, lane 154A3). The standings an agent compares against are
  // leaderboard_rankings, re-populated weekly by the recruit-outreach cron — so a correction used to sit on the ledger
  // while the board showed the old order for up to a week. The SAME populator (lib/recruiting/leaderboard.ts
  // runLeaderboardSnapshot, recruiting_manager's writer) re-snapshots this tenant's boards now. Best-effort: the points
  // already landed atomically; a refused snapshot is logged and the weekly cron is the recovery.
  if (!res.alreadyApplied) {
    try {
      const { runLeaderboardSnapshot } = await import("@/lib/recruiting/leaderboard")
      await runLeaderboardSnapshot(svc as any, { brokerageId: caller.brokerageId })
    } catch (e) {
      console.error(`[correctAgentPoints] leaderboard refresh after correction ${input.correctionId} failed (the weekly cron recovers it):`, (e as Error)?.message)
    }
  }

  const { data: after } = await svc.from("agents").select("gamification_points").eq("id", input.agentId).maybeSingle()
  const { data: rows, error: sumErr } = await svc.from("agent_points_log").select("points").eq("agent_id", input.agentId)
  const newTotal = Number((after as { gamification_points?: number | null } | null)?.gamification_points) || 0
  const ledgerSum = sumErr ? undefined : ((rows ?? []) as Array<{ points: number }>).reduce((s, r) => s + (Number(r.points) || 0), 0)
  return { ...res, newTotal, ledgerSum, reconciled: ledgerSum === undefined ? undefined : ledgerSum === newTotal }
}

/**
 * THE ONE GATE for the points-correction door (wave 154, lane 154A3 — extracted from correctAgentPoints so the screen
 * that offers the form and the action that applies it can never disagree). Platform staff, or a tenant admin
 * (resolveTenantAdmin) MINUS team_lead and compliance_officer by name. Not exported: a "use server" export is a public
 * endpoint (CLAUDE.md §4), and this is a helper.
 */
async function pointsCorrectionGate(caller: { userId: string; brokerageId: string; userType?: string | null; platformRole?: string | null; supabase: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  const { resolveTenantAdmin, isPlatformStaffIdentity } = await import("@/lib/auth/resolve-user-role")
  const userType = String(caller.userType ?? "").toLowerCase()
  if (isPlatformStaffIdentity(caller.userType ?? null, caller.platformRole ?? null)) return { ok: true }
  if (userType === "team_lead" || userType === "compliance_officer") return { ok: false, error: "Points corrections are made by a brokerage admin." }
  const admin = await resolveTenantAdmin(caller.supabase as any, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!admin.ok) return { ok: false, error: admin.error }
  if (!admin.isTenantAdmin) return { ok: false, error: "Points corrections are made by a brokerage admin." }
  return { ok: true }
}

/**
 * THE SCREEN ENTRY for the correction door (wave 154, lane 154A3). The Motivation page asks this once on the server; it
 * answers `{ allowed: false }` to anyone the gate refuses (the form is never rendered for them), and to an admin the
 * session tenant's agents — never the caller's own record — with their stored totals, so the form can only name an
 * agent the action will accept. Read-only; the tenant is the session's.
 */
export async function getPointsCorrectionRoster(): Promise<{ allowed: boolean; agents: Array<{ id: string; name: string; points: number }> }> {
  const { requireCaller } = await import("@/lib/auth/require-caller")
  const caller = await requireCaller()
  if (!caller.ok) return { allowed: false, agents: [] }
  const gate = await pointsCorrectionGate(caller)
  if (!gate.ok) return { allowed: false, agents: [] }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data, error } = await createServiceClient().from("agents").select("id, user_id, gamification_points, users:user_id(first_name, last_name)")
    .eq("brokerage_id", caller.brokerageId).limit(500)
  if (error) { console.error(`[getPointsCorrectionRoster] agent roster read refused: ${error.message}`); return { allowed: true, agents: [] } }
  type R = { id: string; user_id: string | null; gamification_points: number | null; users: { first_name: string | null; last_name: string | null } | null }
  const agents = ((data ?? []) as unknown as R[])
    .filter((a) => a.user_id !== caller.userId)
    .map((a) => ({ id: a.id, name: [a.users?.first_name, a.users?.last_name].filter(Boolean).join(" ") || "Unnamed agent", points: Number(a.gamification_points) || 0 }))
    .sort((x, y) => x.name.localeCompare(y.name))
  return { allowed: true, agents }
}

// ─── ADD POINTS — RETIRED (wave 153, lane 153I) ───────────────────────────────
// TOMBSTONE (CLAUDE.md §1). `export async function addPoints(agentId, pointType)` stood here. This file is "use server",
// so it was a PUBLIC endpoint: any signed-in seat could POST (its own agents.id, "FIRST_CLOSE") in a loop — m484's
// award_agent_points() admits an agent crediting ITSELF, and nothing asked whether the outcome happened. Every POINT_VALUES
// reason (LISTING_CLOSED, CAP_HIT, CERTIFICATION_EARNED…) was one click away, with no reference and no once-key, on the board
// the owner asked to be competitive ("credit from verified outcomes only"). Its one caller,
// app/lib/gamification/award-on-action.ts, is retired with it. SURVIVOR: lib/gamification/lifecycle-awards.ts
// awardLifecycleMilestones — called by lib/kernel/event-reactor.ts (L6) on the canonical event that PROVES the outcome, once
// per (agent, reason, reference | window) through lib/gamification/award-points.ts awardAgentPointsOnce. The threshold badge
// awarder (checkAndAwardBadges above) still runs against a total the database already holds.

// ─── RECENT POINT AWARDS ──────────────────────────────────────────────────────
/**
 * The agent's own ledger, newest first. The Motivation page had a "Points History"
 * panel reading `pointsData.pointsHistory` — a key nothing ever set, so the panel
 * has always said "Complete actions to start earning points!" no matter how many
 * points the agent had. This is the read that key was waiting for.
 */
export async function getAgentPointsHistory(
  agentId: string,
  limit = 8,
): Promise<{ ok: boolean; entries: Array<{ points: number; reason: string; createdAt: string }>; error?: string }> {
  if (!agentId) return { ok: true, entries: [] }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_points_log")
    .select("points, reason, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50))

  if (error) return { ok: false, entries: [], error: `Could not load your points history: ${error.message}` }

  return {
    ok: true,
    entries: ((data ?? []) as any[]).map((r) => ({
      points: Number(r.points) || 0,
      reason: (r.reason as string) || "Activity",
      createdAt: r.created_at as string,
    })),
  }
}

// ─── GET LEADERBOARD ──────────────────────────────────────────────────────────
/**
 * THE BOARD. Scope, metric and period are validated against the shared vocabulary
 * before they reach the query: an unknown value falls back to the default rather
 * than being handed to PostgREST, which is how "This Month" used to become a
 * silent zero-row filter.
 *
 * TEAM SCOPE IS THE VIEWER'S OWN TEAM (ruling #191). The caller does not name a
 * team; it is resolved from their agents row, so "team" cannot be used to read
 * another team's standings.
 */
export async function getLeaderboard(options: {
  scope?: string
  metricType?: string
  periodLabel?: string
  limit?: number
  offset?: number
}): Promise<{
  ok: boolean
  rankings: LeaderboardRow[]
  currentAgentId: string | null
  brokerageId: string
  scope: string
  metricType: string
  periodLabel: string
  error?: string
}> {
  const scope = isLeaderboardScope(options.scope) ? options.scope : "brokerage"
  const metricType = isLeaderboardMetric(options.metricType) ? options.metricType : "points"
  const periodLabel = isCanonicalPeriodLabel(options.periodLabel) ? (options.periodLabel as string) : defaultPeriodLabel()
  const blank = { rankings: [] as LeaderboardRow[], currentAgentId: null, brokerageId: "", scope, metricType, periodLabel }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, ...blank, error: "Not authenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, ...blank, error: `Could not resolve your brokerage: ${profileError.message}` }
  if (!profile?.brokerage_id) return { ok: false, ...blank, error: "Your account is not linked to a brokerage yet." }

  // The viewer's own agents row: highlights their line, and supplies the team.
  const { data: viewerAgent } = await supabase
    .from("agents")
    .select("id, team_id")
    .eq("user_id", user.id)
    .maybeSingle()
  const currentAgentId = viewerAgent?.id ?? null

  let query = supabase
    .from("leaderboard_rankings")
    .select(RANKING_SELECT)
    .eq("brokerage_id", profile.brokerage_id)
    .eq("scope", scope)
    .eq("metric_type", metricType)
    .eq("period_label", periodLabel)
    .order("rank_position", { ascending: true })

  // WAVE 154 (154E): a team lead anchors on teams.team_lead_id (a users.id — CLAUDE.md §4), not on agents.team_id. A lead
  // who is not also stamped as a member of their own team was told "you are not on a team". The led team comes from the
  // ONE resolver (lib/kernel/resolve-user-team.ts resolveLedTeamId), keyed on the SESSION user — never a requested team.
  let teamId: string | null = viewerAgent?.team_id ?? null
  if (scope === "team" && !teamId) {
    const { resolveLedTeamId } = await import("@/lib/kernel/resolve-user-team")
    const led = await resolveLedTeamId(supabase as any, user.id)
    if (!led.ok) return { ok: false, ...blank, brokerageId: profile.brokerage_id, currentAgentId, error: led.error }
    teamId = led.teamId
  }

  if (scope === "team") {
    if (!teamId) {
      return {
        ok: false,
        ...blank,
        brokerageId: profile.brokerage_id,
        currentAgentId,
        error: "You are not on a team yet, so there is no team board to show.",
      }
    }
    query = query.eq("team_id", teamId)
  }

  if (options.limit) query = query.limit(options.limit)
  if (options.offset) query = query.range(options.offset, options.offset + (options.limit || 20) - 1)

  const { data, error } = await query
  if (error) {
    return { ok: false, ...blank, brokerageId: profile.brokerage_id, currentAgentId, error: `Could not load the leaderboard: ${error.message}` }
  }

  return {
    ok: true,
    rankings: ((data ?? []) as any[]).map((r) => toLeaderboardRow(r, currentAgentId)),
    currentAgentId,
    brokerageId: profile.brokerage_id,
    scope,
    metricType,
    periodLabel,
  }
}

// ─── GET TOP 5 WIDGET ─────────────────────────────────────────────────────────
/**
 * The academy's "Your Ranking" card. It asked for scope 'agent' — a value the
 * populator has never written and the scope CHECK no longer admits — so it was
 * empty by construction. It asks for the BROKERAGE points board for the current
 * month, which is the board the full page opens on, and now also returns
 * `current_agent`, which the widget has always had markup for and never data.
 */
export async function getLeaderboardWidget(params: { agentId: string }) {
  const empty = { rankings: [] as any[], currentAgentId: null as string | null, current_agent: null as any }
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return empty

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, brokerage_id, gamification_points")
    .eq("id", params.agentId)
    .maybeSingle()
  if (agentError) {
    console.error(`[getLeaderboardWidget] agent read refused: ${agentError.message}`)
    return empty
  }
  if (!agent?.brokerage_id) return empty

  const periodLabel = monthLabel(new Date())

  const { data: rankings, error } = await supabase
    .from("leaderboard_rankings")
    .select(RANKING_SELECT)
    .eq("brokerage_id", agent.brokerage_id)
    .eq("scope", "brokerage")
    .eq("metric_type", "points")
    .eq("period_label", periodLabel)
    .order("rank_position", { ascending: true })
    .limit(5)

  if (error) {
    console.error(`[getLeaderboardWidget] leaderboard read refused: ${error.message}`)
    return empty
  }

  // The viewer's own line may be outside the top 5 — read it on its own so the
  // "you are #N" row can render.
  const { data: mine } = await supabase
    .from("leaderboard_rankings")
    .select("rank_position, metric_value")
    .eq("brokerage_id", agent.brokerage_id)
    .eq("scope", "brokerage")
    .eq("metric_type", "points")
    .eq("period_label", periodLabel)
    .eq("agent_id", params.agentId)
    .maybeSingle()

  const points = Number(agent.gamification_points) || 0

  return {
    rankings: rankings ?? [],
    currentAgentId: params.agentId,
    current_agent: mine
      ? { rank: Number(mine.rank_position) || 0, points: Number(mine.metric_value) || 0, tier: tierLabelForPoints(points) }
      : null,
  }
}
