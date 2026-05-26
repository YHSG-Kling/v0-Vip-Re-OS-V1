import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import {
  getConnectorAttentionFeedAction,
  getConnectorHealthSummaryAction,
} from "@/app/actions/superadmin/connector-health"
import { Activity, AlertTriangle, Clock, PlugZap } from "lucide-react"

export const dynamic = "force-dynamic"

function fmtAgo(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  expired: { label: "Expired", variant: "destructive" },
  auth_failed: { label: "Auth failed", variant: "destructive" },
  shape_drift: { label: "Shape drift", variant: "destructive" },
  expiring_soon: { label: "Expiring soon", variant: "secondary" },
  disconnected: { label: "Disconnected", variant: "outline" },
  connected: { label: "Connected", variant: "default" },
  platform_managed: { label: "Platform", variant: "outline" },
}

export default async function SuperadminConnectorsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()
  const allowed = profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)
  if (!allowed) {
    return <div className="p-6 text-red-600">Forbidden: platform staff access only</div>
  }

  const [feedRes, summaryRes] = await Promise.all([
    getConnectorAttentionFeedAction(150),
    getConnectorHealthSummaryAction(),
  ])
  const rows = feedRes.ok ? feedRes.rows : []
  const byStatus = summaryRes.ok ? summaryRes.byStatus : {}
  const lastRunAt = summaryRes.ok ? summaryRes.lastRunAt : null

  const count = (k: string) => byStatus[k] ?? 0
  const attentionTotal = count("expired") + count("auth_failed") + count("shape_drift") + count("expiring_soon")

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PlugZap className="h-6 w-6" /> Connector Connectivity
          </h1>
          <p className="text-sm text-muted-foreground">
            Live api / oauth / mcp connection health across all brokerages. Last scan {fmtAgo(lastRunAt)}.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Activity className="h-4 w-4" /> Connected</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{count("connected")}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4" /> Expiring soon</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-amber-600">{count("expiring_soon")}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Needs action</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-red-600">{count("expired") + count("auth_failed") + count("shape_drift")}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Platform-managed</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{count("platform_managed")}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attention feed ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {!feedRes.ok ? (
            <div className="text-sm text-red-600">Failed to load: {feedRes.error}</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {attentionTotal === 0 ? "All connectors healthy — nothing needs attention." : "No attention rows in the latest scan."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Brokerage</th>
                    <th className="py-2 pr-4">Connector</th>
                    <th className="py-2 pr-4">Transport</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">HTTP</th>
                    <th className="py-2 pr-4">Detail</th>
                    <th className="py-2 pr-4">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const style = STATUS_STYLE[r.status] ?? { label: r.status, variant: "outline" as const }
                    return (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2 pr-4">{r.brokerageName ?? r.brokerageId.slice(0, 8)}</td>
                        <td className="py-2 pr-4 font-medium">{r.provider}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{r.transport}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={style.variant}>{style.label}</Badge>
                          {r.drifted && <Badge variant="outline" className="ml-1">drift</Badge>}
                        </td>
                        <td className="py-2 pr-4">{r.httpStatus ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted-foreground max-w-xs truncate">{r.error ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{fmtAgo(r.checkedAt)}</td>
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
