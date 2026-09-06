import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  isLeaderboardScope,
  isLeaderboardMetric,
  isCanonicalPeriodLabel,
  type LeaderboardScope,
  type LeaderboardMetric,
} from "@/lib/gamification/leaderboard-vocabulary"
import { MotivationClient } from "./motivation-client"

export const dynamic = "force-dynamic"

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
// URL-ADDRESSABLE FILTERS, so a filtered board is shareable as a link. The three
// params are validated against lib/gamification/leaderboard-vocabulary.ts — the
// SAME module the populator writes from — so a link can only ever name a board
// that exists. They used to be validated against a local SCOPES/METRICS pair that
// admitted 'agent' and 'revenue', neither of which has ever been written.
//
// The broker/team-lead nav keeps its "Leaderboard" label — the right word for that
// audience — and points here. /dashboard/leaderboard permanently redirects,
// preserving the params.
//
// ── THE ACHIEVEMENTS PANEL IS GONE, AND THAT IS THE MERGE, NOT A LOSS ────────
// It rendered the `achievements` catalog: a second reward ledger with the same
// points-threshold semantics as `gamification_badges`, a different award function,
// and zero live rows in either of its tables. m484 merges its one distinct idea
// (`category`) onto the badge catalog, migrates any rows, and drops the duplicate.
// Everything that panel showed — every rung, which are unlocked, how far the
// agent's points are from the next one — the Badges section of MotivationClient
// now shows from the surviving tables, which are the ones awards are actually
// written to.
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

  const scope: LeaderboardScope | null = isLeaderboardScope(params.scope) ? params.scope : null
  const metric: LeaderboardMetric | null = isLeaderboardMetric(params.metric) ? params.metric : null
  const period = isCanonicalPeriodLabel(params.period?.trim()) ? (params.period as string).trim() : null

  return (
    <MotivationClient
      agentId={agentId ?? ""}
      brokerageId={brokerageId ?? ""}
      userId={user.id}
      initialScope={scope}
      initialMetric={metric}
      initialPeriod={period}
    />
  )
}
