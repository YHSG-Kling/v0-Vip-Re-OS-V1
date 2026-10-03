import { permanentRedirect } from "next/navigation"

export const dynamic = "force-dynamic"

// ─────────────────────────────────────────────────────────────────────────────
// MERGED INTO /dashboard/motivation — see that page's header for the reasoning.
//
// Both surfaces rendered getLeaderboard + getAgentPointsAndTier + getAgentBadges.
// The split was by ROLE, not by purpose: agents got the rich board, brokers and
// team leads got this thinner one. The richer page is the keeper, and this
// page's one unique capability — scope/metric/period read from the URL, which
// makes a filtered board shareable — was ported into it first.
//
// Kept as a redirect rather than deleted: brokers and team leads have had this
// path in their nav, so it is in browser histories and bookmarks. The filter
// params ride across, so an existing link to a specific board still lands on
// that same board.
//
// TOMBSTONE (orphan tranche 3): the leftover leaderboard-client.tsx
// (LeaderboardClient) is deleted — this page stopped rendering it at the merge
// above and nothing else ever did. The survivor is
// app/dashboard/motivation/motivation-client.tsx:MotivationClient, the richer
// board this page's header already names as the keeper, which carries the
// ported initialScope/initialMetric/initialPeriod URL filters.
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; metric?: string; period?: string }>
}) {
  const params = await searchParams
  const keep = new URLSearchParams()
  if (params.scope) keep.set("scope", params.scope)
  if (params.metric) keep.set("metric", params.metric)
  if (params.period) keep.set("period", params.period)
  const qs = keep.toString()

  permanentRedirect(`/dashboard/motivation${qs ? `?${qs}` : ""}`)
}
