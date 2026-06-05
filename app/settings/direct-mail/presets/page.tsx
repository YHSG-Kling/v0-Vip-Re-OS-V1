import { listDirectMailPresets } from "@/app/actions/direct-mail-presets"
import { PresetsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function DirectMailPresetsPage() {
  const result = await listDirectMailPresets()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Saved Campaign Presets</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return <PresetsClient initialPresets={result.presets} />
}
