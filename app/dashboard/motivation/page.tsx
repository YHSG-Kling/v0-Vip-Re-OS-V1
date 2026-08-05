import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { MotivationClient } from "./motivation-client"

export const dynamic = "force-dynamic"

const SCOPES = ["agent", "team", "brokerage"] as const
const METRICS = ["points", "revenue", "transactions", "referrals"] as const

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE STANDINGS + GAMIFICATION SURFACE. /dashboard/leaderboard merged here.
//
// There were two pages over the same three actions (getLeaderboard,
// getAgentPointsAndTier, getAgentBadges), split by ROLE rather than by purpose:
// an AGENT got "Motivation" (this page — points, tier, badges, and an
// interactive scope/metric/period board), while a BROKER and TEAM LEAD got
// "Leaderboard", a thinner page over the same data. The people with the most
// reason to study team standings were served the lesser view.
//
// Kept this one (strict superset) and ported the single thing the other had:
// URL-ADDRESSABLE FILTERS. /dashboard/leaderboard read scope/metric/period from
// searchParams, which made a filtered board shareable as a link; here they were
// local state only. Now seeded from the URL and still interactive, so both
// behaviours exist at once.
//
// Broker/team-lead nav keeps its "Leaderboard" label — the right word for that
// audience — and points here. /dashboard/leaderboard permanently redirects,
// preserving the params.
export default async function MotivationPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; metric?: string; period?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId } = await getAgentContext()

  // ── ACHIEVEMENTS ────────────────────────────────────────────────────────────
  // The `achievements` catalog and the `agent_achievements` ledger have been
  // written by awardPoints -> checkAndAwardAchievements since the gamification
  // rail existed, and no screen has ever shown either one. An agent could unlock
  // an achievement and never find out. The badges panel below is a DIFFERENT
  // table (agent_badges) with different rows — this is the points-threshold
  // ladder, and it is the only place it appears.
  const { getAchievements, getAgentAchievements } = await import("@/app/actions/agents")
  const [catalogResult, earned, pointsRow] = await Promise.all([
    getAchievements(),
    agentId ? getAgentAchievements(agentId) : Promise.resolve([]),
    agentId
      ? supabase.from("agents").select("gamification_points").eq("id", agentId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  const earnedIds = new Set(
    (earned as unknown as Array<{ achievement_id?: string }>)
      .map((r) => r.achievement_id)
      .filter(Boolean) as string[],
  )
  const currentPoints = Number(
    (pointsRow as unknown as { data: { gamification_points?: number } | null })?.data?.gamification_points ?? 0,
  )

  // Validated against the known sets — an unknown value falls back to the
  // default rather than being handed to the action.
  const scope = (SCOPES as readonly string[]).includes(params.scope ?? "")
    ? (params.scope as (typeof SCOPES)[number]) : null
  const metric = (METRICS as readonly string[]).includes(params.metric ?? "")
    ? (params.metric as (typeof METRICS)[number]) : null
  const period = params.period?.trim() ? params.period.trim().slice(0, 40) : null

  return (
    <div className="space-y-6">
      <MotivationClient
        agentId={agentId ?? ""}
        brokerageId={brokerageId ?? ""}
        userId={user.id}
        initialScope={scope}
        initialMetric={metric}
        initialPeriod={period}
      />

      <div className="p-6 pt-0">
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">Achievements</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Every rung on the ladder, and where {currentPoints.toLocaleString()} points puts you.
          </p>

          {!catalogResult.ok ? (
            // A refused read must not render as "there are no achievements".
            <p className="text-sm text-red-700 mt-4">
              Could not load the achievement ladder: {catalogResult.error}
            </p>
          ) : catalogResult.achievements.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-4">
              No achievements have been defined on this platform yet.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {catalogResult.achievements.map((a) => {
                const unlocked = earnedIds.has(a.id)
                const reachable = currentPoints >= a.points_required
                const pct =
                  a.points_required > 0
                    ? Math.min(Math.round((currentPoints / a.points_required) * 100), 100)
                    : 100
                return (
                  <div
                    key={a.id}
                    className={`rounded-md border p-3 ${
                      unlocked ? "border-emerald-300 bg-emerald-50" : "bg-muted/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-sm">{a.name}</p>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${
                          unlocked
                            ? "bg-emerald-600 text-white"
                            : reachable
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {unlocked ? "Unlocked" : reachable ? "Ready to award" : "Locked"}
                      </span>
                    </div>
                    {a.description && (
                      <p className="text-xs text-muted-foreground mt-1">{a.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      {a.points_required.toLocaleString()} points
                      {!unlocked && !reachable
                        ? ` — ${(a.points_required - currentPoints).toLocaleString()} to go`
                        : ""}
                    </p>
                    {!unlocked && (
                      <div className="w-full bg-muted rounded-full h-1.5 mt-1.5">
                        <div
                          className="bg-blue-500 h-1.5 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
