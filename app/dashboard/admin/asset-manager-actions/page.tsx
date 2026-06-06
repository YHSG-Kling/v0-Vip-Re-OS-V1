import { getPendingAssetManagerActions } from "@/app/actions/asset-manager-resolutions"
import { AssetManagerActionsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function AssetManagerActionsPage() {
  const result = await getPendingAssetManagerActions()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Asset Manager Actions</h1>
        <p className="text-red-600">{result.error ?? "Could not load actions"}</p>
      </div>
    )
  }
  return <AssetManagerActionsClient initialActions={result.actions ?? []} />
}
