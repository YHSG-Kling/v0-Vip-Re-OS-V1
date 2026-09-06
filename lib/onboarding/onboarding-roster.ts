// lib/onboarding/onboarding-roster.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE onboarding roster. Two broker-facing surfaces read agent onboarding —
// the Onboarding Operations console (/dashboard/admin/onboarding) and the agent
// roster table (/dashboard/onboarding/admin/agents) — and they had drifted into
// two different answers to the same question.
//
// The console asked for `status === 'stalled'`. agent_onboarding.status has a
// CHECK constraint admitting exactly three values — in_progress, completed,
// paused — so 'stalled' can never be stored. Its "Stalled" metric card was
// permanently 0, and the Quick Actions panel's `stallCount > 0` branch (the
// "N Stalled Agents · Need intervention" button) could never render. The roster
// table had the honest definition all along: in_progress with no step completion
// in the last STALL_AFTER_DAYS days. That definition wins, and now there is only
// one copy of it.
//
// ID CLASSES, because this table mixes them:
//   agent_onboarding.agent_id        → agents(id)
//   agent_certifications.agent_id    → agents(id)
//   agent_step_completions.agent_id  → agents(id)
//   agent_onboarding.user_id         → users(id)   (nullable)
// The roster page looked its agent names up with `users.id IN (agents ids)`,
// which never matches — every row rendered "Unknown" with a blank email. Names
// are resolved through agents.user_id → users here instead.

/** An onboarding is stalled after this many days with no completed step. */
export const STALL_AFTER_DAYS = 7

export interface OnboardingRosterRow {
  /** agents.id — the PK every onboarding child table points at. */
  agentId: string
  /** users.id — null when the agent row has no linked user. Notifications need this. */
  userId: string | null
  agentName: string
  email: string
  /** agent_onboarding.status: in_progress | completed | paused. */
  status: string
  percentComplete: number
  currentDay: number
  certsEarned: number
  lastActivityAt: string | null
  daysSinceLastActivity: number | null
  isStalled: boolean
  daysSinceStart: number
}

export interface OnboardingRoster {
  agents: OnboardingRosterRow[]
  totalAgents: number
  inProgressCount: number
  completedCount: number
  /** DERIVED — never read from status, which cannot hold 'stalled'. */
  stalledCount: number
  completedThisMonth: number
  avgDaysToComplete: number
  avgCompletion: number
  certifiedAgents: number
}

const EMPTY: OnboardingRoster = {
  agents: [],
  totalAgents: 0,
  inProgressCount: 0,
  completedCount: 0,
  stalledCount: 0,
  completedThisMonth: 0,
  avgDaysToComplete: 0,
  avgCompletion: 0,
  certifiedAgents: 0,
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * PURE — the stall rule, exported so a guard can pin it without a database.
 * Only an in-progress onboarding can stall: a completed one is done and a paused
 * one was paused deliberately.
 */
export function isOnboardingStalled(
  status: string,
  lastActivityAt: string | null,
  now: Date,
  stallAfterDays: number = STALL_AFTER_DAYS,
): boolean {
  if (status !== "in_progress") return false
  if (!lastActivityAt) return true
  return new Date(lastActivityAt).getTime() < now.getTime() - stallAfterDays * DAY_MS
}

/** Accepts either the RLS-scoped server client or the service client. */
type AnyClient = { from: (table: string) => any }

export async function loadOnboardingRoster(
  db: AnyClient,
  brokerageId: string,
  now: Date = new Date(),
): Promise<OnboardingRoster> {
  const { data: onboardings } = await db
    .from("agent_onboarding")
    .select("id, agent_id, user_id, status, completion_percentage, current_day, start_date, certified_at, updated_at")
    .eq("brokerage_id", brokerageId)

  if (!onboardings || onboardings.length === 0) return EMPTY

  const agentIds: string[] = onboardings.map((o: any) => o.agent_id).filter(Boolean)

  // agents.id → users row. The name/email live on users; agent_onboarding.agent_id
  // is an agents.id, so the hop through agents.user_id is mandatory.
  const { data: agentRows } = await db
    .from("agents")
    .select("id, user_id")
    .in("id", agentIds)

  const userIdByAgentId = new Map<string, string>()
  for (const a of agentRows ?? []) {
    if (a.user_id) userIdByAgentId.set(a.id, a.user_id)
  }
  // agent_onboarding.user_id is a direct users FK — use it when the agents row has none.
  for (const o of onboardings as any[]) {
    if (o.user_id && !userIdByAgentId.has(o.agent_id)) userIdByAgentId.set(o.agent_id, o.user_id)
  }

  const userIds = [...new Set(userIdByAgentId.values())]
  const { data: users } = userIds.length
    ? await db.from("users").select("id, first_name, last_name, email").in("id", userIds)
    : { data: [] as any[] }
  const userMap = new Map<string, { first_name?: string | null; last_name?: string | null; email?: string | null }>(
    (users ?? []).map((u: any) => [u.id as string, u]),
  )

  const { data: certs } = await db
    .from("agent_certifications")
    .select("agent_id")
    .in("agent_id", agentIds)
    .eq("cert_type", "onboarding")

  const certCounts = new Map<string, number>()
  for (const c of certs ?? []) certCounts.set(c.agent_id, (certCounts.get(c.agent_id) ?? 0) + 1)

  const { data: completions } = await db
    .from("agent_step_completions")
    .select("agent_id, completed_at")
    .in("agent_id", agentIds)
    .eq("completed", true)
    .order("completed_at", { ascending: false })

  const latestActivity = new Map<string, string>()
  for (const c of completions ?? []) {
    if (!latestActivity.has(c.agent_id) && c.completed_at) latestActivity.set(c.agent_id, c.completed_at)
  }

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const agents: OnboardingRosterRow[] = (onboardings as any[]).map((o) => {
    const userId = userIdByAgentId.get(o.agent_id) ?? null
    const user = userId ? userMap.get(userId) : null
    const lastActivityAt = latestActivity.get(o.agent_id) ?? null
    const startDate = o.start_date ? new Date(o.start_date) : now

    return {
      agentId: o.agent_id,
      userId,
      agentName:
        [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim() || "Unknown",
      email: user?.email ?? "",
      status: o.status,
      percentComplete: o.completion_percentage ?? 0,
      currentDay: o.current_day ?? 1,
      certsEarned: certCounts.get(o.agent_id) ?? 0,
      lastActivityAt,
      daysSinceLastActivity: lastActivityAt
        ? Math.floor((now.getTime() - new Date(lastActivityAt).getTime()) / DAY_MS)
        : null,
      isStalled: isOnboardingStalled(o.status, lastActivityAt, now),
      daysSinceStart: Math.ceil((now.getTime() - startDate.getTime()) / DAY_MS),
    }
  })

  const completedOnboardings = (onboardings as any[]).filter(
    (o) => o.status === "completed" && o.start_date && o.certified_at,
  )

  return {
    agents: agents.sort((a, b) => {
      if (a.isStalled !== b.isStalled) return a.isStalled ? -1 : 1
      return b.percentComplete - a.percentComplete
    }),
    totalAgents: agents.length,
    inProgressCount: agents.filter((a) => a.status === "in_progress").length,
    completedCount: agents.filter((a) => a.status === "completed").length,
    stalledCount: agents.filter((a) => a.isStalled).length,
    completedThisMonth: (onboardings as any[]).filter(
      (o) => o.status === "completed" && o.certified_at && new Date(o.certified_at) >= startOfMonth,
    ).length,
    avgDaysToComplete: completedOnboardings.length
      ? Math.round(
          completedOnboardings.reduce(
            (sum, o) => sum + Math.ceil((new Date(o.certified_at!).getTime() - new Date(o.start_date!).getTime()) / DAY_MS),
            0,
          ) / completedOnboardings.length,
        )
      : 0,
    avgCompletion: agents.length
      ? Math.round(agents.reduce((s, a) => s + a.percentComplete, 0) / agents.length)
      : 0,
    certifiedAgents: agents.filter((a) => a.certsEarned > 0).length,
  }
}
