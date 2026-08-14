import { fetchAutomationErrors, fetchCalendarSyncLogs, fetchObservabilityDashboard } from "@/app/actions/observability/observability-actions"
import { createClient } from "@/lib/supabase/server"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import type { AutomationErrorRow, CalendarSyncLogRow } from "@/lib/kernel"

export default async function ObservabilityPage(
  { searchParams }: { searchParams: Promise<{ brokerageId?: string }> },
) {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) return <div className="text-red-600">Not authenticated</div>
  if (!gate.ok) {
    return <div className="text-red-600 p-6">Forbidden: superadmin access only</div>
  }

  const supabase = await createClient()

  // Get brokerages for filter
  const { data: brokerages } = await supabase.from("brokerages").select("id, name").order("name")

  // The filter is REAL: ?brokerageId=… (validated against the tenant list) wins;
  // otherwise fall back to the first brokerage. Previously the <select> was
  // decorative — no form, no handler — so staff could only ever see tenant #1.
  const params = await searchParams
  const requestedId = params.brokerageId ?? ""
  const selectedBrokerageId = brokerages?.some((b) => b.id === requestedId)
    ? requestedId
    : brokerages?.[0]?.id || ""

  let dashboard
  let automationErrors
  let syncLogs

  try {
    dashboard = await fetchObservabilityDashboard(selectedBrokerageId)
    automationErrors = await fetchAutomationErrors({ brokerageId: selectedBrokerageId, limit: 100 })
    syncLogs = await fetchCalendarSyncLogs({ brokerageId: selectedBrokerageId, limit: 50 })
  } catch (err) {
    // REPORT THE REASON. This catch used to discard it, which is how the
    // unsatisfiable `user_type === 'superadmin'` gate underneath stayed
    // invisible: staff passed the capability check above, the kernel threw
    // "Forbidden", and the page said only "Failed to load observability data".
    return (
      <div className="text-red-600 p-6">
        Failed to load observability data — {err instanceof Error ? err.message : String(err)}
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Observability Dashboard</h1>
        <p className="text-gray-600 mt-2">Monitor automation health and calendar sync status</p>
      </div>

      {/* Brokerage Filter — a real GET filter (server page re-renders scoped to the choice) */}
      <div className="bg-white rounded-lg shadow p-4">
        <form method="get" className="flex items-end gap-3">
          <div className="flex-1">
            <label htmlFor="brokerageId" className="block text-sm font-medium text-gray-700 mb-2">Brokerage</label>
            <select
              id="brokerageId"
              name="brokerageId"
              defaultValue={selectedBrokerageId}
              className="border border-gray-300 rounded px-3 py-2 text-sm w-full"
            >
              {brokerages?.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="border border-gray-300 rounded px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Apply
          </button>
        </form>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Open Errors</p>
          <p className="text-3xl font-bold text-red-600">{dashboard?.automationErrorCount || 0}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Critical Issues</p>
          <p className="text-3xl font-bold text-orange-600">{dashboard?.automationErrorsCritical || 0}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Sync Failures (7d)</p>
          <p className="text-3xl font-bold text-yellow-600">{dashboard?.calendarSyncFailures || 0}</p>
        </div>
      </div>

      {/* Automation Errors Table */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Automation Errors</h2>
        {automationErrors?.rows && automationErrors.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Workflow</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Message</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Severity</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Status</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Created</th>
                </tr>
              </thead>
              <tbody>
                {automationErrors.rows.map((error: AutomationErrorRow) => (
                  <tr key={error.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 px-4 font-medium text-gray-900">{error.workflow_name}</td>
                    <td className="py-2 px-4 text-gray-600 truncate">{error.error_message || "—"}</td>
                    <td className="py-2 px-4">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        error.severity === "critical" ? "bg-red-100 text-red-800" :
                        error.severity === "high" ? "bg-orange-100 text-orange-800" :
                        error.severity === "medium" ? "bg-yellow-100 text-yellow-800" :
                        "bg-gray-100 text-gray-800"
                      }`}>
                        {error.severity || "—"}
                      </span>
                    </td>
                    <td className="py-2 px-4">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        error.status === "resolved" ? "bg-green-100 text-green-800" :
                        error.status === "investigating" ? "bg-blue-100 text-blue-800" :
                        "bg-red-100 text-red-800"
                      }`}>
                        {error.status}
                      </span>
                    </td>
                    <td className="py-2 px-4 text-gray-600">{new Date(error.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500">No errors in this period</p>
        )}
      </div>

      {/* Calendar Sync Logs Table */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Calendar Sync Logs</h2>
        {syncLogs && syncLogs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Direction</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Events</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Status</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Error</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-700">Completed</th>
                </tr>
              </thead>
              <tbody>
                {syncLogs.map((log: CalendarSyncLogRow) => (
                  <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 px-4 font-medium text-gray-900">{log.direction}</td>
                    <td className="py-2 px-4 text-gray-600">{log.event_count || "—"}</td>
                    <td className="py-2 px-4">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        log.status === "success" ? "bg-green-100 text-green-800" :
                        log.status === "partial" ? "bg-yellow-100 text-yellow-800" :
                        "bg-red-100 text-red-800"
                      }`}>
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2 px-4 text-gray-600 truncate text-xs">{log.error_message || "—"}</td>
                    <td className="py-2 px-4 text-gray-600">{log.completed_at ? new Date(log.completed_at).toLocaleString() : "In progress"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500">No sync logs</p>
        )}
      </div>
    </div>
  )
}
