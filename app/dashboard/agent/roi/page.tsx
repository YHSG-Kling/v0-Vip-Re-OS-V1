import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadAgentRoiSnapshot } from "./actions"
import { AgentRoiClient } from "./roi-client"

export const metadata = {
  title: "Your AI ROI",
  description: "How much revenue your AI tools produced and how many hours they saved you.",
}

export default async function AgentRoiPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const sp = await searchParams
  const period: "7d" | "30d" | "ytd" =
    sp.period === "30d" || sp.period === "ytd" ? sp.period : "7d"

  const snapshot = await loadAgentRoiSnapshot(period)
  if ("error" in snapshot) redirect("/dashboard/onboarding")

  return <AgentRoiClient snapshot={snapshot} />
}
