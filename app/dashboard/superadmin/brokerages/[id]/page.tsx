import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Building2, ArrowLeft, Users, Clock } from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getBrokerageDetailAction } from "@/app/actions/superadmin/brokerage-management"
import { BrokerageActions } from "./brokerage-actions"
import { TenantUsersPanel } from "./tenant-users-panel"

export const dynamic = "force-dynamic"

function statusBadge(s: string | null | undefined) {
  switch (s) {
    case "active":    return <Badge className="bg-emerald-100 text-emerald-800">Active</Badge>
    case "suspended": return <Badge className="bg-amber-100 text-amber-800">Suspended</Badge>
    case "cancelled": return <Badge className="bg-red-100 text-red-800">Cancelled</Badge>
    case "archived":  return <Badge className="bg-slate-100 text-slate-600">Archived</Badge>
    default:          return <Badge variant="outline">{s ?? "—"}</Badge>
  }
}

export default async function SuperadminBrokerageDetailPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: profile } = await supabase.from("users").select("user_type").eq("id", user.id).maybeSingle()
  if (profile?.user_type !== "superadmin") {
    return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>
  }

  const { id } = await params
  const r = await getBrokerageDetailAction(id)
  if (!r.ok) return <div className="p-6 text-red-600">Failed: {r.error}</div>

  const { brokerage, users, subscriptions, auditEntries } = r

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <Link href="/dashboard/superadmin/brokerages" className="text-xs text-muted-foreground hover:underline flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> All brokerages
        </Link>
        <div className="flex items-end justify-between flex-wrap gap-3 mt-2">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              {brokerage.name ?? "(unnamed)"}
            </h1>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              {brokerage.city && brokerage.state ? `${brokerage.city}, ${brokerage.state}` : "Location not set"} ·
              created {new Date(brokerage.created_at).toLocaleDateString()} ·
              source <span className="font-medium">{brokerage.signup_source}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {statusBadge(brokerage.status)}
            <Badge variant="outline">{brokerage.plan_tier}</Badge>
          </div>
        </div>
      </div>

      {/* Admin actions card */}
      <BrokerageActions brokerage={brokerage} />

      {/* Team members — actionable cross-tenant user management */}
      <TenantUsersPanel brokerageId={brokerage.id} />

      {/* Subscriptions history */}
      {subscriptions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Subscriptions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Period start</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Period end</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s: any) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5"><Badge variant="outline" className="text-xs">{s.status}</Badge></td>
                      <td className="px-4 py-2.5 text-xs">{new Date(s.current_period_start).toLocaleDateString()}</td>
                      <td className="px-4 py-2.5 text-xs">{new Date(s.current_period_end).toLocaleDateString()}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Audit log */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Audit trail
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {auditEntries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No superadmin actions logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Action</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Actor</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Details</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">When</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((a: any) => (
                    <tr key={a.id} className="border-b last:border-0 align-top">
                      <td className="px-4 py-2.5 font-mono text-xs">{a.action}</td>
                      <td className="px-4 py-2.5 text-xs">{a.actor_email ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[10px] text-muted-foreground font-mono whitespace-pre-wrap max-w-xs truncate">
                        {JSON.stringify(a.details)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</td>
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
