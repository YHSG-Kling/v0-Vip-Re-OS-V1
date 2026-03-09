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

export default async function PatternsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { brokerageId } = await getAgentContext()

  // Fetch initial data
  const [patterns, accuracyStats] = await Promise.all([
    getActivePatterns("all"),
    getPatternAccuracyStats(),
  ])

  return (
    <PatternsDashboardClient
      initialPatterns={patterns}
      initialAccuracyStats={accuracyStats}
      brokerageId={brokerageId}
    />
  )
}
