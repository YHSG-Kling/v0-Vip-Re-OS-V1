import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getActivePatterns, getPatternAccuracyStats } from "@/app/actions/pattern-actions"
import { PatternsDashboardClient } from "./patterns-dashboard-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Behavioral Intelligence | Pipeline OS",
  description: "AI-detected patterns across your pipeline",
}

// The filter vocabulary getActivePatterns actually implements. A ?filter= value
// outside this set is ignored rather than silently returning an unfiltered list that
// looks like a filtered one — that mismatch is what made ?filter=agent read as "no
// agent patterns" when the truth was "this page never read the parameter at all".
const SUPPORTED_FILTERS = ["all", "buyer", "seller", "negotiation", "high_priority"] as const
type PatternFilter = (typeof SUPPORTED_FILTERS)[number]

export default async function PatternsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { brokerageId } = await getAgentContext()

  const { filter: rawFilter } = await searchParams
  const filter: PatternFilter = SUPPORTED_FILTERS.includes(rawFilter as PatternFilter)
    ? (rawFilter as PatternFilter)
    : "all"

  // Fetch initial data
  const [patterns, accuracyStats] = await Promise.all([
    getActivePatterns(filter),
    getPatternAccuracyStats(),
  ])

  return (
    <PatternsDashboardClient
      initialPatterns={patterns}
      initialAccuracyStats={accuracyStats}
      brokerageId={brokerageId ?? ""}
    />
  )
}
