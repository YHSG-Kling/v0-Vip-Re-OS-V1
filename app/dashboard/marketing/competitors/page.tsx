import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { CompetitorsClient } from "./competitors-client"

export default async function CompetitorsPage() {
  const supabase = await createClient()
  const { brokerageId, agentId } = await getAgentContext()

  // Pre-fetch tracked competitors
  const { data: competitors } = await supabase
    .from("competitors")
    .select("id, competitor_name, competitor_url, created_at")
    .eq("brokerage_id", brokerageId ?? "")
    .order("created_at", { ascending: false })
    .limit(50)

  // Resolve territory for market intelligence default
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("city, state, name")
    .eq("id", brokerageId ?? "")
    .maybeSingle()

  const territory =
    brokerage?.city && brokerage?.state
      ? `${brokerage.city}, ${brokerage.state}`
      : ""

  return (
    <CompetitorsClient
      initialCompetitors={competitors ?? []}
      agentId={agentId ?? ""}
      defaultMarketArea={territory}
    />
  )
}
