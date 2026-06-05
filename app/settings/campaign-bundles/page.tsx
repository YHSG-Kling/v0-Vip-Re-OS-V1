import { listCampaignBundles, listAvailablePresets } from "@/app/actions/campaign-bundles"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { CampaignBundlesClient } from "./client"

export const dynamic = "force-dynamic"

export default async function CampaignBundlesPage() {
  const [bundlesR, catalogR, access] = await Promise.all([
    listCampaignBundles(),
    listAvailablePresets(),
    resolvePolicyScopeAccess(),
  ])
  if (!bundlesR.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Campaign Bundles</h1>
        <p className="text-red-600">{bundlesR.error}</p>
      </div>
    )
  }
  if (!catalogR.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Campaign Bundles</h1>
        <p className="text-red-600">{catalogR.error}</p>
      </div>
    )
  }
  return (
    <CampaignBundlesClient
      initialBundles={bundlesR.bundles}
      catalog={catalogR.catalog}
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
