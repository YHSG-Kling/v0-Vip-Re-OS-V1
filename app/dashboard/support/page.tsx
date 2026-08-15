// Platform SUPPORT console — read-only, gated to platform staff (superadmin OR
// support). Surfaces cross-brokerage vendor-spend health for triaging platform
// issues. Support staff get visibility but NOT platform configuration (the
// brokerage-warning toggle lives on the superadmin page).
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { getPlatformVendorSpendOverview } from "@/app/actions/vendor-budget"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

const LEVEL_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ok: { label: "OK", variant: "secondary" },
  approaching: { label: "Approaching", variant: "default" },
  paused: { label: "Paused", variant: "destructive" },
}

export default async function SupportConsolePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase.from("users").select("user_type").eq("id", user.id).maybeSingle()
  if (!isPlatformStaff(profile?.user_type)) {
    return <div className="p-6 text-red-600">Forbidden: platform staff access only</div>
  }

  const res = await getPlatformVendorSpendOverview()
  const rows = res.ok ? res.rows : []
  const atRisk = rows.filter((r) => r.level !== "ok").length

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Support — Platform Console</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Read-only cross-brokerage vendor-spend health for {profile?.user_type === "superadmin" ? "superadmin" : "support"} staff.
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
                  {rows.map((r) => {
                    const badge = LEVEL_BADGE[r.level] ?? LEVEL_BADGE.ok
                    return (
                      <tr key={r.brokerageId} className="border-b last:border-0">
                        <td className="py-2 pr-4">{r.name}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{r.planTier}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">${r.spent.toFixed(2)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">${r.budget.toFixed(0)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.percent}%</td>
                        <td className="py-2"><Badge variant={badge.variant}>{badge.label}</Badge></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
