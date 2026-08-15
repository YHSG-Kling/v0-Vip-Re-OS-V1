import { listStockAssets } from "@/app/actions/stock-library"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { StockLibraryClient } from "./client"

export const dynamic = "force-dynamic"

export default async function StockLibraryPage() {
  const [result, access] = await Promise.all([
    listStockAssets(),
    resolvePolicyScopeAccess(),
  ])
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Stock Library</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return (
    <StockLibraryClient
      assets={result.assets}
      access={{
        canEditAgent:     access.canEditAgent,
        canEditTeam:      access.canEditTeam,
        canEditBrokerage: access.canEditBrokerage,
        agentScopeId:     access.agentScopeId,
        teamScopeIds:     access.teamScopeIds,
        brokerageScopeId: access.brokerageScopeId,
      }}
    />
  )
}
