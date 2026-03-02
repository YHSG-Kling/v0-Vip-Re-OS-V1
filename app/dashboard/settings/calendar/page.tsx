import { fetchMyProviderAccounts, syncFromProvider } from "@/app/actions/calendar/calendar-sync-actions"
import { createClient } from "@/lib/supabase/server"
import type { CalendarProviderAccountRow } from "@/lib/kernel"
import { CopyToClipboardButton } from "./CopyToClipboardButton"

export default async function CalendarSettingsPage() {
  let accounts: CalendarProviderAccountRow[] = []
  let iCalToken = ""

  try {
    const supabase = await createClient()
    accounts = await fetchMyProviderAccounts()

    // Get iCal token from global_settings
    const { data: settings } = await supabase
      .from("global_settings")
      .select("additional_settings")
      .limit(1)
      .single()

    const additionalSettings = settings?.additional_settings as Record<string, unknown> | null
    iCalToken = typeof additionalSettings?.ical_token === "string"
      ? additionalSettings.ical_token
      : "generate-token-link-here"
  } catch {
    return <div className="text-red-600">Failed to load calendar settings</div>
  }

  const iCalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/calendar/ical?token=${iCalToken}`

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Calendar Integrations</h1>
        <p className="text-gray-600 mt-2">Manage Google Calendar, Outlook, and iCalendar syncing</p>
      </div>

      {/* Connected Accounts */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Connected Accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-gray-500">No connected calendars</p>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="border border-gray-200 rounded p-4 flex justify-between items-start"
              >
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{account.provider_type}</p>
                  <p className="text-sm text-gray-600">{account.provider_account_id}</p>
                  {account.last_sync_at && (
                    <p className="text-xs text-gray-500">
                      Last synced: {new Date(account.last_sync_at).toLocaleString()}
                    </p>
                  )}
                  <div className="mt-2">
                    <span
                      className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        account.is_active
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {account.is_active ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 flex-col">
                  <form
                    action={async () => {
                      "use server"
                      await syncFromProvider(account.id)
                    }}
                  >
                    <button
                      type="submit"
                      className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-1 px-3 rounded"
                    >
                      Sync Now
                    </button>
                  </form>
                  <button className="bg-red-600 hover:bg-red-700 text-white text-sm font-medium py-1 px-3 rounded">
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* iCal Export */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-3">iCalendar Feed (Read-Only Export)</h3>
        <p className="text-sm text-blue-800 mb-3">
          Share your VIP OS calendar with external tools (Apple Calendar, Thunderbird, etc.)
        </p>
        <div className="bg-white rounded border border-blue-200 p-3">
          <p className="text-xs text-gray-600 mb-2">Feed URL:</p>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={iCalUrl}
              className="flex-1 border border-gray-300 rounded px-3 py-2 text-xs font-mono bg-gray-50"
            />
            <CopyToClipboardButton text={iCalUrl} />
          </div>
        </div>
      </div>

      {/* Sync Status */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Recent Sync Activity</h3>
        <p className="text-sm text-gray-600">Sync logs will appear here after the first sync</p>
      </div>
    </div>
  )
}
