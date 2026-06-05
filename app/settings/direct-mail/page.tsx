import Link from "next/link"
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
    <div>
      <DirectMailSettingsClient
        initialConfig={result.config}
        initialWatchlist={result.watchlist}
      />
      <div className="max-w-4xl mx-auto px-6 pb-8 -mt-4">
        <div className="border-t border-gray-200 pt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">More direct-mail settings</h2>
          <ul className="space-y-2 text-sm">
            <li>
              <Link href="/settings/direct-mail/size-prefs" className="text-blue-600 hover:underline">
                Size preferences per persona × use kind →
              </Link>
              <span className="text-gray-500 ml-2">4×6 vs 6×9 per persona, with cascade through team/brokerage/platform defaults</span>
            </li>
            <li>
              <Link href="/settings/lifecycle-promos" className="text-blue-600 hover:underline">
                Listing lifecycle mail toggles →
              </Link>
              <span className="text-gray-500 ml-2">Enable just_sold / just_listed / open_house postcards per event</span>
            </li>
            <li>
              <Link href="/settings/direct-mail/variants" className="text-blue-600 hover:underline">
                Bandit catalog (A/B arms) →
              </Link>
              <span className="text-gray-500 ml-2">Deprecate platform arms or add your own (composition × copy_style) combos</span>
            </li>
            <li>
              <Link href="/settings/direct-mail/presets" className="text-blue-600 hover:underline">
                Saved campaign presets →
              </Link>
              <span className="text-gray-500 ml-2">Hand-tuned mailers that bypass the bandit (anniversary blasts, listing-launch flagship pieces)</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
