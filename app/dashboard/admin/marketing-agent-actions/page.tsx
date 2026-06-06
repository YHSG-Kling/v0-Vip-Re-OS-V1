import { getPendingMarketingActions } from "@/app/actions/marketing-agent-resolutions"
import { MarketingAgentActionsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function MarketingAgentActionsPage() {
  const result = await getPendingMarketingActions()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Marketing Agent Actions</h1>
        <p className="text-red-600">{result.error ?? "Could not load actions"}</p>
      </div>
    )
  }
  return <MarketingAgentActionsClient initialActions={result.actions ?? []} />
}
