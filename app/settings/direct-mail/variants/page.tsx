import { getVariantCatalog } from "@/app/actions/direct-mail-variants-settings"
import { VariantCatalogClient } from "./client"

export const dynamic = "force-dynamic"

export default async function DirectMailVariantsPage() {
  const result = await getVariantCatalog()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Bandit Catalog</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return <VariantCatalogClient initialRows={result.rows} />
}
