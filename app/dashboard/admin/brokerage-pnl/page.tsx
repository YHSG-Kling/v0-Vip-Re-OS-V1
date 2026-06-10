import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DollarSign, Building2, Users, TrendingUp, HandshakeIcon } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { generateBrokeragePnl } from "@/lib/intelligence/brokerage-pnl"

export const dynamic = "force-dynamic"

/**
 * BROKERAGE OWNER'S REPORT — the financials capstone. The number a brokerage OWNER
 * renews on: year-to-date GCI + company dollar, production by agent, recruiting ROI
 * (the Recruiting Manager's pipeline), and referral value (credited by the closing
 * loop). Every figure is a real SUM over the loops the audit made trustworthy.
 */
function usd(n: number): string { return `$${Math.round(n).toLocaleString()}` }

export default async function BrokeragePnlPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  // Owner-level surface — brokerage financials are not an agent view.
  if (!["broker", "broker_admin", "admin", "superadmin"].includes(profile.user_type ?? "")) {
    return <div className="p-6 text-red-600">Forbidden — owner/admin only</div>
  }

  const pnl = await generateBrokeragePnl({ brokerageId: profile.brokerage_id })
  const r = pnl.revenue
  const year = new Date(pnl.since).getFullYear()

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Building2 className="h-6 w-6 text-slate-700" /> Owner&apos;s Report — {year} YTD
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          The brokerage&apos;s economics, assembled from closed deals, recruiting ROI and referral value.
        </p>
      </div>

      {/* Revenue headline */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="py-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs"><DollarSign className="h-3.5 w-3.5" /> GCI (closed)</div>
          <div className="text-2xl font-semibold">{usd(r.gci)}</div>
          <div className="text-xs text-muted-foreground">{r.closings} closing{r.closings === 1 ? "" : "s"}</div>
        </CardContent></Card>
        <Card className="border-green-200 bg-green-50/40"><CardContent className="py-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs"><Building2 className="h-3.5 w-3.5" /> Company dollar</div>
          <div className="text-2xl font-semibold text-green-800">{usd(r.brokerageNet)}</div>
          <div className="text-xs text-muted-foreground">brokerage net</div>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs"><Users className="h-3.5 w-3.5" /> Agent payouts</div>
          <div className="text-2xl font-semibold">{usd(r.agentPayouts)}</div>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs"><TrendingUp className="h-3.5 w-3.5" /> Avg commission</div>
          <div className="text-2xl font-semibold">{usd(r.avgCommission)}</div>
        </CardContent></Card>
      </div>

      {/* Recruiting + referral economics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Recruiting economics</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Recruited agents</span><span className="font-medium">{pnl.recruiting.recruitedAgentCount}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total recruiting cost</span><span className="font-medium">{usd(pnl.recruiting.totalRecruitingCost)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Lifetime brokerage net</span><span className="font-medium">{usd(pnl.recruiting.lifetimeBrokerageNet)}</span></div>
            <div className="flex justify-between border-t pt-1 mt-1">
              <span className="text-muted-foreground">Blended ROI</span>
              <span className={"font-semibold " + ((pnl.recruiting.blendedRoiPct ?? 0) >= 0 ? "text-green-700" : "text-red-700")}>
                {pnl.recruiting.blendedRoiPct === null ? "—" : `${pnl.recruiting.blendedRoiPct}%`}
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><HandshakeIcon className="h-4 w-4" /> Referral economics</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Active partners</span><span className="font-medium">{pnl.referrals.activePartners}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Partner value generated</span><span className="font-medium">{usd(pnl.referrals.partnerValueGenerated)}</span></div>
            <p className="text-xs text-muted-foreground pt-2">Credited automatically by the referral closing loop as deals close.</p>
          </CardContent>
        </Card>
      </div>

      {/* Production by agent */}
      <Card>
        <CardHeader><CardTitle className="text-base">Production by agent</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {pnl.byAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No closed deals in this period yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3">Agent</th>
                  <th className="py-2 pr-3">Closings</th>
                  <th className="py-2 pr-3">GCI</th>
                </tr>
              </thead>
              <tbody>
                {pnl.byAgent.map((a, i) => (
                  <tr key={a.agentId} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <Badge className={i === 0 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}>{i === 0 && "★ "}{a.name}</Badge>
                    </td>
                    <td className="py-2 pr-3">{a.closings}</td>
                    <td className="py-2 pr-3 font-medium">{usd(a.gci)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
