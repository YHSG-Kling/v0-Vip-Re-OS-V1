import { getDirectMailSettings } from "@/app/actions/direct-mail-settings"
import { DirectMailSettingsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function DirectMailSettingsPage() {
  const result = await getDirectMailSettings()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Direct Mail Settings</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return (
    <DirectMailSettingsClient
      initialConfig={result.config}
      initialWatchlist={result.watchlist}
    />
  )
}
