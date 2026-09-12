// Platform SUPPORT console — read-only, gated to platform staff (superadmin OR
// support). Surfaces cross-brokerage vendor-spend health for triaging platform
// issues. Support staff get visibility but NOT platform configuration (the
// brokerage-warning toggle lives on the superadmin page).
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { redirect } from "next/navigation"
import { getPlatformVendorSpendOverview, getPlatformVendorBreakdown } from "@/app/actions/vendor-budget"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VendorBreakdownRow } from "./vendor-breakdown-row"

export const dynamic = "force-dynamic"

const LEVEL_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ok: { label: "OK", variant: "secondary" },
  approaching: { label: "Approaching", variant: "default" },
  paused: { label: "Paused", variant: "destructive" },
}

export default async function SupportConsolePage() {
  const gate = await requirePlatformCapability("support")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) {
    return <div className="p-6 text-red-600">Forbidden: platform staff access only</div>
  }

  const [res, breakdown] = await Promise.all([
    getPlatformVendorSpendOverview(),
    getPlatformVendorBreakdown(),
  ])
  const rows = res.ok ? res.rows : []
  const atRisk = rows.filter((r) => r.level !== "ok").length

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Support — Platform Console</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Read-only cross-brokerage vendor-spend health for {gate.role === "superadmin" ? "superadmin" : "support"} staff.
          {atRisk > 0 ? ` ${atRisk} brokerage(s) at or near their limit.` : " All brokerages within budget."}
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Vendor spend this month (per brokerage)</CardTitle></CardHeader>
        <CardContent>
          {!res.ok ? (
            <p className="text-sm text-red-600">Failed to load: {res.error}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No vendor spend recorded this month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Brokerage</th>
                    <th className="py-2 pr-4 font-medium">Plan</th>
                    <th className="py-2 pr-4 font-medium text-right">Spent</th>
                    <th className="py-2 pr-4 font-medium text-right">Budget</th>
                    <th className="py-2 pr-4 font-medium text-right">% used</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <VendorBreakdownRow
                      key={r.brokerageId}
                      row={r}
                      badge={LEVEL_BADGE[r.level] ?? LEVEL_BADGE.ok}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Vendor breakdown (this month)</CardTitle></CardHeader>
        <CardContent>
          {/* The reader usage_type / units_used / cost_per_unit / agent_id never
              had: WHAT was bought, HOW MUCH, at WHAT effective rate (recomputed
              from totals, so a mis-written per-row cost_per_unit shows up as a
              rate that disagrees with total/units instead of being laundered),
              and how many agents the spend attributes to. This is the review
              surface for the cost ledger (§5) — the per-brokerage table above
              says WHO is spending; this says ON WHAT. */}
          {!breakdown.ok ? (
            <p className="text-sm text-red-600">Failed to load: {breakdown.error}</p>
          ) : breakdown.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No vendor usage recorded this month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Vendor</th>
                    <th className="py-2 pr-4 font-medium">Usage type</th>
                    <th className="py-2 pr-4 font-medium text-right">Units</th>
                    <th className="py-2 pr-4 font-medium text-right">Avg $/unit</th>
                    <th className="py-2 pr-4 font-medium text-right">Total</th>
                    <th className="py-2 font-medium text-right">Agents attributed</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((v) => (
                    <tr key={`${v.vendorName}-${v.usageType}`} className="border-b last:border-0">
                      <td className="py-2 pr-4">{v.vendorName}</td>
                      <td className="py-2 pr-4">{v.usageType}</td>
                      <td className="py-2 pr-4 text-right">{v.units.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right">${v.avgCostPerUnit.toFixed(4)}</td>
                      <td className="py-2 pr-4 text-right">${v.totalCost.toFixed(2)}</td>
                      <td className="py-2 text-right">
                        {v.attributedAgents}
                        {v.unattributedRows > 0 ? (
                          <span className="text-muted-foreground"> · {v.unattributedRows} unattributed</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
