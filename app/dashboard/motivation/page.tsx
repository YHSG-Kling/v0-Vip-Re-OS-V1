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

  // Validated against the known sets — an unknown value falls back to the
  // default rather than being handed to the action.
  const scope = (SCOPES as readonly string[]).includes(params.scope ?? "")
    ? (params.scope as (typeof SCOPES)[number]) : null
  const metric = (METRICS as readonly string[]).includes(params.metric ?? "")
    ? (params.metric as (typeof METRICS)[number]) : null
  const period = params.period?.trim() ? params.period.trim().slice(0, 40) : null

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
